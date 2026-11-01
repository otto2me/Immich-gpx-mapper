import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { openDatabase } from "./database.js";
import { registerAuth } from "./auth.js";
import { registerImmichRoutes } from "./immich.js";
import { registerTourRoutes } from "./tours.js";
import { registerKomootRoutes } from "./komoot.js";

const config = loadConfig();
const database = await openDatabase(config);

const app = Fastify({
  logger: true,
  trustProxy: true
});

await registerAuth(app, config);
await registerImmichRoutes(app, config);
await registerTourRoutes(app, database, config);
await registerKomootRoutes(app);

app.get("/api/config", async () => ({
  immichWebUrl: config.immichWebUrl
}));

app.get("/api/health", async () => ({
  status: "ok",
  immichConfigured: config.immichApiKey.length > 0,
  authenticatedAccessRequired: true
}));

const staticDir = process.env.STATIC_DIR ?? resolve("public");
if (existsSync(staticDir)) {
  await app.register(fastifyStatic, {
    root: staticDir
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ message: "Not found" });
    }

    return reply.sendFile("index.html");
  });
}

await app.listen({
  host: process.env.HOST ?? "0.0.0.0",
  port: config.port
});
