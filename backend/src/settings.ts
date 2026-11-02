import type { DatabaseSync } from "node:sqlite";

export type AppSettings = {
  sharingEnabled: boolean;
  komootDefault: "embed" | "local";
  backupMode: "off" | "interval" | "changes" | "both";
  backupIntervalDays: number;
  backupKeep: number;
};

export const defaultSettings: AppSettings = {
  sharingEnabled: true,
  komootDefault: "embed",
  backupMode: "off",
  backupIntervalDays: 3,
  backupKeep: 10
};

export function validateSettings(value: unknown): AppSettings {
  const invalid = () => { throw Object.assign(new Error("Ungültige Einstellungen"), { statusCode: 400 }); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const input = value as Record<string, unknown>;
  if (typeof input.sharingEnabled !== "boolean") return invalid();
  if (input.komootDefault !== "embed" && input.komootDefault !== "local") return invalid();
  if (!["off", "interval", "changes", "both"].includes(String(input.backupMode))) return invalid();
  if (typeof input.backupIntervalDays !== "number" || !Number.isInteger(input.backupIntervalDays) || input.backupIntervalDays < 1 || input.backupIntervalDays > 365) return invalid();
  if (typeof input.backupKeep !== "number" || !Number.isInteger(input.backupKeep) || input.backupKeep < 1 || input.backupKeep > 365) return invalid();
  return {
    sharingEnabled: input.sharingEnabled, komootDefault: input.komootDefault,
    backupMode: input.backupMode as AppSettings["backupMode"],
    backupIntervalDays: input.backupIntervalDays, backupKeep: input.backupKeep
  };
}

export function readSettings(database: DatabaseSync) {
  const row = database.prepare("SELECT value FROM app_settings WHERE key = 'settings'").get() as { value: string } | undefined;
  return row ? validateSettings(JSON.parse(row.value)) : { ...defaultSettings };
}

export function writeSettings(database: DatabaseSync, value: unknown) {
  const settings = validateSettings(value);
  database.prepare("INSERT INTO app_settings(key, value) VALUES('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(settings));
  return settings;
}