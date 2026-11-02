import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipFile } from "yazl";
import { openDatabase } from "../dist/database.js";
import { BackupManager, recoverInterruptedRestore } from "../dist/backups.js";
import { defaultSettings, readSettings, writeSettings } from "../dist/settings.js";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "mapper-backup-"));
  const dataDir = join(root, "data");
  const backupDir = join(root, "nas-backups");
  const config = { dataDir, backupDir, configFile: join(dataDir, "config.json") };
  const database = await openDatabase(config);
  const manager = new BackupManager(database, config);
  try { await run({ root, dataDir, backupDir, config, database, manager }); }
  finally { manager.stop(); database.close(); await rm(root, { recursive: true, force: true }); }
}

test("ZIP snapshot restores tours, reports, settings, uploads and config and creates a safety copy", async () => {
  await fixture(async ({ dataDir, config, database, manager }) => {
    await mkdir(join(dataDir, "uploads"));
    await writeFile(join(dataDir, "uploads", "track.gpx"), "<gpx>before</gpx>");
    await writeFile(config.configFile, JSON.stringify({ immichApiUrl: "http://saved" }));
    database.prepare("INSERT INTO tours(id, immich_album_id, gpx_file_path, created_at, updated_at) VALUES(?, ?, ?, ?, ?)").run("tour", "album", "track.gpx", "now", "now");
    database.prepare("INSERT INTO comments VALUES(?, ?, ?, ?, ?)").run("comment", "tour", null, "saved", "now");
    database.prepare("INSERT INTO reports VALUES(?, ?, ?, ?, ?, ?, ?)").run("report", "album", "Saved", "", "[]", 1, "now");
    writeSettings(database, { ...defaultSettings, sharingEnabled: false });
    const saved = await manager.create();
    assert.ok(saved.size > 0);
    const zip = await readFile(await manager.archivePath(saved.name));
    assert.equal(zip.subarray(0, 2).toString(), "PK");
    database.prepare("UPDATE reports SET title = 'Changed'").run();
    await writeFile(join(dataDir, "uploads", "track.gpx"), "changed");
    await writeFile(config.configFile, JSON.stringify({ immichApiUrl: "http://changed" }));
    writeSettings(database, { ...defaultSettings, sharingEnabled: true });
    const restored = await manager.restore(await manager.archivePath(saved.name));
    assert.equal(restored.restored, true);
    assert.equal(database.prepare("SELECT title FROM reports").get().title, "Saved");
    assert.equal(database.prepare("SELECT text FROM comments").get().text, "saved");
    assert.equal(readSettings(database).sharingEnabled, false);
    assert.equal(await readFile(join(dataDir, "uploads", "track.gpx"), "utf8"), "<gpx>before</gpx>");
    assert.equal(JSON.parse(await readFile(config.configFile, "utf8")).immichApiUrl, "http://saved");
    assert.ok((await manager.list()).some(item => item.kind === "safety"));
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  });
});

test("retention deletes only named mapper archives and write locks block competing backups", async () => {
  await fixture(async ({ backupDir, database, manager }) => {
    await mkdir(backupDir);
    await writeFile(join(backupDir, "unrelated.zip"), "leave me");
    writeSettings(database, { ...defaultSettings, backupKeep: 2 });
    manager.beginWrite();
    await assert.rejects(manager.create());
    manager.endWrite(true);
    await manager.create(); await manager.create(); await manager.create();
    assert.equal((await manager.list()).length, 2);
    assert.equal(await readFile(join(backupDir, "unrelated.zip"), "utf8"), "leave me");
    await assert.rejects(manager.archivePath("../unrelated.zip"));
  });
});

test("invalid and tampered archives leave live data untouched", async () => {
  await fixture(async ({ root, database, manager }) => {
    const invalid = join(root, "invalid.zip");
    await writeFile(invalid, "not a zip");
    await assert.rejects(manager.restore(invalid));
    assert.equal(manager.status().operation, null);
    const zip = new ZipFile();
    const bad = join(root, "tampered.zip");
    const written = pipeline(zip.outputStream, createWriteStream(bad));
    zip.addBuffer(Buffer.from("invalid sqlite"), "mapper.sqlite");
    zip.addBuffer(Buffer.from(JSON.stringify({ format: "immich-gpx-mapper", version: 1, files: [{ path: "mapper.sqlite", size: 14, sha256: "wrong" }] })), "manifest.json");
    zip.end(); await written;
    await assert.rejects(manager.restore(bad));
    assert.equal(database.prepare("SELECT count(*) AS count FROM tours").get().count, 0);
    assert.equal(manager.status().operation, null);
    assert.equal((await manager.list()).length, 0);
  });
});

test("interval and change scheduling respects disabled mode", async () => {
  await fixture(async ({ database, manager }) => {
    manager.markChanged();
    await manager.tick(true);
    assert.equal((await manager.list()).length, 0);
    writeSettings(database, { ...defaultSettings, backupMode: "interval", backupIntervalDays: 2 });
    await manager.tick(false);
    assert.equal((await manager.list()).length, 1);
    await manager.tick(false);
    assert.equal((await manager.list()).length, 1);
    writeSettings(database, { ...defaultSettings, backupMode: "changes" });
    manager.markChanged(); await manager.tick(true);
    assert.equal((await manager.list()).length, 2);
  });
});

test("startup recovery rolls back interrupted file swaps or completes committed cleanup", async () => {
  await fixture(async ({ dataDir, database, config }) => {
    const target = join(dataDir, "uploads");
    const old = `${target}.before-test`;
    const work = join(dataDir, ".restore-test");
    const journalPath = join(dataDir, ".restore-journal.json");
    await mkdir(target); await mkdir(old); await mkdir(work);
    await writeFile(join(target, "new.txt"), "new");
    await writeFile(join(old, "old.txt"), "old");
    await writeFile(journalPath, JSON.stringify({ id: "restore-test", work, targets: [{ target, old, hadOld: true }] }));
    await recoverInterruptedRestore(database, config);
    assert.equal(await readFile(join(target, "old.txt"), "utf8"), "old");
    await mkdir(old); await mkdir(work);
    await writeFile(join(old, "obsolete.txt"), "old");
    database.prepare("INSERT INTO app_settings(key, value) VALUES('restore_completed', 'restore-test')").run();
    await writeFile(journalPath, JSON.stringify({ id: "restore-test", work, targets: [{ target, old, hadOld: true }] }));
    await recoverInterruptedRestore(database, config);
    assert.equal(await readFile(join(target, "old.txt"), "utf8"), "old");
    await assert.rejects(readFile(join(old, "obsolete.txt")));
    await assert.rejects(readFile(journalPath));
  });
});

test("ZIP traversal paths are rejected before touching live files", async () => {
  await fixture(async ({ root, manager }) => {
    const path = join(root, "traversal.zip");
    const zip = new ZipFile();
    const written = pipeline(zip.outputStream, createWriteStream(path));
    zip.addBuffer(Buffer.from("escape"), "uploads/a");
    zip.end(); await written;
    const content = await readFile(path);
    const original = Buffer.from("uploads/a");
    const malicious = Buffer.from("../evil/x");
    let index = 0;
    while ((index = content.indexOf(original, index)) !== -1) { malicious.copy(content, index); index += original.length; }
    await writeFile(path, content);
    await assert.rejects(manager.restore(path));
    await assert.rejects(readFile(join(root, "evil", "x")));
    assert.equal(manager.status().operation, null);
  });
});