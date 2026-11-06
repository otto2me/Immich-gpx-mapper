import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { openDatabase } from "../dist/database.js";
import { registerAuth, getImmichApiKey } from "../dist/auth.js";
import { resolveReportShare } from "../dist/access.js";
import { testConfig } from "./support.mjs";

test("first account migration retains legacy content, private album ownership, API key and blog share hashes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "mapper-account-migration-"));
  const configFile = join(dataDir, "config.json");
  const shareToken = "A".repeat(43);
  const shareHash = createHash("sha256").update(shareToken).digest("hex");
  await writeFile(configFile, JSON.stringify({
    immichApiUrl: "http://immich.test",
    immichApiKey: "legacy-immich-key"
  }));
  const legacy = new DatabaseSync(join(dataDir, "mapper.sqlite"));
  legacy.exec(`
    CREATE TABLE tours(id TEXT PRIMARY KEY, immich_album_id TEXT NOT NULL UNIQUE,
      activity_type TEXT NOT NULL DEFAULT 'hike', komoot_link TEXT, gpx_file_path TEXT,
      description TEXT, direction TEXT, komoot_map_image_path TEXT,
      elevation_profile_image_path TEXT, distance_km REAL, elevation_gain_m REAL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE comments(id TEXT PRIMARY KEY, tour_id TEXT NOT NULL REFERENCES tours(id),
      author TEXT, text TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO tours(id, immich_album_id, gpx_file_path, created_at, updated_at)
      VALUES('tour-legacy', 'album-legacy', 'legacy.gpx', 'now', 'now');
    INSERT INTO comments VALUES('comment-legacy', 'tour-legacy', 'owner', 'Keep this', 'now');
    CREATE TABLE reports(id TEXT PRIMARY KEY, immich_album_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, introduction TEXT NOT NULL DEFAULT '',
      chapters_json TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL);
    INSERT INTO reports VALUES('report-legacy', 'album-legacy', 'Old report', '', '[]', 3, 'now');
    CREATE TABLE report_shares(id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, created_at TEXT NOT NULL,
      expires_at TEXT, revoked_at TEXT);
  `);
  legacy.prepare("INSERT INTO report_shares VALUES(?, ?, ?, ?, ?, ?, ?)")
    .run("share-legacy", "report-legacy", shareHash, "Family", "now", null, null);
  legacy.close();

  const config = testConfig(dataDir, { configFile, legacyImmichApiKey: "legacy-immich-key" });
  const database = await openDatabase(config);
  const app = Fastify();
  try {
    const { encryptionKey } = await registerAuth(app, config, database);
    const admin = database.prepare("SELECT id, username, role FROM users").get();
    assert.equal(admin.username, "test-admin");
    assert.equal(admin.role, "admin");
    const album = database.prepare("SELECT owner_id, visibility FROM albums WHERE immich_album_id = 'album-legacy'").get();
    assert.equal(album.owner_id, admin.id);
    assert.equal(album.visibility, "private");
    assert.equal(database.prepare("SELECT id, gpx_file_path FROM tours WHERE id = 'tour-legacy'").get().gpx_file_path, "legacy.gpx");
    assert.equal(database.prepare("SELECT id, text FROM comments WHERE id = 'comment-legacy'").get().text, "Keep this");
    assert.equal(database.prepare("SELECT id, title, is_private FROM reports WHERE id = 'report-legacy'").get().title, "Old report");
    assert.equal(database.prepare("SELECT is_private FROM reports WHERE id = 'report-legacy'").get().is_private, 0);
    assert.equal(database.prepare("SELECT id, token_hash FROM report_shares WHERE id = 'share-legacy'").get().token_hash, shareHash);
    assert.equal(resolveReportShare(database, shareToken).reportId, "report-legacy");
    assert.equal(getImmichApiKey(database, admin.id, encryptionKey), "legacy-immich-key");
    assert.equal(JSON.parse(await readFile(configFile, "utf8")).immichApiKey, undefined);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    await app.close();
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
