import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";

const cookieName = "mapper_session";
const sessionLifetimeSeconds = 12 * 60 * 60;
const failedLoginLimit = 5;
const failedLoginCooldownMs = 15 * 60 * 1000;
const sessions = new Map<string, number>();
const failedLogins = new Map<string, { count: number; blockedUntil: number }>();

function getCookie(request: FastifyRequest, name: string) {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return undefined;
  const prefix = `${name}=`;
  const value = cookieHeader.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return value?.slice(prefix.length);
}

export function isAuthenticated(request: FastifyRequest) {
  const token = getCookie(request, cookieName);
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function clearSessions() {
  sessions.clear();
  failedLogins.clear();
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

export async function registerAuth(app: FastifyInstance, config: AppConfig) {
  app.get("/api/auth/session", async (request) => ({
    authenticated: isAuthenticated(request)
  }));

  app.post<{ Body: { password?: string } }>(
    "/api/auth/login",
    async (request, reply) => {
      const now = Date.now();
      const attempt = failedLogins.get(request.ip);
      if (attempt?.blockedUntil && attempt.blockedUntil > now) {
        return reply.code(429).send({ message: "Zu viele Fehlversuche. Bitte später erneut versuchen." });
      }
      if (attempt?.blockedUntil && attempt.blockedUntil <= now) {
        failedLogins.delete(request.ip);
      }

      const provided = request.body?.password;
      if (typeof provided !== "string" || provided.length > 1024) {
        return reply.code(400).send({ message: "Passwort fehlt oder ist ungültig" });
      }

      const actual = Buffer.from(provided);
      const expected = Buffer.from(config.appPassword);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        const failures = (failedLogins.get(request.ip)?.count ?? 0) + 1;
        failedLogins.set(request.ip, {
          count: failures,
          blockedUntil: failures >= failedLoginLimit ? now + failedLoginCooldownMs : 0
        });
        return reply.code(401).send({ message: "Passwort ist falsch" });
      }

      failedLogins.delete(request.ip);
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, Date.now() + sessionLifetimeSeconds * 1000);
      setSessionCookie(reply, request, token, sessionLifetimeSeconds);
      return { authenticated: true };
    }
  );

  app.post("/api/auth/logout", async (request, reply) => {
    const token = getCookie(request, cookieName);
    if (token) sessions.delete(token);
    setSessionCookie(reply, request, "", 0);
    return { authenticated: false };
  });

  app.addHook("preHandler", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    if (!request.url.startsWith("/api/")) return;
    if (request.url.startsWith("/api/auth/")) return;
    if (!isAuthenticated(request)) {
      return reply.code(401).send({ message: "Anmeldung erforderlich" });
    }
  });
}
