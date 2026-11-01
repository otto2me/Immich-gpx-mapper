import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";

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
  config: AppConfig
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

  app.get<{ Params: { albumId: string } }>(
    "/api/albums/:albumId/map-markers",
    async (request) => {
      const response = await immichFetch(
        `albums/${encodeURIComponent(request.params.albumId)}/map-markers`
      );
      return response.json();
    }
  );

  app.get<{ Params: { albumId: string }; Querystring: { page?: string } }>(
    "/api/albums/:albumId/assets",
    async (request, reply) => {
      const page = Number(request.query.page ?? "1");
      if (!Number.isInteger(page) || page < 1) {
        return reply.code(400).send({ message: "Ungültige Albumseite" });
      }

      const pageSize = 48;
      const response = await immichFetch("search/metadata", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          albumIds: [request.params.albumId],
          page,
          size: pageSize
        })
      });
      const result = await response.json() as {
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
      };
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

  app.get<{ Params: { assetId: string } }>(
    "/api/assets/:assetId/thumbnail",
    async (request, reply) => {
      const response = await immichFetch(
        `assets/${encodeURIComponent(request.params.assetId)}/thumbnail?size=thumbnail`
      );
      const contentType = response.headers.get("content-type");
      if (contentType) reply.type(contentType);
      return reply.send(Buffer.from(await response.arrayBuffer()));
    }
  );
}
