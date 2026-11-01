import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { Comment, Tour } from "./database.js";
import { DatabaseSync } from "node:sqlite";
import { captureKomootScreenshots } from "./komoot-screenshots.js";
import { publicKomootEmbedUrl } from "./komoot.js";

const maxUploadBytes = 20 * 1024 * 1024;
const allowedImages = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"]
]);

type TourInput = {
  activityType?: unknown;
  komootLink?: unknown;
  description?: unknown;
  direction?: unknown;
  distanceKm?: unknown;
  elevationGainM?: unknown;
};

class ValidationError extends Error {}

function toApiTour(tour: Tour | undefined) {
  if (!tour) return null;
  return {
    id: tour.id,
    activityType: tour.activity_type,
    komootLink: tour.komoot_link ?? "",
    description: tour.description ?? "",
    direction: tour.direction ?? "",
    distanceKm: tour.distance_km,
    elevationGainM: tour.elevation_gain_m,
    hasGpx: Boolean(tour.gpx_file_path),
    hasKomootMap: Boolean(tour.komoot_map_image_path),
    hasElevationProfile: Boolean(tour.elevation_profile_image_path)
  };
}

function getTour(database: DatabaseSync, albumId: string) {
  return database
    .prepare("SELECT * FROM tours WHERE immich_album_id = ?")
    .get(albumId) as Tour | undefined;
}

function ensureTour(database: DatabaseSync, albumId: string) {
  const found = getTour(database, albumId);
  if (found) return found;
  const now = new Date().toISOString();
  const id = randomUUID();
  database.prepare(`
    INSERT INTO tours (id, immich_album_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(id, albumId, now, now);
  return getTour(database, albumId)!;
}

function normalizeText(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new ValidationError(`${field} ist ungültig oder zu lang`);
  }
  return value.trim() || null;
}

function normalizeNumber(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${field} muss eine nicht-negative Zahl sein`);
  }
  return value;
}

function uploadPath(config: AppConfig, storedPath: string) {
  const fileName = basename(storedPath);
  return resolve(config.dataDir, "uploads", fileName);
}

async function saveUpload(config: AppConfig, contents: Buffer, extension: string) {
  const directory = resolve(config.dataDir, "uploads");
  await mkdir(directory, { recursive: true });
  const fileName = `${randomUUID()}${extension}`;
  await writeFile(resolve(directory, fileName), contents, { flag: "wx" });
  return fileName;
}

