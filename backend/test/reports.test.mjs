import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { openDatabase } from "../dist/database.js";
import { registerAuth } from "../dist/auth.js";
import { registerReportRoutes } from "../dist/reports.js";

test("reports allow anonymous reading but protect writes, membership and concurrent edits", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "mapper-report-"));
  let database = await openDatabase({ dataDir });
  const app = Fastify();
  try {
    database.prepare("INSERT INTO tours(id, immich_album_id, created_at, updated_at) VALUES(?, ?, ?, ?)").run("tour-own", "album", "now", "now");
    database.prepare("INSERT INTO tours(id, immich_album_id, created_at, updated_at) VALUES(?, ?, ?, ?)").run("tour-foreign", "other", "now", "now");
    await registerAuth(app, { appPassword: "ReportTestPassword123!" });
    await registerReportRoutes(app, database, async (albumId, ids) => albumId === "album" && ids.every(id => ["photo-one", "photo-two"].includes(id)));
    const url = "/api/albums/album/report";
    assert.equal((await app.inject({ url })).statusCode, 200);
    assert.equal((await app.inject({ url })).json(), null);
    assert.equal((await app.inject({ method: "PUT", url, payload: {} })).statusCode, 401);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: "ReportTestPassword123!" } });
    const headers = { cookie: login.headers["set-cookie"].split(";")[0] };
    assert.equal((await app.inject({ url, headers })).json(), null);
    const chapter = { id: "chapter-one", title: "Erster Tag", date: "2026-10-23", text: "Absatz eins\n\nAbsatz zwei <script>plain text</script>", tourId: "tour-own", photos: [{ assetId: "photo-one", caption: "Am Gipfel" }] };
    const input = { title: "Unser Urlaub", introduction: "Erinnerungen", revision: 0, chapters: [chapter, { ...chapter, id: "chapter-two", title: "Zweiter Tag", photos: [{ assetId: "photo-two", caption: "Abendlicht" }] }] };
    const saved = await app.inject({ method: "PUT", url, headers, payload: input });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().revision, 1);
    assert.deepEqual(saved.json().chapters, input.chapters);
    assert.deepEqual((await app.inject({ url })).json().chapters, input.chapters);
    assert.equal((await app.inject({ method: "PUT", url, headers, payload: input })).statusCode, 409);
    const reordered = await app.inject({ method: "PUT", url, headers, payload: { ...input, revision: 1, chapters: [...input.chapters].reverse() } });
    assert.equal(reordered.statusCode, 200);
    assert.equal(reordered.json().chapters[0].id, "chapter-two");
    for (const invalid of [
      { ...chapter, tourId: "tour-foreign" },
      { ...chapter, photos: [{ assetId: "foreign-photo", caption: "" }] },
      { ...chapter, photos: [chapter.photos[0], chapter.photos[0]] },
      { ...chapter, date: "2026-02-30" }
    ]) {
      assert.equal((await app.inject({ method: "PUT", url, headers, payload: { ...input, revision: 2, chapters: [invalid] } })).statusCode, 400);
    }
    assert.equal((await app.inject({ url, headers })).json().revision, 2);
    for (const invalid of [
      { ...input, revision: 2, chapters: [chapter, chapter] },
      { ...input, revision: 2, title: "x".repeat(201) },
      { ...input, revision: null },
      { ...input, revision: 2, chapters: Array.from({ length: 101 }, (_, index) => ({ ...chapter, id: `chapter-${index}` })) }
    ]) {
      assert.equal((await app.inject({ method: "PUT", url, headers, payload: invalid })).statusCode, 400);
    }
    const simultaneous = await Promise.all([
      app.inject({ method: "PUT", url, headers, payload: { ...input, revision: 2 } }),
      app.inject({ method: "PUT", url, headers, payload: { ...input, revision: 2, title: "Other tab" } })
    ]);
    assert.deepEqual(simultaneous.map(response => response.statusCode).sort(), [200, 409]);
    assert.equal((await app.inject({ url: "/api/albums/other/report", headers })).json(), null);
    assert.equal((await app.inject({ url, headers })).headers["cache-control"], "no-store");
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers })).statusCode, 200);
    assert.equal((await app.inject({ url, headers })).statusCode, 200);
    assert.equal((await app.inject({ method: "PUT", url, headers, payload: { ...input, revision: 3 } })).statusCode, 401);
    database.close();
    database = await openDatabase({ dataDir });
    assert.equal(database.prepare("SELECT revision FROM reports WHERE immich_album_id = ?").get("album").revision, 3);
  } finally {
    await app.close();
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});