import { registerAuth } from "../dist/auth.js";

export function testConfig(dataDir, values = {}) {
  return {
    dataDir,
    backupDir: values.backupDir,
    configFile: values.configFile,
    initialAdminUsername: "test-admin",
    initialAdminPassword: "TestAdminPassword123!",
    legacyImmichApiKey: values.legacyImmichApiKey ?? "test-legacy-immich-key",
    backupPassphrase: "TestBackupPassphrase-2026",
    immichApiUrl: values.immichApiUrl ?? "http://immich.test",
    immichWebUrl: null,
    port: 3000
  };
}

export async function registerTestAuth(app, database, config) {
  const { encryptionKey } = await registerAuth(app, config, database);
  const admin = database.prepare("SELECT id, username, role FROM users WHERE username = ?")
    .get(config.initialAdminUsername);
  return { admin, encryptionKey };
}

export function addOwnedAlbum(database, ownerId, albumId, visibility = "private") {
  database.prepare(`INSERT OR IGNORE INTO albums(immich_album_id, owner_id, visibility, metadata_json)
    VALUES(?, ?, ?, ?)`).run(albumId, ownerId, visibility, JSON.stringify({
    id: albumId, albumName: albumId, assetCount: 0
  }));
}

export async function login(app, username = "test-admin", password = "TestAdminPassword123!") {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username, password }
  });
  if (response.statusCode !== 200) throw new Error(`Test login failed: ${response.statusCode} ${response.body}`);
  return { cookie: response.headers["set-cookie"].split(";")[0] };
}
