import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isAuthenticated } from "./auth.js";
import { parseTourSchedule } from "./tour-selection.js";
import { toApiTour } from "./tours.js";
import type { Tour } from "./database.js";

type ReportPhoto = { assetId: string; caption: string };
type Chapter = { id: string; title: string; date: string | null; text: string; tourId: string | null; photos: ReportPhoto[] };
type ReportRow = { id: string; immich_album_id: string; title: string; introduction: string; chapters_json: string; revision: number; updated_at: string };
type ShareRow = { id: string; label: string; createdAt: string; expiresAt: string | null; revokedAt: string | null };

function badRequest(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) badRequest("Ungültiger Reisebericht");
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, limit: number, required = false) {
  if (typeof value !== "string" || value.length > limit || (required && !value.trim())) {
    badRequest(`${label} fehlt oder ist zu lang`);
  }
  return value.trim();
}

function identifier(value: unknown, label: string) {
  const result = text(value, label, 100, true);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) badRequest(`${label} ist ungültig`);
  return result;
}

function toReport(row: ReportRow | undefined) {
  if (!row) return null;
  return {
    id: row.id, title: row.title, introduction: row.introduction,
    chapters: JSON.parse(row.chapters_json) as Chapter[],
    revision: row.revision, updatedAt: row.updated_at
  };
}

async function requireLogin(request: FastifyRequest, reply: FastifyReply) {
  if (!isAuthenticated(request)) return reply.code(401).send({ message: "Zum Bearbeiten des Reiseberichts bitte anmelden" });
}

