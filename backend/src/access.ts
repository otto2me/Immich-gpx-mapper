import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { clearUserSessions, getSession, type AuthUser } from "./auth.js";
import { encryptSecret, hashPassword, verifyPassword } from "./crypto.js";
import { readSettings } from "./settings.js";

type AlbumRow = {
  immich_album_id: string;
  owner_id: string;
  visibility: "private" | "shared" | "public";
  metadata_json: string;
};

function notFound(): never {
  throw Object.assign(new Error("Album nicht gefunden"), { statusCode: 404 });
}

function forbidden(): never {
  throw Object.assign(new Error("Keine Berechtigung"), { statusCode: 403 });
}

export function albumRow(database: DatabaseSync, albumId: string) {
  return database.prepare("SELECT * FROM albums WHERE immich_album_id = ?").get(albumId) as AlbumRow | undefined;
}

export function ensureAlbum(database: DatabaseSync, albumId: string, ownerId: string, metadata?: unknown) {
  const json = metadata === undefined ? "{}" : JSON.stringify(metadata);
  database.prepare(`INSERT INTO albums(immich_album_id, owner_id, visibility, metadata_json)
    VALUES(?, ?, 'private', ?) ON CONFLICT(immich_album_id) DO UPDATE SET
    metadata_json = CASE WHEN excluded.metadata_json = '{}' THEN albums.metadata_json ELSE excluded.metadata_json END`)
    .run(albumId, ownerId, json);
}

export function canReadAlbum(database: DatabaseSync, user: AuthUser | undefined, albumId: string, reportId?: string) {
  const album = albumRow(database, albumId);
  if (!album) return false;
  if (reportId) {
    const report = database.prepare("SELECT is_private FROM reports WHERE id = ? AND immich_album_id = ?")
      .get(reportId, albumId) as { is_private: number } | undefined;
    if (!report) return false;
    if (report.is_private && (!user || album.owner_id !== user.id)) return false;
  }
  if (album.visibility === "public") return true;
  if (!user) return false;
  if (album.owner_id === user.id) return true;
  if (album.visibility !== "shared") return false;
  return Boolean(database.prepare(`SELECT 1 FROM album_grants
    WHERE immich_album_id = ? AND user_id = ?`).get(albumId, user.id));
}

export function requireAlbumRead(database: DatabaseSync, request: FastifyRequest, albumId: string, reportId?: string) {
  const user = getSession(request);
  if (!canReadAlbum(database, user, albumId, reportId)) notFound();
  return { album: albumRow(database, albumId)!, user };
}

export function requireAlbumOwner(database: DatabaseSync, request: FastifyRequest, albumId: string) {
  const user = getSession(request);
  const album = albumRow(database, albumId);
  if (!user || !album || album.owner_id !== user.id) notFound();
  return { album, user };
}

export function resolveReportShare(database: DatabaseSync, token: string) {
  if (!readSettings(database).sharingEnabled) return undefined;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const hash = createHash("sha256").update(token).digest("hex");
  const row = database.prepare(`SELECT reports.id AS reportId, reports.immich_album_id AS albumId,
    reports.chapters_json AS chaptersJson FROM report_shares
    JOIN reports ON reports.id = report_shares.report_id
    WHERE report_shares.token_hash = ? AND report_shares.revoked_at IS NULL
      AND (report_shares.expires_at IS NULL OR report_shares.expires_at > ?)`)
    .get(hash, new Date().toISOString()) as
    { reportId: string; albumId: string; chaptersJson: string } | undefined;
  if (!row) return undefined;
  const chapters = JSON.parse(row.chaptersJson) as Array<{ tourId?: string | null; photos?: Array<{ assetId: string }> }>;
  return {
    ...row,
    assetIds: new Set(chapters.flatMap((chapter) => chapter.photos?.map((photo) => photo.assetId) ?? [])),
    tourIds: new Set(chapters.map((chapter) => chapter.tourId).filter((id): id is string => Boolean(id)))
  };
}

export function reportShareFromRequest(database: DatabaseSync, request: FastifyRequest) {
  const token = request.headers.cookie?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("mapper_report_share="))
    ?.slice("mapper_report_share=".length);
  return token ? resolveReportShare(database, token) : undefined;
}

