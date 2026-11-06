import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";

const envFile = [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "..", ".env")
].find(existsSync);
if (envFile) dotenv.config({ path: envFile });

type FileConfig = {
  immichApiUrl?: string;
  immichApiKey?: string;
};

export type AppConfig = {
  immichApiUrl: string;
  immichWebUrl: string | null;
  legacyImmichApiKey: string;
  initialAdminUsername: string;
  initialAdminPassword: string;
  backupPassphrase: string;
  dataDir: string;
  backupDir: string;
  configFile: string;
  port: number;
};

function readFileConfig(configFile: string): FileConfig {
  if (!existsSync(configFile)) {
    return {};
  }

  const parsed: unknown = JSON.parse(readFileSync(configFile, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${configFile}`);
  }

  const value = parsed as Record<string, unknown>;
  if (
    value.immichApiUrl !== undefined &&
    typeof value.immichApiUrl !== "string"
  ) {
    throw new Error("Config field immichApiUrl must be a string");
  }
  if (
    value.immichApiKey !== undefined &&
    typeof value.immichApiKey !== "string"
  ) {
    throw new Error("Config field immichApiKey must be a string");
  }

  return {
    immichApiUrl:
      typeof value.immichApiUrl === "string" ? value.immichApiUrl : undefined,
    immichApiKey:
      typeof value.immichApiKey === "string" ? value.immichApiKey : undefined
  };
}

function readImmichWebUrl() {
  const value = process.env.IMMICH_WEB_URL?.trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error();
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new Error("IMMICH_WEB_URL must be an absolute HTTP(S) URL");
  }
}

export function loadConfig(): AppConfig {
  const configFile = process.env.CONFIG_FILE ?? "/data/config.json";
  const fileConfig = readFileConfig(configFile);
  const port = Number(process.env.PORT ?? "3000");
  const initialAdminUsername = process.env.INITIAL_ADMIN_USERNAME?.trim() ?? "";
  const initialAdminPassword = process.env.INITIAL_ADMIN_PASSWORD ?? "";
  const backupPassphraseFile = process.env.BACKUP_PASSPHRASE_FILE ?? "/run/secrets/backup_passphrase";
  const backupPassphrase = process.env.BACKUP_PASSPHRASE ??
    (existsSync(backupPassphraseFile) ? readFileSync(backupPassphraseFile, "utf8").replace(/(?:\r?\n)+$/, "") : "");
  const dataDir = process.env.DATA_DIR ?? "/data";

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  if (backupPassphrase.length < 16) {
    throw new Error("BACKUP_PASSPHRASE must contain at least 16 characters");
  }

  return {
    immichApiUrl:
      process.env.IMMICH_API_URL ??
      fileConfig.immichApiUrl ??
      "http://immich-server:2283",
    immichWebUrl: readImmichWebUrl(),
    legacyImmichApiKey: process.env.IMMICH_API_KEY || fileConfig.immichApiKey || "",
    initialAdminUsername,
    initialAdminPassword,
    backupPassphrase,
    dataDir,
    backupDir: process.env.BACKUP_DIR ?? resolve(dataDir, "backups"),
    configFile,
    port
  };
}
