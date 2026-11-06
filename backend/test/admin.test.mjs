import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { openDatabase } from "../dist/database.js";
import { registerAdminRoutes } from "../dist/admin.js";
import { registerReportRoutes } from "../dist/reports.js";
import { defaultSettings } from "../dist/settings.js";
import { addOwnedAlbum, login, registerTestAuth, testConfig } from "./support.mjs";

test("admin routes protect backup data, disable shares server-side and restore through authenticated ZIP import", async () => {
  const root = await mkdtemp(join(tmpdir(), "mapper-admin-"));
  const config = testConfig(join(root, "data"), { backupDir: join(root, "backups"), configFile: join(root, "data", "config.json") });
  const database = await openDatabase(config);
  const app = Fastify();
  try {
    const { admin } = await registerTestAuth(app, database, config);
    addOwnedAlbum(database, admin.id, "album");
    await app.register(multipart);
    await registerReportRoutes(app, database, async () => true);
    await registerAdminRoutes(app, database, config);
    for (const url of ["/api/settings", "/api/backups", "/api/backups/any.zip"]) assert.equal((await app.inject({ url })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/backups/restore" })).statusCode, 401);
    const headers = await login(app);
    const base = "/api/albums/album/report";
    assert.equal((await app.inject({ method: "PUT", url: base, headers, payload: { title: "Saved", introduction: "", chapters: [], revision: 0 } })).statusCode, 200);
    const share = await app.inject({ method: "POST", url: `${base}/shares`, headers, payload: {} });
    const sharedHeaders = { authorization: `Bearer ${share.json().token}` };
    assert.equal((await app.inject({ url: "/api/shared-report", headers: sharedHeaders })).statusCode, 200);
    const settings = { ...defaultSettings, sharingEnabled: false, komootDefault: "local" };
    assert.equal((await app.inject({ method: "PUT", url: "/api/settings", headers, payload: settings })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/settings", headers })).json().settings.sharingEnabled, false);
    assert.equal((await app.inject({ url: "/api/shared-report", headers: sharedHeaders })).statusCode, 404);
    await app.inject({ method: "PUT", url: "/api/settings", headers, payload: { ...settings, sharingEnabled: true } });
    assert.equal((await app.inject({ url: "/api/shared-report", headers: sharedHeaders })).statusCode, 200);
    await app.inject({ method: "PUT", url: "/api/settings", headers, payload: settings });
    assert.equal((await app.inject({ method: "POST", url: `${base}/shares`, headers, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ url: base })).statusCode, 404);
    const created = await app.inject({ method: "POST", url: "/api/backups", headers });
    assert.equal(created.statusCode, 201);
    const download = await app.inject({ url: `/api/backups/${created.json().name}`, headers });
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers["content-type"], "application/zip");
    assert.equal((await app.inject({ method: "PUT", url: base, headers, payload: { title: "Changed", introduction: "", chapters: [], revision: 1 } })).statusCode, 200);
    const boundary = "restore-test-boundary";
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      download.rawPayload,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="passphrase"\r\n\r\n${config.backupPassphrase}\r\n--${boundary}--\r\n`)
    ]);
    const restored = await app.inject({ method: "POST", url: "/api/backups/restore", headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(restored.json().restored, true);
    const restoredHeaders = await login(app);
    assert.equal((await app.inject({ url: base, headers: restoredHeaders })).json().title, "Saved");
    assert.equal((await app.inject({ url: "/api/settings", headers })).statusCode, 401);
  } finally { await app.close(); database.close(); await rm(root, { recursive: true, force: true }); }
});