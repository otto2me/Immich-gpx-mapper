import { randomBytes, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import { decryptSecret, encryptSecret, hashPassword, loadEncryptionKey, verifyPassword } from "./crypto.js";

const cookieName = "mapper_session";
const sessionLifetimeSeconds = 12 * 60 * 60;
const failedLoginLimit = 5;
const failedLoginCooldownMs = 15 * 60 * 1000;
const sessions = new Map<string, { user: AuthUser; expiresAt: number }>();
const failedLogins = new Map<string, { count: number; blockedUntil: number }>();

export type AuthUser = {
  id: string;
  username: string;
  role: "admin" | "user";
};

function getCookie(request: FastifyRequest, name: string) {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return undefined;
  const prefix = `${name}=`;
  const value = cookieHeader.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return value?.slice(prefix.length);
}

export function getSession(request: FastifyRequest) {
  const token = getCookie(request, cookieName);
  if (!token) return undefined;
  const session = sessions.get(token);
  if (!session) return undefined;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return undefined;
  }
  return session.user;
}

export function isAuthenticated(request: FastifyRequest) {
  return getSession(request) !== undefined;
}

export function getImmichApiKey(database: DatabaseSync, userId: string, encryptionKey: Buffer) {
  const row = database.prepare("SELECT immich_api_key FROM users WHERE id = ?").get(userId) as
    { immich_api_key: string | null } | undefined;
  return row?.immich_api_key ? decryptSecret(row.immich_api_key, encryptionKey) : "";
}

export function clearSessions() {
  sessions.clear();
  failedLogins.clear();
}

export function clearUserSessions(userId: string) {
  for (const [token, session] of sessions) {
    if (session.user.id === userId) sessions.delete(token);
  }
}

function setSessionCookie(
  reply: FastifyReply,
  request: FastifyRequest,
  value: string,
  maxAgeSeconds: number
) {
  const secure = request.protocol === "https" ? "; Secure" : "";
  reply.header(
    "set-cookie",
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`
  );
}

function validateInitialIdentity(username: string, password: string) {
  if (!/^[a-zA-Z0-9._-]{1,50}$/.test(username)) {
    throw new Error("INITIAL_ADMIN_USERNAME darf 1-50 Buchstaben, Zahlen, Punkt, Unterstrich oder Bindestrich enthalten");
  }
  if (password.length < 12 || password.length > 1024) {
    throw new Error("INITIAL_ADMIN_PASSWORD muss 12-1024 Zeichen lang sein");
  }
}

async function removeLegacyKey(configFile: string | undefined) {
  if (!configFile) return;
  let contents: string;
  try {
    contents = await readFile(configFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const value: unknown = JSON.parse(contents);
  if (!value || typeof value !== "object" || Array.isArray(value) || !("immichApiKey" in value)) return;
  delete (value as Record<string, unknown>).immichApiKey;
  const temporary = `${configFile}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, configFile);
}

async function initializeAccounts(database: DatabaseSync, config: AppConfig) {
  const encryptionKey = await loadEncryptionKey(config.dataDir);
  const users = database.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  if (users.count === 0) {
    validateInitialIdentity(config.initialAdminUsername, config.initialAdminPassword);
    const user: AuthUser = {
      id: randomUUID(),
      username: config.initialAdminUsername,
      role: "admin"
    };
    const encryptedKey = config.legacyImmichApiKey
      ? encryptSecret(config.legacyImmichApiKey, encryptionKey)
      : null;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`INSERT INTO users (id, username, password_hash, role, immich_api_key, created_at)
        VALUES (?, ?, ?, 'admin', ?, ?)`)
        .run(user.id, user.username, hashPassword(config.initialAdminPassword), encryptedKey, new Date().toISOString());
      const albums = database.prepare(`SELECT immich_album_id FROM tours
        UNION SELECT immich_album_id FROM reports`).all() as Array<{ immich_album_id: string }>;
      const addAlbum = database.prepare(`INSERT INTO albums (immich_album_id, owner_id, visibility)
        VALUES (?, ?, 'private')`);
      for (const album of albums) addAlbum.run(album.immich_album_id, user.id);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  await removeLegacyKey(config.configFile);
  return encryptionKey;
}

export async function registerAuth(app: FastifyInstance, config: AppConfig, database: DatabaseSync) {
  const encryptionKey = await initializeAccounts(database, config);
  app.get("/api/auth/session", async (request) => {
    const user = getSession(request);
    return { authenticated: !!user, user: user ?? null };
  });

  app.post<{ Body: { username?: string; password?: string } }>(
    "/api/auth/login",
    async (request, reply) => {
      const now = Date.now();
      const attempt = failedLogins.get(request.ip);
      if (attempt?.blockedUntil && attempt.blockedUntil > now) {
        return reply.code(429).send({ message: "Zu viele Fehlversuche. Bitte später erneut versuchen." });
      }
      if (attempt?.blockedUntil && attempt.blockedUntil <= now) failedLogins.delete(request.ip);

      const username = request.body?.username;
      const password = request.body?.password;
      if (typeof username !== "string" || username.length > 50 ||
          typeof password !== "string" || password.length > 1024) {
        return reply.code(400).send({ message: "Benutzername oder Passwort fehlt oder ist ungültig" });
      }

      const user = database.prepare(`SELECT id, username, role, password_hash
        FROM users WHERE username = ? COLLATE NOCASE`).get(username.trim()) as
        (AuthUser & { password_hash: string }) | undefined;
      const matches = user ? verifyPassword(password, user.password_hash) : false;
      if (!user || !matches) {
        const failures = (failedLogins.get(request.ip)?.count ?? 0) + 1;
        failedLogins.set(request.ip, {
          count: failures,
          blockedUntil: failures >= failedLoginLimit ? now + failedLoginCooldownMs : 0
        });
        return reply.code(401).send({ message: "Benutzername oder Passwort ist falsch" });
      }

      failedLogins.delete(request.ip);
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, {
        user: { id: user.id, username: user.username, role: user.role },
        expiresAt: Date.now() + sessionLifetimeSeconds * 1000
      });
      setSessionCookie(reply, request, token, sessionLifetimeSeconds);
      return { authenticated: true, user: { id: user.id, username: user.username, role: user.role } };
    }
  );

  app.post("/api/auth/logout", async (request, reply) => {
    const token = getCookie(request, cookieName);
    if (token) sessions.delete(token);
    setSessionCookie(reply, request, "", 0);
    return { authenticated: false, user: null };
  });

  app.addHook("preHandler", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    if (!request.url.startsWith("/api/")) return;
    if (request.url.startsWith("/api/auth/")) return;
    if (!getSession(request)) return reply.code(401).send({ message: "Anmeldung erforderlich" });
  });
  return { encryptionKey };
}
