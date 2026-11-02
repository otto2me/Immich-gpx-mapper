import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isAuthenticated } from "./auth.js";
import { parseTourSchedule } from "./tour-selection.js";

type ReportPhoto = { assetId: string; caption: string };
type Chapter = { id: string; title: string; date: string | null; text: string; tourId: string | null; photos: ReportPhoto[] };
type ReportRow = { id: string; title: string; introduction: string; chapters_json: string; revision: number; updated_at: string };

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