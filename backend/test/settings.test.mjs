import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../dist/database.js";
import { defaultSettings, readSettings, writeSettings, validateSettings } from "../dist/settings.js";

test("settings persist and reject invalid modes and unsafe retention values", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "mapper-settings-"));
  const database = await openDatabase({ dataDir });
  try {
    assert.deepEqual(readSettings(database), defaultSettings);
    const changed = { ...defaultSettings, sharingEnabled: false, komootDefault: "local", backupMode: "both", backupIntervalDays: 2, backupKeep: 4 };
    writeSettings(database, changed);
    assert.deepEqual(readSettings(database), changed);
    for (const invalid of [{ backupKeep: 0 }, { backupIntervalDays: -1 }, { backupMode: "invalid" }, { sharingEnabled: "yes" }, { komootDefault: "other" }]) {
      assert.throws(() => validateSettings({ ...changed, ...invalid }));
    }
    assert.deepEqual(readSettings(database), changed);
  } finally { database.close(); await rm(dataDir, { recursive: true, force: true }); }
});