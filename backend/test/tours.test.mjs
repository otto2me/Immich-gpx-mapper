import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { openDatabase } from "../dist/database.js";
import { registerTourRoutes } from "../dist/tours.js";
import { registerImmichRoutes } from "../dist/immich.js";
import { parseTourSchedule, tourPhotoFilter } from "../dist/tour-selection.js";
import { addOwnedAlbum, login, registerTestAuth, testConfig } from "./support.mjs";

test("migration preserves existing tours, comments and file references", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "mapper-migration-"));
  let database;
  try {
    const legacy = new DatabaseSync(join(dataDir, "mapper.sqlite"));
    legacy.exec(`
      CREATE TABLE tours(id TEXT PRIMARY KEY, immich_album_id TEXT NOT NULL UNIQUE,
        komoot_link TEXT, gpx_file_path TEXT, description TEXT, direction TEXT,
        komoot_map_image_path TEXT, elevation_profile_image_path TEXT,
        distance_km REAL, elevation_gain_m REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE comments(id TEXT PRIMARY KEY, tour_id TEXT NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
        author TEXT, text TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO tours(id, immich_album_id, gpx_file_path, created_at, updated_at)
        VALUES('old', 'album', 'track.gpx', 'now', 'now');
      INSERT INTO comments VALUES('comment', 'old', NULL, 'kept', 'now');
    `);
    legacy.close();
    database = await openDatabase({ dataDir });
    const tour = database.prepare("SELECT * FROM tours WHERE id = 'old'").get();
    assert.equal(tour.gpx_file_path, "track.gpx");
    assert.equal(tour.tour_date, null);
    assert.equal(tour.activity_type, "hike");
    assert.equal(database.prepare("SELECT count(*) AS count FROM comments").get().count, 1);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    database.close();
    database = await openDatabase({ dataDir });
    assert.equal(database.prepare("SELECT count(*) AS count FROM tours").get().count, 1);
  } finally {
    database?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("local day and time filters respect timezone, DST and interval boundaries", () => {
  const schedule = parseTourSchedule({ date: "2026-03-29", timeZone: "Europe/Berlin" });
  assert.equal(schedule.start, null);
  assert.equal(schedule.end, null);
  assert.throws(() => parseTourSchedule({ date: "2026-02-30" }));
  assert.throws(() => parseTourSchedule({ date: false }));
  assert.throws(() => parseTourSchedule({ date: 0 }));
  assert.throws(() => parseTourSchedule({ date: "2026-01-01", timeZone: "Invalid/Zone" }));
  assert.throws(() => parseTourSchedule({ date: "2026-01-01", startTime: "15:00", endTime: "09:00" }));
  const wholeDay = tourPhotoFilter({ tour_date: schedule.date, time_zone: schedule.zone });
  assert.equal(wholeDay({ fileCreatedAt: "2026-03-28T23:00:00Z" }), true);
  assert.equal(wholeDay({ fileCreatedAt: "2026-03-29T22:00:00Z" }), false);
  assert.equal(wholeDay({}), false);
  const window = tourPhotoFilter({ tour_date: "2026-08-12", time_zone: "Europe/Berlin", start_time: "09:00", end_time: "15:30" });
  assert.equal(window({ fileCreatedAt: "2026-08-12T06:59:59Z" }), false);
  assert.equal(window({ fileCreatedAt: "2026-08-12T07:00:00Z" }), true);
  assert.equal(window({ fileCreatedAt: "2026-08-12T13:29:59Z" }), true);
  assert.equal(window({ fileCreatedAt: "2026-08-12T13:30:00Z" }), false);
  assert.equal(window({ fileCreatedAt: "invalid" }), false);
  const newZealand = tourPhotoFilter({ tour_date: "2026-01-02", time_zone: "Pacific/Auckland" });
  assert.equal(newZealand({ fileCreatedAt: "2026-01-01T11:00:00Z" }), true);
});

test("tour APIs isolate albums, files and comments and filter before photo pagination", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "mapper-api-"));
  const config = testConfig(dataDir);
  const database = await openDatabase(config);
  const app = Fastify();
  const originalFetch = globalThis.fetch;
  const assets = Array.from({ length: 1200 }, (_, index) => ({
    id: `asset-${index}`, fileCreatedAt: index % 20 === 0 ? "2026-08-12T10:00:00Z" : "2026-08-13T10:00:00Z"
  }));
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/assets/asset-0/thumbnail")) {
      return new Response("thumbnail", { headers: { "content-type": "image/jpeg" } });
    }
    if (String(url).endsWith("/map-markers")) {
      return Response.json(assets.map((asset) => ({ id: asset.id, lat: 48, lon: 11 })));
    }
    assert.ok(String(url).endsWith("/search/metadata"));
    const { page, size } = JSON.parse(init.body);
    const items = assets.slice((page - 1) * size, page * size);
    return Response.json({ assets: { items, total: items.length, nextPage: page * size < assets.length ? String(page + 1) : null } });
  };
  try {
    const { admin, encryptionKey } = await registerTestAuth(app, database, config);
    addOwnedAlbum(database, admin.id, "album");
    const immich = await registerImmichRoutes(app, config, database, encryptionKey);
    assert.equal(await immich.albumContainsAssets("album", ["asset-0", "asset-1100"]), true);
    assert.equal(await immich.albumContainsAssets("album", ["missing"]), false);
    await registerTourRoutes(app, database, config);
    assert.equal((await app.inject({ url: "/api/assets/asset-0/thumbnail?size=invalid" })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/albums/album/tours", payload: { date: "2026-08-12" } })).statusCode, 401);
    const headers = await login(app);
    const thumbnail = await app.inject({ url: "/api/assets/asset-0/thumbnail?albumId=album", headers });
    assert.equal(thumbnail.statusCode, 200);
    assert.equal(thumbnail.headers["content-type"], "image/jpeg");
    assert.equal(thumbnail.body, "thumbnail");
    const create = async (date) => app.inject({ method: "POST", url: "/api/albums/album/tours", headers, payload: { date, timeZone: "Europe/Berlin", title: date } });
    const first = await create("2026-08-12");
    assert.equal(first.statusCode, 201);
    const firstTour = first.json();
    const second = await create("2026-08-13");
    assert.equal(second.statusCode, 201);
    assert.equal((await create("2026-08-12")).statusCode, 409);
    assert.equal((await create("2026-02-30")).statusCode, 400);
    const selected = `/api/tours/album?tourId=${firstTour.id}`;
    const updated = await app.inject({ method: "PUT", url: selected, headers, payload: { title: "Morning", startTime: "09:00", endTime: "15:30" } });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().startTime, "09:00");
    assert.equal((await app.inject({ method: "PUT", url: selected, headers, payload: { date: "2026-08-13" } })).statusCode, 409);
    assert.equal((await app.inject({ method: "PUT", url: selected, headers, payload: { startTime: "24:00" } })).statusCode, 400);
    assert.equal((await app.inject({ url: `/api/tours/other?tourId=${firstTour.id}` })).statusCode, 404);
    const pageOne = await app.inject({ url: `/api/albums/album/assets?tourId=${firstTour.id}&page=1`, headers });
    assert.equal(pageOne.statusCode, 200);
    assert.equal(pageOne.json().items.length, 48);
    assert.equal(pageOne.json().total, 60);
    assert.equal(pageOne.json().hasMore, true);
    const pageTwo = await app.inject({ url: `/api/albums/album/assets?tourId=${firstTour.id}&page=2`, headers });
    assert.equal(pageTwo.json().items.length, 12);
    assert.equal(pageTwo.json().hasMore, false);
    const markers = await app.inject({ url: `/api/albums/album/map-markers?tourId=${firstTour.id}`, headers });
    assert.equal(markers.json().length, 60);
    const comment = await app.inject({ method: "POST", url: `/api/tours/album/comments?tourId=${firstTour.id}`, headers, payload: { text: "First tour only" } });
    assert.equal(comment.statusCode, 201);
    assert.equal((await app.inject({ url: `/api/tours/album/comments?tourId=${second.json().id}`, headers })).json().length, 0);
    const multipart = '--boundary\r\nContent-Disposition: form-data; name="file"; filename="track.gpx"\r\nContent-Type: application/gpx+xml\r\n\r\n<gpx><trk/></gpx>\r\n--boundary--\r\n';
    const upload = await app.inject({ method: "POST", url: `/api/tours/album/gpx?tourId=${firstTour.id}`, headers: { ...headers, "content-type": "multipart/form-data; boundary=boundary" }, payload: multipart });
    assert.equal(upload.statusCode, 201);
    assert.equal((await app.inject({ url: `/api/tours/album/gpx?tourId=${firstTour.id}`, headers })).statusCode, 200);
    assert.equal((await app.inject({ url: `/api/tours/album/gpx?tourId=${second.json().id}`, headers })).statusCode, 404);
    const imageBody = '--image\r\nContent-Disposition: form-data; name="file"; filename="map.png"\r\nContent-Type: image/png\r\n\r\npreview\r\n--image--\r\n';
    const imageUpload = await app.inject({ method: "POST", url: `/api/tours/album/images/komoot-map?tourId=${firstTour.id}`, headers: { ...headers, "content-type": "multipart/form-data; boundary=image" }, payload: imageBody });
    assert.equal(imageUpload.statusCode, 201);
    assert.equal((await app.inject({ url: `/api/tours/album/images/komoot-map?tourId=${firstTour.id}`, headers })).statusCode, 200);
    assert.equal((await app.inject({ url: `/api/tours/album/images/komoot-map?tourId=${second.json().id}`, headers })).statusCode, 404);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});