export async function registerReportRoutes(
  app: FastifyInstance,
  database: DatabaseSync,
  albumContainsAssets: (albumId: string, assetIds: string[]) => Promise<boolean>
) {
  function getReport(albumId: string) {
    return database.prepare("SELECT * FROM reports WHERE immich_album_id = ?").get(albumId) as ReportRow | undefined;
  }

  function sharesFor(reportId: string) {
    return database.prepare(`SELECT id, label, created_at AS createdAt,
      expires_at AS expiresAt, revoked_at AS revokedAt FROM report_shares
      WHERE report_id = ? ORDER BY created_at DESC, id`).all(reportId) as ShareRow[];
  }

  app.get<{ Params: { albumId: string } }>(
    "/api/albums/:albumId/report/shares", { preHandler: requireLogin },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const report = getReport(request.params.albumId);
      return report ? sharesFor(report.id) : [];
    }
  );

  app.post<{ Params: { albumId: string }; Body: unknown }>(
    "/api/albums/:albumId/report/shares", { preHandler: requireLogin },
    async (request, reply) => {
      const report = getReport(request.params.albumId);
      if (!report) return reply.code(404).send({ message: "Bitte zuerst den Reisebericht speichern" });
      const input = object(request.body);
      const label = text(input.label ?? "", "Bezeichnung", 100) || "Freigabelink";
      let expiresAt: string | null = null;
      if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== "") {
        if (typeof input.expiresAt !== "string" || input.expiresAt.length > 50) badRequest("Ungültige Ablaufzeit");
        const instant = new Date(input.expiresAt);
        if (!Number.isFinite(instant.getTime()) || instant.getTime() <= Date.now()) badRequest("Die Ablaufzeit muss in der Zukunft liegen");
        expiresAt = instant.toISOString();
      }
      const id = randomUUID();
      const token = randomBytes(32).toString("base64url");
      const hash = createHash("sha256").update(token).digest("hex");
      const now = new Date().toISOString();
      database.prepare(`INSERT INTO report_shares
        (id, report_id, token_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, report.id, hash, label, now, expiresAt);
      reply.header("cache-control", "no-store");
      return reply.code(201).send({ share: { id, label, createdAt: now, expiresAt, revokedAt: null }, token });
    }
  );

  app.post<{ Params: { albumId: string; shareId: string } }>(
    "/api/albums/:albumId/report/shares/:shareId/revoke", { preHandler: requireLogin },
    async (request, reply) => {
      const report = getReport(request.params.albumId);
      if (!report) return reply.code(404).send({ message: "Freigabelink nicht gefunden" });
      const result = database.prepare(`UPDATE report_shares SET revoked_at = COALESCE(revoked_at, ?)
        WHERE id = ? AND report_id = ?`).run(new Date().toISOString(), request.params.shareId, report.id);
      if (!result.changes) return reply.code(404).send({ message: "Freigabelink nicht gefunden" });
      reply.header("cache-control", "no-store");
      return { revoked: true };
    }
  );

  app.get("/api/shared-report", async (request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-robots-tag", "noindex, nofollow");
    const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const invalidLink = () => reply.code(404).send({ message: "Freigabelink ist ungültig, abgelaufen oder widerrufen" });
    if (!token) return invalidLink();
    const hash = createHash("sha256").update(token).digest("hex");
    const row = database.prepare(`SELECT reports.* FROM report_shares
      JOIN reports ON reports.id = report_shares.report_id
      WHERE report_shares.token_hash = ? AND report_shares.revoked_at IS NULL
      AND (report_shares.expires_at IS NULL OR report_shares.expires_at > ?)`
    ).get(hash, new Date().toISOString()) as ReportRow | undefined;
    if (!row) return invalidLink();
    const report = toReport(row)!;
    const tourIds = new Set(report.chapters.map((chapter) => chapter.tourId).filter((id): id is string => Boolean(id)));
    const tours = [...tourIds].map((id) => toApiTour(database.prepare(
      "SELECT * FROM tours WHERE id = ? AND immich_album_id = ?"
    ).get(id, row.immich_album_id) as Tour | undefined)).filter((tour) => tour !== null);
    return { report, albumId: row.immich_album_id, tours };
  });

  app.get<{ Params: { albumId: string } }>(
    "/api/albums/:albumId/report",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      return toReport(getReport(request.params.albumId));
    }
  );

  app.put<{ Params: { albumId: string }; Body: unknown }>(
    "/api/albums/:albumId/report", { preHandler: requireLogin, bodyLimit: 1_000_000 },
    async (request, reply) => {
      const input = object(request.body);
      const title = text(input.title, "Berichtstitel", 200, true);
      const introduction = text(input.introduction, "Einleitung", 20000);
      const revision = input.revision;
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) badRequest("Ungültige Berichtsversion");
      if (!Array.isArray(input.chapters) || input.chapters.length > 100) badRequest("Höchstens 100 Kapitel sind erlaubt");
      const chapterIds = new Set<string>();
      const assetIds = new Set<string>();
      let photoCount = 0;
      const chapters: Chapter[] = input.chapters.map((value) => {
        const chapter = object(value);
        const id = identifier(chapter.id, "Kapitel-ID");
        if (chapterIds.has(id)) badRequest("Doppelte Kapitel-ID");
        chapterIds.add(id);
        const date = parseTourSchedule({ date: chapter.date }).date;
        const tourId = chapter.tourId === null ? null : identifier(chapter.tourId, "Tour-ID");
        if (tourId && !database.prepare("SELECT id FROM tours WHERE id = ? AND immich_album_id = ?").get(tourId, request.params.albumId)) {
          badRequest("Die ausgewählte Tour gehört nicht zu diesem Album");
        }
        if (!Array.isArray(chapter.photos) || chapter.photos.length > 100) badRequest("Höchstens 100 Fotos je Kapitel sind erlaubt");
        photoCount += chapter.photos.length;
        if (photoCount > 500) badRequest("Höchstens 500 Fotos je Reisebericht sind erlaubt");
        const chapterPhotos = new Set<string>();
        const photos = chapter.photos.map((value) => {
          const photo = object(value);
          const assetId = identifier(photo.assetId, "Foto-ID");
          if (chapterPhotos.has(assetId)) badRequest("Ein Foto darf innerhalb eines Kapitels nur einmal vorkommen");
          chapterPhotos.add(assetId);
          assetIds.add(assetId);
          return { assetId, caption: text(photo.caption, "Bildunterschrift", 2000) };
        });
        return { id, title: text(chapter.title, "Kapiteltitel", 200), date,
          text: text(chapter.text, "Kapiteltext", 20000), tourId, photos };
      });
      if (!(await albumContainsAssets(request.params.albumId, [...assetIds]))) {
        badRequest("Mindestens ein Foto gehört nicht mehr zu diesem Immich-Album");
      }
      const now = new Date().toISOString();
      const current = getReport(request.params.albumId);
      if ((!current && revision !== 0) || (current && current.revision !== revision)) {
        return reply.code(409).send({ message: "Der Bericht wurde zwischenzeitlich geändert. Bitte die aktuelle Version neu laden." });
      }
      const result = database.prepare(`
        INSERT INTO reports(id, immich_album_id, title, introduction, chapters_json, revision, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(immich_album_id) DO UPDATE SET
          title = excluded.title, introduction = excluded.introduction,
          chapters_json = excluded.chapters_json, revision = reports.revision + 1,
          updated_at = excluded.updated_at
        WHERE reports.revision = ?
      `).run(current?.id ?? randomUUID(), request.params.albumId, title, introduction, JSON.stringify(chapters), now, revision);
      if (!result.changes) return reply.code(409).send({ message: "Der Bericht wurde zwischenzeitlich geändert. Bitte neu laden." });
      reply.header("cache-control", "no-store");
      return toReport(getReport(request.params.albumId));
    }
  );
}