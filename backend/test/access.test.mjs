import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { openDatabase } from "../dist/database.js";
import { registerAccessRoutes, canReadAlbum } from "../dist/access.js";
import { encryptSecret } from "../dist/crypto.js";
import { registerImmichRoutes } from "../dist/immich.js";
import { addOwnedAlbum, login, registerTestAuth, testConfig } from "./support.mjs";

test("album grants require owner control, are revocable and public access requires confirmation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "mapper-access-"));
  const config = testConfig(dataDir);
  const database = await openDatabase(config);
  const app = Fastify();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (new URL(String(url)).pathname === "/api/albums") {
      return Response.json([{ id: "album", albumName: "Album", assetCount: 1 }]);
    }
    throw new Error(`Unexpected Immich request: ${url}`);
  };
  try {
    const { admin, encryptionKey } = await registerTestAuth(app, database, config);
    addOwnedAlbum(database, admin.id, "album");
    registerAccessRoutes(app, database, encryptionKey);
    await registerImmichRoutes(app, config, database, encryptionKey);

    assert.equal((await app.inject({ url: "/api/users/selectable" })).statusCode, 401);
    const adminHeaders = await login(app);
    assert.deepEqual((await app.inject({ url: "/api/user/settings", headers: adminHeaders })).json(), {
      immichApiKeyConfigured: true
    });
    assert.deepEqual((await app.inject({ url: "/api/albums/album/access", headers: adminHeaders })).json(), {
      visibility: "private", userIds: []
    });
    const created = await app.inject({
      method: "POST", url: "/api/users", headers: adminHeaders,
      payload: { username: "member", password: "MemberPassword123!" }
    });
    assert.equal(created.statusCode, 201);
    const member = database.prepare("SELECT id, username, role FROM users WHERE username = 'member'").get();
    database.prepare("UPDATE users SET immich_api_key = ? WHERE id = ?")
      .run(encryptSecret("test-member-key", encryptionKey), member.id);
    const memberHeaders = await login(app, "member", "MemberPassword123!");
    assert.deepEqual((await app.inject({ url: "/api/user/settings", headers: memberHeaders })).json(), {
      immichApiKeyConfigured: true
    });
    assert.deepEqual((await app.inject({ url: "/api/albums", headers: memberHeaders })).json(), []);
    assert.equal((await app.inject({ url: "/api/albums/album", headers: memberHeaders })).statusCode, 404);
    assert.deepEqual((await app.inject({ url: "/api/users/selectable", headers: adminHeaders })).json()
      .map(({ username }) => username), ["member", "test-admin"]);
    assert.equal(canReadAlbum(database, member, "album"), false);

    assert.equal((await app.inject({
      method: "PUT", url: "/api/albums/album/access", headers: adminHeaders,
      payload: { visibility: "shared" }
    })).statusCode, 400);
    database.prepare("UPDATE users SET immich_api_key = NULL WHERE id = ?").run(admin.id);
    assert.equal((await app.inject({
      method: "PUT", url: "/api/albums/album/access", headers: adminHeaders,
      payload: { visibility: "shared", userIds: [member.id] }
    })).statusCode, 200);
    assert.equal(canReadAlbum(database, member, "album"), true);

    const staleMemberHeaders = memberHeaders;
    assert.equal((await app.inject({
      method: "PUT", url: `/api/users/${member.id}`, headers: adminHeaders,
      payload: { password: "ChangedMemberPassword123!" }
    })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/auth/session", headers: staleMemberHeaders })).json().authenticated, false);
    assert.equal((await app.inject({ url: "/api/users/selectable", headers: adminHeaders })).statusCode, 200);
    const refreshedMemberHeaders = await login(app, "member", "ChangedMemberPassword123!");
    assert.equal((await app.inject({ url: "/api/albums", headers: refreshedMemberHeaders })).json().length, 1);
    assert.equal((await app.inject({ url: "/api/albums/album/access", headers: refreshedMemberHeaders })).statusCode, 404);
    assert.equal((await app.inject({
      method: "PUT", url: "/api/albums/album/access", headers: refreshedMemberHeaders,
      payload: { visibility: "public", publicConfirmed: true }
    })).statusCode, 404);

    assert.equal((await app.inject({
      method: "PUT", url: "/api/albums/album/access", headers: adminHeaders,
      payload: { visibility: "private" }
    })).statusCode, 200);
    assert.equal(canReadAlbum(database, member, "album"), false);
    assert.equal((await app.inject({
      method: "PUT", url: "/api/albums/album/access", headers: adminHeaders,
      payload: { visibility: "public" }
    })).statusCode, 400);
    assert.equal((await app.inject({
      method: "PUT", url: "/api/albums/album/access", headers: adminHeaders,
      payload: { visibility: "public", publicConfirmed: true }
    })).statusCode, 409);

    database.prepare("UPDATE users SET immich_api_key = ? WHERE id = ?")
      .run(encryptSecret("test-owner-key", encryptionKey), admin.id);
    assert.equal((await app.inject({
      method: "PUT", url: "/api/albums/album/access", headers: adminHeaders,
      payload: { visibility: "public", publicConfirmed: true }
    })).statusCode, 200);
    assert.equal(canReadAlbum(database, undefined, "album"), true);

    addOwnedAlbum(database, admin.id, "transfer-album");
    const memberAccount = (await app.inject({ url: "/api/users", headers: adminHeaders })).json()
      .find((account) => account.id === member.id);
    assert.equal(memberAccount.immichApiKeyConfigured, true);
    assert.equal((await app.inject({
      method: "PUT", url: "/api/admin/albums/transfer-album/owner", headers: refreshedMemberHeaders,
      payload: { ownerUserId: member.id }
    })).statusCode, 403);
    assert.equal((await app.inject({
      method: "PUT", url: "/api/admin/albums/transfer-album/owner", headers: adminHeaders,
      payload: { ownerUserId: "unknown-user" }
    })).statusCode, 404);
    database.prepare("UPDATE users SET immich_api_key = NULL WHERE id = ?").run(member.id);
    assert.equal((await app.inject({
      method: "PUT", url: "/api/admin/albums/transfer-album/owner", headers: adminHeaders,
      payload: { ownerUserId: member.id }
    })).statusCode, 409);
    database.prepare("UPDATE users SET immich_api_key = ? WHERE id = ?")
      .run(encryptSecret("test-member-key", encryptionKey), member.id);
    assert.equal((await app.inject({
      method: "PUT", url: "/api/admin/albums/transfer-album/owner", headers: adminHeaders,
      payload: { ownerUserId: member.id }
    })).statusCode, 200);
    assert.equal(database.prepare("SELECT owner_id FROM albums WHERE immich_album_id = 'transfer-album'").get().owner_id, member.id);
    assert.equal(Boolean(canReadAlbum(database, member, "transfer-album")), true);
    assert.equal(canReadAlbum(database, admin, "transfer-album"), false);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
