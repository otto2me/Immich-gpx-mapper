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
  async function immichFetch(path: string) {
    if (!config.immichApiKey) {
      const error = new Error("Immich API ist nicht konfiguriert");
      Object.assign(error, { statusCode: 503 });
      throw error;
    }

    const response = await fetch(
      `${config.immichApiUrl.replace(/\/+$/, "")}/api/${path}`,
      { headers: { "x-api-key": config.immichApiKey } }
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
