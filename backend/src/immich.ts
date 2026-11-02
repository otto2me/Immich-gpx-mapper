import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { DatabaseSync } from "node:sqlite";
import type { Tour } from "./database.js";
import { selectTour, tourPhotoFilter } from "./tour-selection.js";

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
  database: DatabaseSync
) {
  async function immichFetch(path: string, init: RequestInit = {}) {
    if (!config.immichApiKey) {
      const error = new Error("Immich API ist nicht konfiguriert");
      Object.assign(error, { statusCode: 503 });
      throw error;
    }

    const headers = new Headers(init.headers);
    headers.set("x-api-key", config.immichApiKey);
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

  async function searchAssets(albumId: string, page: number, size: number) {
    const response = await immichFetch("search/metadata", {
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

  async function matchingAssets(albumId: string, tour: Tour) {
    const matches = tourPhotoFilter(tour);
    const items: ImmichAsset[] = [];
    let page = 1;
    while (true) {
      const result = await searchAssets(albumId, page, 1000);
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

  app.get("/api/albums", async () => {
    const response = await immichFetch("albums");
    return response.json();
  });

  app.get<{ Params: { albumId: string } }>(
    "/api/albums/:albumId",
    async (request) => {
      const response = await immichFetch(
        `albums/${encodeURIComponent(request.params.albumId)}`
      );
      return response.json();
    }
  );

  app.get<{ Params: { albumId: string }; Querystring: { tourId?: string } }>(
    "/api/albums/:albumId/map-markers",
    async (request) => {
      const tour = request.query.tourId === undefined ? undefined : selectTour(database, request.params.albumId, request.query);
      const response = await immichFetch(
        `albums/${encodeURIComponent(request.params.albumId)}/map-markers`
      );
      const markers = await response.json() as Array<{ id: string }>;
      if (!tour?.tour_date) return markers;
      const ids = new Set((await matchingAssets(request.params.albumId, tour)).map((asset) => asset.id));
      return markers.filter((marker) => ids.has(marker.id));
    }
  );

  app.get<{ Params: { albumId: string }; Querystring: { page?: string; tourId?: string } }>(
    "/api/albums/:albumId/assets",
    async (request, reply) => {
      const page = Number(request.query.page ?? "1");
      if (!Number.isInteger(page) || page < 1) {
        return reply.code(400).send({ message: "Ungültige Albumseite" });
      }

      const pageSize = 48;
      const tour = request.query.tourId === undefined ? undefined : selectTour(database, request.params.albumId, request.query);
      if (tour?.tour_date) {
        const assets = await matchingAssets(request.params.albumId, tour);
        return {
          items: assets.slice((page - 1) * pageSize, page * pageSize),
          total: assets.length, page, pageSize, hasMore: page * pageSize < assets.length
        };
      }
      const result = await searchAssets(request.params.albumId, page, pageSize);
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

  app.get<{ Params: { assetId: string }; Querystring: { size?: string } }>(
    "/api/assets/:assetId/thumbnail",
    async (request, reply) => {
      const size = request.query.size ?? "thumbnail";
      if (size !== "thumbnail" && size !== "preview") return reply.code(400).send({ message: "Ungültige Bildgröße" });
      const response = await immichFetch(
        `assets/${encodeURIComponent(request.params.assetId)}/thumbnail?size=${size}`
      );
      const contentType = response.headers.get("content-type");
      if (contentType) reply.type(contentType);
      return reply.send(Buffer.from(await response.arrayBuffer()));
    }
  );

  return {
    async albumContainsAssets(albumId: string, assetIds: string[]) {
      const remaining = new Set(assetIds);
      if (!remaining.size) return true;
      let page = 1;
      while (true) {
        const result = await searchAssets(albumId, page, 1000);
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
  };
}
