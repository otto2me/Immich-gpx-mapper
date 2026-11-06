import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { DatabaseSync } from "node:sqlite";
import type { Tour } from "./database.js";
import { selectTour, tourPhotoFilter } from "./tour-selection.js";
import { getImmichApiKey, getSession } from "./auth.js";
import { albumRow, canReadAlbum, ensureAlbum, reportShareFromRequest, requireAlbumRead } from "./access.js";

export type ImmichAlbum = {
  id: string;
  albumName: string;
  description?: string | null;
  albumThumbnailAssetId?: string | null;
  assetCount?: number;
  assets?: ImmichAsset[];
};

export type ImmichAsset = {
  id: string;
  type?: string;
  originalFileName?: string;
  fileCreatedAt?: string;
};

export async function registerImmichRoutes(
  app: FastifyInstance,
  config: AppConfig,
  database: DatabaseSync,
  encryptionKey: Buffer
) {
  async function immichFetch(path: string, apiKey: string, init: RequestInit = {}) {
    if (!apiKey) {
      const error = new Error("Immich API ist nicht konfiguriert");
      Object.assign(error, { statusCode: 503 });
      throw error;
    }

    const headers = new Headers(init.headers);
    headers.set("x-api-key", apiKey);
    const response = await fetch(
      `${config.immichApiUrl.replace(/\/+$/, "")}/api/${path}`,
      { ...init, headers }
    );
    if (!response.ok) {
      const error = new Error(`Immich API antwortet mit HTTP ${response.status}`);
      Object.assign(error, { statusCode: 502 });
      throw error;
    }
    return response;
  }

  async function searchAssets(albumId: string, apiKey: string, page: number, size: number) {
    const response = await immichFetch("search/metadata", apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ albumIds: [albumId], page, size })
    });
    return response.json() as Promise<{
      assets?: {
        items?: Array<{
          id: string;
          type?: string;
          originalFileName?: string | null;
          fileCreatedAt?: string | null;
        }>;
        total?: number;
        nextPage?: string | null;
      };
    }>;
  }

  async function matchingAssets(albumId: string, tour: Tour, apiKey: string) {
    const matches = tourPhotoFilter(tour);
    const items: ImmichAsset[] = [];
    let page = 1;
    while (true) {
      const result = await searchAssets(albumId, apiKey, page, 1000);
      for (const asset of result.assets?.items ?? []) {
        if (matches(asset)) items.push({
          id: asset.id, type: asset.type,
          originalFileName: asset.originalFileName ?? undefined,
          fileCreatedAt: asset.fileCreatedAt ?? undefined
        });
      }
      if (!result.assets?.nextPage) break;
      const next = Number(result.assets.nextPage);
      if (!Number.isInteger(next) || next <= page) {
        throw Object.assign(new Error("Immich liefert eine ungültige Folgeseite"), { statusCode: 502 });
      }
      page = next;
    }
    return items;
  }

  function ownerApiKey(albumId: string) {
    const album = albumRow(database, albumId);
    if (!album) return "";
    return getImmichApiKey(database, album.owner_id, encryptionKey);
  }

  async function registerAlbumForUser(albumId: string, userId: string) {
    const apiKey = getImmichApiKey(database, userId, encryptionKey);
    const response = await immichFetch(`albums/${encodeURIComponent(albumId)}`, apiKey);
    const metadata = await response.json() as ImmichAlbum;
    if (metadata.id !== albumId) {
      throw Object.assign(new Error("Album nicht gefunden"), { statusCode: 404 });
    }
    ensureAlbum(database, metadata.id, userId, {
      id: metadata.id, albumName: metadata.albumName, description: metadata.description,
      albumThumbnailAssetId: metadata.albumThumbnailAssetId, assetCount: metadata.assetCount
    });
  }

  async function albumContainsAssets(albumId: string, assetIds: string[], providedKey?: string) {
    const apiKey = providedKey ?? ownerApiKey(albumId);
    const remaining = new Set(assetIds);
    if (!remaining.size) return true;
    let page = 1;
    while (true) {
      const result = await searchAssets(albumId, apiKey, page, 1000);
      for (const asset of result.assets?.items ?? []) remaining.delete(asset.id);
      if (!remaining.size) return true;
      if (!result.assets?.nextPage) return false;
      const next = Number(result.assets.nextPage);
      if (!Number.isInteger(next) || next <= page) {
        throw Object.assign(new Error("Immich liefert eine ungültige Folgeseite"), { statusCode: 502 });
      }
      page = next;
    }
  }

  app.get("/api/albums", async (request) => {
    const user = getSession(request);
    const visible = database.prepare("SELECT * FROM albums").all() as Array<{
      immich_album_id: string; owner_id: string; visibility: "private" | "shared" | "public"; metadata_json: string
    }>;
    const result = new Map<string, ImmichAlbum>();
    for (const album of visible) {
      if (!canReadAlbum(database, user, album.immich_album_id)) continue;
      const metadata = JSON.parse(album.metadata_json) as ImmichAlbum;
      if (typeof metadata.albumName === "string") result.set(album.immich_album_id, metadata);
    }
    if (user) {
      const key = getImmichApiKey(database, user.id, encryptionKey);
      if (key) {
        const response = await immichFetch("albums", key);
        const ownAlbums = await response.json() as ImmichAlbum[];
        for (const album of ownAlbums) {
          ensureAlbum(database, album.id, user.id, {
            id: album.id, albumName: album.albumName, description: album.description,
            albumThumbnailAssetId: album.albumThumbnailAssetId, assetCount: album.assetCount
          });
          result.set(album.id, album);
        }
      }
    }
    return [...result.values()]
      .filter((album) => canReadAlbum(database, user, album.id))
      .map((album) => {
      const policy = albumRow(database, album.id);
      return {
        ...album,
        ownerId: policy?.owner_id,
        visibility: policy?.visibility,
        isOwner: Boolean(user && policy?.owner_id === user.id)
      };
      }).sort((first, second) => first.albumName.localeCompare(second.albumName));
  });

  app.get<{ Params: { albumId: string } }>(
    "/api/albums/:albumId",
    async (request, reply) => {
      const album = albumRow(database, request.params.albumId);
      const user = getSession(request);
      if (!album && user) {
        await registerAlbumForUser(request.params.albumId, user.id);
      }
      const { album: readableAlbum } = requireAlbumRead(database, request, request.params.albumId);
      const response = await immichFetch(
        `albums/${encodeURIComponent(request.params.albumId)}`,
        getImmichApiKey(database, readableAlbum.owner_id, encryptionKey)
      );
      const remote = await response.json() as ImmichAlbum;
      return {
        ...remote,
        ownerId: readableAlbum.owner_id,
        visibility: readableAlbum.visibility,
        isOwner: Boolean(user && readableAlbum.owner_id === user.id)
      };
    }
  );

  app.get<{ Params: { albumId: string }; Querystring: { tourId?: string } }>(
    "/api/albums/:albumId/map-markers",
    async (request) => {
      const { album } = requireAlbumRead(database, request, request.params.albumId);
      const apiKey = getImmichApiKey(database, album.owner_id, encryptionKey);
      const tour = request.query.tourId === undefined ? undefined : selectTour(database, request.params.albumId, request.query);
      const response = await immichFetch(
        `albums/${encodeURIComponent(request.params.albumId)}/map-markers`, apiKey
      );
      const markers = await response.json() as Array<{ id: string }>;
      if (!tour?.tour_date) return markers;
      const ids = new Set((await matchingAssets(request.params.albumId, tour, apiKey)).map((asset) => asset.id));
      return markers.filter((marker) => ids.has(marker.id));
    }
  );

  app.get<{ Params: { albumId: string }; Querystring: { page?: string; tourId?: string } }>(
    "/api/albums/:albumId/assets",
    async (request, reply) => {
      const { album } = requireAlbumRead(database, request, request.params.albumId);
      const apiKey = getImmichApiKey(database, album.owner_id, encryptionKey);
      const page = Number(request.query.page ?? "1");
      if (!Number.isInteger(page) || page < 1) {
        return reply.code(400).send({ message: "Ungültige Albumseite" });
      }

      const pageSize = 48;
      const tour = request.query.tourId === undefined ? undefined : selectTour(database, request.params.albumId, request.query);
      if (tour?.tour_date) {
        const assets = await matchingAssets(request.params.albumId, tour, apiKey);
        return {
          items: assets.slice((page - 1) * pageSize, page * pageSize),
          total: assets.length, page, pageSize, hasMore: page * pageSize < assets.length
        };
      }
      const result = await searchAssets(request.params.albumId, apiKey, page, pageSize);
      const items = (result.assets?.items ?? []).map((asset) => ({
        id: asset.id,
        type: asset.type,
        originalFileName: asset.originalFileName ?? undefined,
        fileCreatedAt: asset.fileCreatedAt ?? undefined
      }));
      const total = result.assets?.total ?? items.length;

      return {
        items,
        total,
        page,
        pageSize,
        hasMore: Boolean(result.assets?.nextPage)
      };
    }
  );

  app.get<{ Params: { assetId: string }; Querystring: { size?: string; albumId?: string } }>(
    "/api/assets/:assetId/thumbnail",
    async (request, reply) => {
      const albumId = request.query.albumId;
      if (!albumId) return reply.code(400).send({ message: "Album-ID fehlt" });
      const user = getSession(request);
      if (!albumRow(database, albumId) && user) {
        await registerAlbumForUser(albumId, user.id);
      }
      const { album } = requireAlbumRead(database, request, albumId);
      const apiKey = getImmichApiKey(database, album.owner_id, encryptionKey);
      if (!(await albumContainsAssets(albumId, [request.params.assetId], apiKey))) {
        return reply.code(404).send({ message: "Bild nicht gefunden" });
      }
      const size = request.query.size ?? "thumbnail";
      if (size !== "thumbnail" && size !== "preview") return reply.code(400).send({ message: "Ungültige Bildgröße" });
      const response = await immichFetch(
        `assets/${encodeURIComponent(request.params.assetId)}/thumbnail?size=${size}`, apiKey
      );
      const contentType = response.headers.get("content-type");
      if (contentType) reply.type(contentType);
      return reply.send(Buffer.from(await response.arrayBuffer()));
    }
  );

  app.get<{ Params: { assetId: string }; Querystring: { albumId?: string; size?: string } }>(
    "/api/shared-report-assets/assets/:assetId/thumbnail",
    async (request, reply) => {
      const share = reportShareFromRequest(database, request);
      if (!share || share.albumId !== request.query.albumId || !share.assetIds.has(request.params.assetId)) {
        return reply.code(404).send({ message: "Bild nicht gefunden" });
      }
      const size = request.query.size ?? "thumbnail";
      if (size !== "thumbnail" && size !== "preview") return reply.code(400).send({ message: "Ungültige Bildgröße" });
      reply.header("cache-control", "no-store");
      const apiKey = ownerApiKey(share.albumId);
      const response = await immichFetch(
        `assets/${encodeURIComponent(request.params.assetId)}/thumbnail?size=${size}`, apiKey
      );
      const contentType = response.headers.get("content-type");
      if (contentType) reply.type(contentType);
      return reply.send(Buffer.from(await response.arrayBuffer()));
    }
  );

  return { albumContainsAssets };
}
