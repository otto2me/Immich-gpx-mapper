import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import { clearSessions } from "./auth.js";
import { BackupManager } from "./backups.js";
import { readSettings, writeSettings } from "./settings.js";
import { requireAdmin } from "./access.js";

export async function registerAdminRoutes(app: FastifyInstance, database: DatabaseSync, config: AppConfig) {
  const backups = new BackupManager(database, config);
  const writes = new WeakSet<FastifyRequest>();
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (backups.isRestoring()) return reply.code(503).send({ message: "Wiederherstellung läuft; bitte später erneut versuchen" });
    if (["GET", "HEAD", "OPTIONS"].includes(request.method) || request.url.startsWith("/api/auth/") || request.url.startsWith("/api/backups")) return;
    backups.beginWrite();
    writes.add(request);
  });
  app.addHook("onResponse", async (request, reply) => {
    if (writes.has(request)) { writes.delete(request); backups.endWrite(reply.statusCode < 400); }
  });
  const requireLogin = async (request: FastifyRequest, reply: import("fastify").FastifyReply) => {
    const result = requireAdmin(database, request, reply);
    if (result) return result;
    reply.header("cache-control", "no-store");
  };

  app.get("/api/settings", { preHandler: requireLogin }, async () => ({ settings: readSettings(database), backup: backups.status() }));
  app.put<{ Body: unknown }>("/api/settings", { preHandler: requireLogin }, async (request) => ({ settings: writeSettings(database, request.body), backup: backups.status() }));
  app.get("/api/backups", { preHandler: requireLogin }, async () => ({ items: await backups.list(), status: backups.status() }));
  app.post("/api/backups", { preHandler: requireLogin }, async (_request, reply) => reply.code(201).send(await backups.create()));
  app.get<{ Params: { name: string } }>("/api/backups/:name", { preHandler: requireLogin }, async (request, reply) => {
    const path = await backups.archivePath(request.params.name);
    return reply.type("application/zip").header("content-disposition", `attachment; filename="${request.params.name}"`)
      .header("x-content-type-options", "nosniff").send(createReadStream(path));
  });
  app.post("/api/backups/restore", { preHandler: requireLogin, bodyLimit: 1024 * 1024 * 1024 + 1024 * 1024 }, async (request) => {
    const work = await mkdtemp(join(config.dataDir, ".import-"));
    try {
      let path: string | undefined;
      let passphrase: string | undefined;
      for await (const part of request.parts({ limits: { fileSize: 1024 * 1024 * 1024, files: 1, fields: 1 } })) {
        if (part.type === "file") {
          if (part.fieldname !== "file" || path) throw Object.assign(new Error("Ungültige Importdatei"), { statusCode: 400 });
          path = join(work, "backup.zip");
          await pipeline(part.file, createWriteStream(path, { flags: "wx", mode: 0o600 }));
          if (part.file.truncated) throw Object.assign(new Error("ZIP-Datei ist größer als 1 GiB"), { statusCode: 413 });
        } else if (part.fieldname === "passphrase" && typeof part.value === "string" && !passphrase) {
          passphrase = part.value;
        } else {
          throw Object.assign(new Error("Ungültige Wiederherstellungsdaten"), { statusCode: 400 });
        }
      }
      if (!path) throw Object.assign(new Error("ZIP-Datei fehlt"), { statusCode: 400 });
      if (!passphrase) throw Object.assign(new Error("Backup-Passphrase fehlt"), { statusCode: 400 });
      const result = await backups.restore(path, passphrase);
      clearSessions();
      return result;
    } finally { await rm(work, { recursive: true, force: true }); }
  });
  app.addHook("onReady", async () => backups.start());
  app.addHook("onClose", async () => backups.stop());
  return backups;
}