export async function registerTourRoutes(
  app: FastifyInstance,
  database: DatabaseSync,
  config: AppConfig
) {
  await app.register(multipart, {
    limits: { fileSize: maxUploadBytes, files: 1, fields: 0 }
  });

  app.get("/api/tours/komoot-linked-albums", async () => {
    const rows = database.prepare(`
      SELECT immich_album_id
      FROM tours
      WHERE komoot_link IS NOT NULL AND TRIM(komoot_link) != ''
    `).all() as Array<{ immich_album_id: string }>;
    return rows.map(({ immich_album_id }) => immich_album_id);
  });

  app.get<{ Params: { albumId: string } }>(
    "/api/tours/:albumId",
    async (request) => toApiTour(getTour(database, request.params.albumId))
  );

  app.put<{ Params: { albumId: string }; Body: TourInput }>(
    "/api/tours/:albumId",
    async (request, reply) => {
      try {
        const { activityType, komootLink, description, direction, distanceKm, elevationGainM } =
          request.body ?? {};
        const existing = getTour(database, request.params.albumId);
        const normalizedActivity =
          activityType ?? existing?.activity_type ?? "hike";
        if (normalizedActivity !== "hike" && normalizedActivity !== "bike") {
          return reply.code(400).send({ message: "Tourart muss Wanderung oder Fahrradtour sein" });
        }
        const link = normalizeText(komootLink, "Komoot-Link", 2048);
        if (link) {
          let parsed: URL;
          try {
            parsed = new URL(link);
          } catch {
            return reply.code(400).send({ message: "Komoot-Link ist keine gültige URL" });
          }
          if (
            parsed.protocol !== "https:" ||
            !["komoot.com", "komoot.de"].some(
              (domain) =>
                parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)
            )
          ) {
            return reply.code(400).send({ message: "Bitte einen HTTPS-Link von komoot.com oder komoot.de eingeben" });
          }
        }

        const descriptionValue = normalizeText(description, "Beschreibung", 20000);
        const directionValue = normalizeText(direction, "Richtung", 100);
        if (directionValue && directionValue !== "forward" && directionValue !== "reverse") {
          return reply.code(400).send({ message: "Wanderrichtung ist ungültig" });
        }
        const distance = normalizeNumber(distanceKm, "Distanz");
        const elevation = normalizeNumber(elevationGainM, "Höhenmeter");
        const tour = ensureTour(database, request.params.albumId);
        const komootLinkChanged = tour.komoot_link !== link;
        const updatedAt = new Date().toISOString();
        database.prepare(`
          UPDATE tours SET
            activity_type = ?, komoot_link = ?, description = ?, direction = ?,
            distance_km = ?, elevation_gain_m = ?,
            komoot_map_image_path = CASE WHEN komoot_link IS ? THEN komoot_map_image_path ELSE NULL END,
            elevation_profile_image_path = CASE WHEN komoot_link IS ? THEN elevation_profile_image_path ELSE NULL END,
            updated_at = ?
          WHERE id = ?
        `).run(
          normalizedActivity,
          link,
          descriptionValue,
          directionValue,
          distance,
          elevation,
          link,
          link,
          updatedAt,
          tour.id
        );
        if (komootLinkChanged) {
          if (tour.komoot_map_image_path) {
            await rm(uploadPath(config, tour.komoot_map_image_path), { force: true });
          }
          if (tour.elevation_profile_image_path) {
            await rm(uploadPath(config, tour.elevation_profile_image_path), { force: true });
          }
        }
        return toApiTour(getTour(database, request.params.albumId));
      } catch (error) {
        if (error instanceof ValidationError) {
          return reply.code(400).send({ message: error.message });
        }
        throw error;
      }
    }
  );

  app.post<{ Params: { albumId: string } }>(
    "/api/tours/:albumId/gpx",
    async (request, reply) => {
      const part = await request.file();
      if (!part || part.fieldname !== "file") {
        return reply.code(400).send({ message: "GPX-Datei fehlt" });
      }
      const content = await part.toBuffer();
      const text = content.toString("utf8");
      if (!/<(?:[A-Za-z0-9_-]+:)?gpx(?:\s|>)/i.test(text)) {
        return reply.code(400).send({ message: "Die Datei enthält kein gültiges GPX-Dokument" });
      }

      const tour = ensureTour(database, request.params.albumId);
      const previous = tour.gpx_file_path;
      const storedPath = await saveUpload(config, content, ".gpx");
      database.prepare(`
        UPDATE tours SET gpx_file_path = ?, updated_at = ? WHERE id = ?
      `).run(storedPath, new Date().toISOString(), tour.id);
      if (previous) await rm(uploadPath(config, previous), { force: true });
      return reply.code(201).send({ fileName: basename(part.filename) });
    }
  );

  app.post<{
    Params: { albumId: string };
    Body: { url?: unknown };
  }>(
    "/api/tours/:albumId/komoot-screenshots",
    async (request, reply) => {
      const link = request.body?.url;
      if (typeof link !== "string" || link.length > 2048) {
        return reply.code(400).send({ message: "Bitte zuerst einen gültigen Komoot-Link angeben" });
      }
      const embedUrl = publicKomootEmbedUrl(link);
      if (!embedUrl) {
        return reply.code(400).send({ message: "Unterstützt werden öffentliche Tour-Links von www.komoot.de und www.komoot.com" });
      }

      let screenshots: Awaited<ReturnType<typeof captureKomootScreenshots>>;
      try {
        screenshots = await captureKomootScreenshots(embedUrl);
      } catch (error) {
        request.log.warn({ err: error }, "Could not capture public Komoot map and elevation profile");
        return reply.code(502).send({
          message: error instanceof Error
            ? error.message
            : "Komoot-Karte und Höhenprofil konnten nicht aufgenommen werden"
        });
      }

      const tour = ensureTour(database, request.params.albumId);
      const mapPath = await saveUpload(config, screenshots.mapImage, ".png");
      let elevationPath: string | null = null;
      try {
        elevationPath = await saveUpload(config, screenshots.elevationImage, ".png");
        database.prepare(`
          UPDATE tours SET
            komoot_link = ?, komoot_map_image_path = ?,
            elevation_profile_image_path = ?, updated_at = ?
          WHERE id = ?
        `).run(
          link.trim(),
          mapPath,
          elevationPath,
          new Date().toISOString(),
          tour.id
        );
      } catch (error) {
        await Promise.all([
          rm(uploadPath(config, mapPath), { force: true }),
          ...(elevationPath
            ? [rm(uploadPath(config, elevationPath), { force: true })]
            : [])
        ]);
        throw error;
      }

      if (tour.komoot_map_image_path) {
        await rm(uploadPath(config, tour.komoot_map_image_path), { force: true });
      }
      if (tour.elevation_profile_image_path) {
        await rm(uploadPath(config, tour.elevation_profile_image_path), { force: true });
      }
      return reply.code(201).send(toApiTour(getTour(database, request.params.albumId)));
    }
  );

  app.get<{ Params: { albumId: string } }>(
    "/api/tours/:albumId/gpx",
    async (request, reply) => {
      const tour = getTour(database, request.params.albumId);
      if (!tour?.gpx_file_path) {
        return reply.code(404).send({ message: "Für dieses Album ist keine GPX-Datei vorhanden" });
      }
      const content = await readFile(uploadPath(config, tour.gpx_file_path));
      return reply
        .type("application/gpx+xml; charset=utf-8")
        .header("x-content-type-options", "nosniff")
        .header("content-disposition", 'inline; filename="track.gpx"')
        .send(content);
    }
  );

  app.post<{ Params: { albumId: string; kind: string } }>(
    "/api/tours/:albumId/images/:kind",
    async (request, reply) => {
      if (request.params.kind !== "komoot-map" && request.params.kind !== "elevation") {
        return reply.code(404).send({ message: "Bildtyp nicht gefunden" });
      }
      const part = await request.file();
      if (!part || part.fieldname !== "file") {
        return reply.code(400).send({ message: "Bilddatei fehlt" });
      }
      const extension = allowedImages.get(part.mimetype);
      if (!extension) {
        return reply.code(415).send({ message: "Erlaubt sind JPEG-, PNG- und WebP-Bilder" });
      }

      const tour = ensureTour(database, request.params.albumId);
      const field =
        request.params.kind === "komoot-map"
          ? "komoot_map_image_path"
          : "elevation_profile_image_path";
      const previous = tour[field];
      const storedPath = await saveUpload(config, await part.toBuffer(), extension);
      database.prepare(`UPDATE tours SET ${field} = ?, updated_at = ? WHERE id = ?`)
        .run(storedPath, new Date().toISOString(), tour.id);
      if (previous) await rm(uploadPath(config, previous), { force: true });
      return reply.code(201).send({ uploaded: true });
    }
  );

  app.get<{ Params: { albumId: string; kind: string } }>(
    "/api/tours/:albumId/images/:kind",
    async (request, reply) => {
      const tour = getTour(database, request.params.albumId);
      const storedPath =
        request.params.kind === "komoot-map"
          ? tour?.komoot_map_image_path
          : request.params.kind === "elevation"
                ? tour?.elevation_profile_image_path
            : null;
      if (!storedPath) {
        return reply.code(404).send({ message: "Bild nicht gefunden" });
      }
      const filePath = uploadPath(config, storedPath);
      const mimeType = new Map([
        [".jpg", "image/jpeg"],
        [".png", "image/png"],
        [".webp", "image/webp"]
      ]).get(extname(filePath));
      if (!mimeType) {
        return reply.code(404).send({ message: "Bild nicht gefunden" });
      }
      return reply
        .type(mimeType)
        .header("x-content-type-options", "nosniff")
        .send(await readFile(filePath));
    }
  );

  app.get<{ Params: { albumId: string } }>(
    "/api/tours/:albumId/comments",
    async (request) => {
      const tour = getTour(database, request.params.albumId);
      if (!tour) return [];
      return database.prepare(`
        SELECT id, tour_id, author, text, created_at FROM comments
        WHERE tour_id = ? ORDER BY created_at ASC
      `).all(tour.id) as Comment[];
    }
  );

  app.post<{
    Params: { albumId: string };
    Body: { author?: unknown; text?: unknown };
  }>("/api/tours/:albumId/comments", async (request, reply) => {
    let text: string | null;
    let author: string | null;
    try {
      text = normalizeText(request.body?.text, "Kommentar", 4000);
      author = normalizeText(request.body?.author, "Name", 100);
    } catch (error) {
      if (error instanceof ValidationError) {
        return reply.code(400).send({ message: error.message });
      }
      throw error;
    }
    if (!text) {
      return reply.code(400).send({ message: "Kommentar darf nicht leer sein" });
    }
    const tour = ensureTour(database, request.params.albumId);
    const comment: Comment = {
      id: randomUUID(),
      tour_id: tour.id,
      author,
      text,
      created_at: new Date().toISOString()
    };
    database.prepare(`
      INSERT INTO comments (id, tour_id, author, text, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(comment.id, comment.tour_id, comment.author, comment.text, comment.created_at);
    return reply.code(201).send(comment);
  });
}
