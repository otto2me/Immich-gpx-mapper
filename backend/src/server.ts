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
import { registerReportRoutes } from "./reports.js";
import { registerAdminRoutes } from "./admin.js";
import { readSettings } from "./settings.js";
import { recoverInterruptedRestore } from "./backups.js";
import { registerAccessRoutes } from "./access.js";

const config = loadConfig();
const database = await openDatabase(config);
await recoverInterruptedRestore(database, config);

const app = Fastify({
  logger: true,
  trustProxy: true
});

const { encryptionKey } = await registerAuth(app, config, database);
registerAccessRoutes(app, database, encryptionKey);
const immich = await registerImmichRoutes(app, config, database, encryptionKey);
await registerTourRoutes(app, database, config);
await registerKomootRoutes(app);
await registerReportRoutes(app, database, immich.albumContainsAssets);
await registerAdminRoutes(app, database, config);

app.get("/api/config", async () => ({
  immichWebUrl: config.immichWebUrl,
  sharingEnabled: readSettings(database).sharingEnabled,
  komootDefault: readSettings(database).komootDefault
}));

app.get("/api/health", async () => ({
  status: "ok",
  immichConfigured: Boolean(database.prepare("SELECT 1 FROM users WHERE immich_api_key IS NOT NULL LIMIT 1").get()),
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
