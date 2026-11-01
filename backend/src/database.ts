import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";

export type Tour = {
  id: string;
  immich_album_id: string;
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
  return database;
}
