import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";

export type Tour = {
  id: string;
  immich_album_id: string;
  title: string;
  tour_date: string | null;
  time_zone: string;
  start_time: string | null;
  end_time: string | null;
  activity_type: "hike" | "bike";
  komoot_link: string | null;
  gpx_file_path: string | null;
  description: string | null;
  direction: string | null;
  komoot_map_image_path: string | null;
  elevation_profile_image_path: string | null;
  distance_km: number | null;
  elevation_gain_m: number | null;
  created_at: string;
  updated_at: string;
};

export type Comment = {
  id: string;
  tour_id: string;
  author: string | null;
  text: string;
  created_at: string;
};

export async function openDatabase(config: AppConfig) {
  await mkdir(config.dataDir, { recursive: true });
  const database = new DatabaseSync(join(config.dataDir, "mapper.sqlite"));
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS tours (
      id TEXT PRIMARY KEY,
      immich_album_id TEXT NOT NULL UNIQUE,
      activity_type TEXT NOT NULL DEFAULT 'hike' CHECK(activity_type IN ('hike', 'bike')),
      komoot_link TEXT,
      gpx_file_path TEXT,
      description TEXT,
      direction TEXT,
      komoot_map_image_path TEXT,
      elevation_profile_image_path TEXT,
      distance_km REAL,
      elevation_gain_m REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      tour_id TEXT NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
      author TEXT,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const columns = database.prepare("PRAGMA table_info(tours)").all();
  if (!columns.some((column) => column.name === "activity_type")) {
    database.exec(`
      ALTER TABLE tours
      ADD COLUMN activity_type TEXT NOT NULL DEFAULT 'hike'
      CHECK(activity_type IN ('hike', 'bike'));
    `);
  }
  if (!columns.some((column) => column.name === "tour_date")) {
    database.exec("PRAGMA foreign_keys = OFF");
    try {
      database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE tours_next (
          id TEXT PRIMARY KEY,
          immich_album_id TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          tour_date TEXT,
          time_zone TEXT NOT NULL DEFAULT 'UTC',
          start_time TEXT,
          end_time TEXT,
          activity_type TEXT NOT NULL DEFAULT 'hike' CHECK(activity_type IN ('hike', 'bike')),
          komoot_link TEXT,
          gpx_file_path TEXT,
          description TEXT,
          direction TEXT,
          komoot_map_image_path TEXT,
          elevation_profile_image_path TEXT,
          distance_km REAL,
          elevation_gain_m REAL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO tours_next (
          id, immich_album_id, activity_type, komoot_link, gpx_file_path,
          description, direction, komoot_map_image_path, elevation_profile_image_path,
          distance_km, elevation_gain_m, created_at, updated_at
        ) SELECT
          id, immich_album_id, activity_type, komoot_link, gpx_file_path,
          description, direction, komoot_map_image_path, elevation_profile_image_path,
          distance_km, elevation_gain_m, created_at, updated_at
        FROM tours;
        DROP TABLE tours;
        ALTER TABLE tours_next RENAME TO tours;
        CREATE UNIQUE INDEX tours_album_date ON tours(immich_album_id, tour_date);
        CREATE UNIQUE INDEX tours_album_undated ON tours(immich_album_id) WHERE tour_date IS NULL;
        COMMIT;
      `);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      database.exec("PRAGMA foreign_keys = ON");
    }
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      immich_album_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      introduction TEXT NOT NULL DEFAULT '',
      chapters_json TEXT NOT NULL DEFAULT '[]',
      is_private INTEGER NOT NULL DEFAULT 0 CHECK(is_private IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS report_shares (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS report_shares_report ON report_shares(report_id);
  `);
  const reportColumns = database.prepare("PRAGMA table_info(reports)").all();
  if (!reportColumns.some((column) => column.name === "is_private")) {
    database.exec("ALTER TABLE reports ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0 CHECK(is_private IN (0, 1))");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
      immich_api_key TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS albums (
      immich_album_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      visibility TEXT NOT NULL DEFAULT 'private'
        CHECK(visibility IN ('private', 'shared', 'public')),
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS album_grants (
      immich_album_id TEXT NOT NULL REFERENCES albums(immich_album_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (immich_album_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS albums_owner ON albums(owner_id);
    CREATE INDEX IF NOT EXISTS albums_visibility ON albums(visibility);
  `);
  const albumColumns = database.prepare("PRAGMA table_info(albums)").all();
  if (!albumColumns.some((column) => column.name === "metadata_json")) {
    database.exec("ALTER TABLE albums ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
  }
  return database;
}