export function requireAdmin(database: DatabaseSync, request: FastifyRequest, reply: FastifyReply) {
  const user = getSession(request);
  if (!user) return reply.code(401).send({ message: "Anmeldung erforderlich" });
  const account = database.prepare("SELECT role FROM users WHERE id = ?").get(user.id) as { role: string } | undefined;
  if (!account) return reply.code(401).send({ message: "Anmeldung erforderlich" });
  if (account.role !== "admin") return reply.code(403).send({ message: "Administratorrechte erforderlich" });
}

export function registerAccessRoutes(app: FastifyInstance, database: DatabaseSync, encryptionKey: Buffer) {
  const adminOnly = async (request: FastifyRequest, reply: FastifyReply) => requireAdmin(database, request, reply);
  app.get("/api/users/selectable", async (request, reply) => {
    if (!getSession(request)) return reply.code(401).send({ message: "Anmeldung erforderlich" });
    return database.prepare("SELECT id, username FROM users ORDER BY username COLLATE NOCASE").all();
  });
  app.get("/api/users", { preHandler: adminOnly }, async () => database.prepare(
    "SELECT id, username, role, created_at AS createdAt, immich_api_key IS NOT NULL AS immichApiKeyConfigured FROM users ORDER BY username COLLATE NOCASE"
  ).all().map((row) => {
    const account = row as { immichApiKeyConfigured: number };
    return { ...account, immichApiKeyConfigured: Boolean(account.immichApiKeyConfigured) };
  }));

  app.post<{ Body: { username?: unknown; password?: unknown; role?: unknown } }>(
    "/api/users", { preHandler: adminOnly },
    async (request, reply) => {
      const username = request.body?.username;
      const password = request.body?.password;
      const role = request.body?.role ?? "user";
      if (typeof username !== "string" || !/^[a-zA-Z0-9._-]{1,50}$/.test(username) ||
          typeof password !== "string" || password.length < 12 || password.length > 1024 ||
          role !== "admin" && role !== "user") {
        return reply.code(400).send({ message: "Benutzername, Passwort oder Rolle ist ungültig" });
      }
      const user = getSession(request)!;
      try {
        database.prepare(`INSERT INTO users(id, username, password_hash, role, created_at)
          VALUES(?, ?, ?, ?, ?)`).run(randomUUID(), username, hashPassword(password), role, new Date().toISOString());
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
          return reply.code(409).send({ message: "Dieser Benutzername ist bereits vergeben" });
        }
        throw error;
      }
      reply.code(201);
      return { created: true, by: user.id };
    }
  );

  app.put<{ Params: { userId: string }; Body: { password?: unknown; role?: unknown } }>(
    "/api/users/:userId", { preHandler: adminOnly },
    async (request, reply) => {
      const input = request.body ?? {};
      if (input.password === undefined && input.role === undefined) {
        return reply.code(400).send({ message: "Keine Kontoänderung angegeben" });
      }
      if (input.password !== undefined &&
          (typeof input.password !== "string" || input.password.length < 12 || input.password.length > 1024)) {
        return reply.code(400).send({ message: "Passwort muss 12-1024 Zeichen lang sein" });
      }
      if (input.role !== undefined && input.role !== "admin" && input.role !== "user") {
        return reply.code(400).send({ message: "Ungültige Rolle" });
      }
      const target = database.prepare("SELECT role FROM users WHERE id = ?").get(request.params.userId) as { role: string } | undefined;
      if (!target) return reply.code(404).send({ message: "Konto nicht gefunden" });
      if (target.role === "admin" && input.role === "user") {
        const admins = database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get() as { count: number };
        if (admins.count <= 1) return reply.code(409).send({ message: "Der letzte Administrator kann nicht herabgestuft werden" });
      }
      const assignments: string[] = [];
      const values: string[] = [];
      if (typeof input.password === "string") {
        assignments.push("password_hash = ?");
        values.push(hashPassword(input.password));
      }
      if (input.role === "user" || input.role === "admin") {
        assignments.push("role = ?");
        values.push(input.role);
      }
      values.push(request.params.userId);
      database.prepare(`UPDATE users SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
      if (input.role !== undefined || input.password !== undefined) clearUserSessions(request.params.userId);
      return { updated: true };
    }
  );

  app.delete<{ Params: { userId: string } }>("/api/users/:userId", { preHandler: adminOnly }, async (request, reply) => {
    const target = database.prepare("SELECT role FROM users WHERE id = ?").get(request.params.userId) as { role: string } | undefined;
    if (!target) return reply.code(404).send({ message: "Konto nicht gefunden" });
    if (target.role === "admin") {
      const admins = database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get() as { count: number };
      if (admins.count <= 1) return reply.code(409).send({ message: "Der letzte Administrator kann nicht gelöscht werden" });
    }
    if (getSession(request)?.id === request.params.userId) return reply.code(409).send({ message: "Das eigene Konto kann hier nicht gelöscht werden" });
    const ownedAlbums = database.prepare("SELECT COUNT(*) AS count FROM albums WHERE owner_id = ?").get(request.params.userId) as { count: number };
    if (ownedAlbums.count) return reply.code(409).send({ message: "Konto kann erst gelöscht werden, wenn seine Alben übertragen oder gelöscht wurden" });
    database.prepare("DELETE FROM users WHERE id = ?").run(request.params.userId);
    clearUserSessions(request.params.userId);
    return { deleted: true };
  });

  app.get("/api/user/settings", async (request, reply) => {
    const user = getSession(request);
    if (!user) return reply.code(401).send({ message: "Anmeldung erforderlich" });
    const row = database.prepare("SELECT immich_api_key FROM users WHERE id = ?").get(user.id) as { immich_api_key: string | null };
    return { immichApiKeyConfigured: row.immich_api_key !== null };
  });

  app.put<{ Body: { immichApiKey?: unknown; currentPassword?: unknown; newPassword?: unknown } }>(
    "/api/user/settings", async (request, reply) => {
      const user = getSession(request);
      if (!user) return reply.code(401).send({ message: "Anmeldung erforderlich" });
      const input = request.body ?? {};
      const key = input.immichApiKey;
      if (key !== undefined && (typeof key !== "string" || key.length > 4096 || key.trim() !== key)) {
        return reply.code(400).send({ message: "Immich-API-Key ist ungültig" });
      }
      if (input.newPassword !== undefined) {
        if (typeof input.currentPassword !== "string" ||
            typeof input.newPassword !== "string" || input.newPassword.length < 12 || input.newPassword.length > 1024) {
          return reply.code(400).send({ message: "Aktuelles oder neues Passwort ist ungültig" });
        }
        const account = database.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id) as { password_hash: string };
        if (!verifyPassword(input.currentPassword, account.password_hash)) {
          return reply.code(403).send({ message: "Aktuelles Passwort ist falsch" });
        }
        database.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(input.newPassword), user.id);
      } else if (input.currentPassword !== undefined) {
        return reply.code(400).send({ message: "Neues Passwort fehlt" });
      }
      if (typeof key === "string") {
        database.prepare("UPDATE users SET immich_api_key = ? WHERE id = ?")
          .run(key ? encryptSecret(key, encryptionKey) : null, user.id);
      }
      const configured = database.prepare("SELECT immich_api_key FROM users WHERE id = ?").get(user.id) as { immich_api_key: string | null };
      return { immichApiKeyConfigured: configured.immich_api_key !== null };
    }
  );

  app.get("/api/admin/albums", { preHandler: adminOnly }, async () => database.prepare(`SELECT
    albums.immich_album_id AS id, albums.owner_id AS ownerId, users.username AS ownerName,
    users.immich_api_key IS NOT NULL AS ownerHasImmichKey,
    albums.visibility, albums.metadata_json AS metadataJson
    FROM albums JOIN users ON users.id = albums.owner_id ORDER BY users.username, albums.immich_album_id`).all()
    .map((row) => {
      const album = row as { metadataJson: string; ownerHasImmichKey: number };
      const { metadataJson, ...rest } = album;
      return { ...rest, ownerHasImmichKey: Boolean(album.ownerHasImmichKey), metadata: JSON.parse(metadataJson) };
    }));

  app.put<{ Params: { albumId: string }; Body: { ownerUserId?: unknown } }>(
    "/api/admin/albums/:albumId/owner", { preHandler: adminOnly },
    async (request, reply) => {
      const ownerUserId = request.body?.ownerUserId;
      if (typeof ownerUserId !== "string" || !ownerUserId) {
        return reply.code(400).send({ message: "Neuer Album-Eigentümer fehlt" });
      }
      const album = albumRow(database, request.params.albumId);
      if (!album) return reply.code(404).send({ message: "Album nicht gefunden" });
      const target = database.prepare("SELECT immich_api_key FROM users WHERE id = ?").get(ownerUserId) as
        { immich_api_key: string | null } | undefined;
      if (!target) return reply.code(404).send({ message: "Mapper-Konto nicht gefunden" });
      if (!target.immich_api_key) {
        return reply.code(409).send({ message: "Das Zielkonto muss zuerst einen persönlichen Immich-API-Key hinterlegen" });
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare("UPDATE albums SET owner_id = ? WHERE immich_album_id = ?")
          .run(ownerUserId, request.params.albumId);
        database.prepare("DELETE FROM album_grants WHERE immich_album_id = ? AND user_id = ?")
          .run(request.params.albumId, ownerUserId);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return { transferred: true, ownerUserId };
    }
  );

  app.put<{ Params: { albumId: string }; Body: { visibility?: unknown; userIds?: unknown; publicConfirmed?: unknown } }>(
    "/api/albums/:albumId/access", async (request, reply) => {
      const { album } = requireAlbumOwner(database, request, request.params.albumId);
      const visibility = request.body?.visibility;
      const userIds = request.body?.userIds;
      if (visibility !== undefined && visibility !== "private" && visibility !== "shared" && visibility !== "public") {
        return reply.code(400).send({ message: "Ungültige Album-Sichtbarkeit" });
      }
      if (userIds !== undefined && (!Array.isArray(userIds) || userIds.length > 500 ||
          userIds.some((id) => typeof id !== "string" || id === album.owner_id))) {
        return reply.code(400).send({ message: "Ungültige Benutzerfreigabe" });
      }
      const visibilityValue: AlbumRow["visibility"] = visibility ?? album.visibility;
      if (visibilityValue === "public" && request.body?.publicConfirmed !== true) {
        return reply.code(400).send({ message: "Öffentliche Albumfreigabe muss ausdrücklich bestätigt werden" });
      }
      if (visibilityValue === "public" &&
          !(database.prepare("SELECT immich_api_key FROM users WHERE id = ?").get(album.owner_id) as { immich_api_key: string | null }).immich_api_key) {
        return reply.code(409).send({ message: "Vor dem Veröffentlichen muss ein persönlicher Immich-API-Key gespeichert sein" });
      }
      const grantIds = userIds as string[] | undefined;
      const currentGrantCount = (database.prepare("SELECT COUNT(*) AS count FROM album_grants WHERE immich_album_id = ?")
        .get(request.params.albumId) as { count: number }).count;
      if (visibilityValue === "shared" && (grantIds ? !grantIds.length : currentGrantCount === 0)) {
        return reply.code(400).send({ message: "Für eine Benutzerfreigabe mindestens ein Konto auswählen" });
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        if (visibility !== undefined) {
          database.prepare("UPDATE albums SET visibility = ? WHERE immich_album_id = ?")
            .run(visibility, request.params.albumId);
        }
        if (grantIds) {
          const validUsers = new Set((database.prepare("SELECT id FROM users WHERE id != ?").all(album.owner_id) as Array<{ id: string }>).map((row) => row.id));
          if (grantIds.some((id) => !validUsers.has(id))) {
            database.exec("ROLLBACK");
            return reply.code(400).send({ message: "Freigabe enthält ein unbekanntes Konto" });
          }
          database.prepare("DELETE FROM album_grants WHERE immich_album_id = ?").run(request.params.albumId);
          const add = database.prepare("INSERT INTO album_grants(immich_album_id, user_id, created_at) VALUES(?, ?, ?)");
          for (const id of new Set(grantIds)) add.run(request.params.albumId, id, new Date().toISOString());
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return { updated: true };
    }
  );

  app.get<{ Params: { albumId: string } }>("/api/albums/:albumId/access", async (request, reply) => {
    requireAlbumOwner(database, request, request.params.albumId);
    const album = albumRow(database, request.params.albumId)!;
    const userIds = database.prepare("SELECT user_id AS id FROM album_grants WHERE immich_album_id = ?")
      .all(request.params.albumId) as Array<{ id: string }>;
    return { visibility: album.visibility, userIds: userIds.map((row) => row.id) };
  });
}
