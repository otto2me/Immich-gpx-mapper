import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createBackupCipher, createBackupDecipher } from "./crypto.js";
import { ZipFile as ZipWriter } from "yazl";
import { open as openZip, type Entry, type ZipFile } from "yauzl";
import type { AppConfig } from "./config.js";
import { readSettings, validateSettings } from "./settings.js";

const archivePattern = /^mapper-(backup|safety)-\d{8}T\d{9}Z-[a-f0-9-]{36}\.zip$/;
const maxExtractedBytes = 4 * 1024 * 1024 * 1024;
const maxArchiveEntries = 20000;
const tables = ["app_settings", "tours", "comments", "reports", "report_shares", "users", "albums", "album_grants"];
type ArchiveFile = { path: string; size: number; sha256: string };
type Manifest = { format: string; version: number; createdAt: string; files: ArchiveFile[] };
type BackupState = { dirty: boolean; lastBackupAt: string | null; lastBackupName: string | null; lastError: string | null };
export type BackupInfo = { name: string; size: number; createdAt: string; kind: "backup" | "safety" };

function failure(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}

async function exists(path: string) {
  try { await access(path); return true; } catch { return false; }
}

async function checksum(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function uploadFiles(root: string, prefix = "uploads"): Promise<ArchiveFile[]> {
  if (!(await exists(root))) return [];
  const result: ArchiveFile[] = [];
  if ((await lstat(root)).isSymbolicLink()) failure("Symbolische Links sind im Datenverzeichnis nicht erlaubt");
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) failure("Symbolische Links sind im Datenverzeichnis nicht erlaubt");
    if (entry.isDirectory()) result.push(...await uploadFiles(path, `${prefix}/${entry.name}`));
    else if (entry.isFile()) result.push({ path: `${prefix}/${entry.name}`, size: (await stat(path)).size, sha256: await checksum(path) });
  }
  return result;
}

function zipOpen(path: string) {
  return new Promise<ZipFile>((resolveZip, reject) => {
    openZip(path, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("Ungültiges ZIP")); else resolveZip(zip);
    });
  });
}

function safeArchivePath(name: string) {
  if (name.includes("\\") || name.includes(":")) return false;
  const parts = name.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  return ["manifest.json", "mapper.sqlite", "config.json", "key-encryption.key"].includes(name) ||
    (parts[0] === "uploads" && parts.length > 1);
}

async function encryptArchive(source: string, destination: string, passphrase: string) {
  const { header, cipher } = createBackupCipher(passphrase);
  const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  output.write(header);
  const appendTag = new Transform({
    transform(chunk, _encoding, callback) { callback(null, chunk); },
    flush(callback) {
      this.push(cipher.getAuthTag());
      callback();
    }
  });
  await pipeline(createReadStream(source), cipher, appendTag, output);
}

async function decryptArchive(source: string, destination: string, passphrase: string) {
  const size = (await stat(source)).size;
  const headerSize = 36;
  const tagSize = 16;
  if (size <= headerSize + tagSize) failure("Verschlüsselte Sicherung ist unvollständig");
  const file = await open(source, "r");
  const header = Buffer.alloc(headerSize);
  const tag = Buffer.alloc(tagSize);
  try {
    const first = await file.read(header, 0, headerSize, 0);
    const last = await file.read(tag, 0, tagSize, size - tagSize);
    if (first.bytesRead !== headerSize || last.bytesRead !== tagSize) failure("Verschlüsselte Sicherung ist unvollständig");
  } finally {
    await file.close();
  }
  const decipher = createBackupDecipher(header, passphrase);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(source, { start: headerSize, end: size - tagSize - 1 }),
      decipher,
      createWriteStream(destination, { flags: "wx", mode: 0o600 })
    );
  } catch (error) {
    await rm(destination, { force: true });
    throw Object.assign(new Error("Backup-Passphrase ist falsch oder die Sicherung ist beschädigt"), { cause: error });
  }
}

async function extractArchive(path: string, destination: string) {
  const zip = await zipOpen(path);
  const names = new Set<string>();
  let total = 0;
  let actual = 0;
  try {
    await new Promise<void>((complete, reject) => {
      zip.once("error", reject);
      zip.once("end", complete);
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          if (names.size >= maxArchiveEntries || names.has(entry.fileName) || !safeArchivePath(entry.fileName)) failure("ZIP enthält unzulässige oder doppelte Dateipfade");
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (mode === 0o120000 || mode === 0o040000 || entry.generalPurposeBitFlag & 1) failure("Links, Verzeichniseinträge und verschlüsselte ZIPs sind nicht erlaubt");
          total += entry.uncompressedSize;
          if (total > maxExtractedBytes || entry.fileName === "manifest.json" && entry.uncompressedSize > 8 * 1024 * 1024) failure("Entpackte Sicherung ist zu groß");
          names.add(entry.fileName);
          const target = resolve(destination, ...entry.fileName.split("/"));
          if (!target.startsWith(resolve(destination) + sep)) failure("Ungültiger ZIP-Pfad");
          await mkdir(dirname(target), { recursive: true });
          const input = await new Promise<import("node:stream").Readable>((accept, fail) => zip.openReadStream(entry, (error, stream) => {
            if (error || !stream) fail(error ?? new Error("ZIP-Datei kann nicht gelesen werden")); else accept(stream);
          }));
          const limiter = new Transform({ transform(chunk, _encoding, callback) {
            actual += chunk.length;
            callback(actual > maxExtractedBytes ? new Error("Entpackte Sicherung ist zu groß") : null, chunk);
          } });
          await pipeline(input, limiter, createWriteStream(target, { flags: "wx", mode: 0o600 }));
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
  if (!names.has("manifest.json") || !names.has("mapper.sqlite")) failure("ZIP ist keine vollständige Mapper-Sicherung");
  const manifest = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8")) as Manifest;
  if (manifest.format !== "immich-gpx-mapper" || manifest.version !== 2 || !Array.isArray(manifest.files) || manifest.files.length !== names.size - 1) failure("Unbekanntes Sicherungsformat");
  const verified = new Set<string>();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || file.path === "manifest.json" || !names.has(file.path) || verified.has(file.path)) failure("Unvollständiges Sicherungsmanifest");
    verified.add(file.path);
    const target = join(destination, ...file.path.split("/"));
    if ((await stat(target)).size !== file.size || await checksum(target) !== file.sha256) failure("Prüfsumme der Sicherung stimmt nicht");
  }
  if (names.has("config.json")) {
    const config = JSON.parse(await readFile(join(destination, "config.json"), "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) failure("Ungültige Dateikonfiguration");
    if (config.immichApiUrl !== undefined && typeof config.immichApiUrl !== "string" ||
      config.immichApiKey !== undefined && typeof config.immichApiKey !== "string") failure("Ungültige Immich-Dateikonfiguration");
  }
}

export async function recoverInterruptedRestore(database: DatabaseSync, config: AppConfig) {
  const dataDir = resolve(config.dataDir);
  const journalPath = join(dataDir, ".restore-journal.json");
  if (!(await exists(journalPath))) return;
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    id: string; work: string; targets: Array<{ target: string; old: string; hadOld: boolean }>
  };
  const allowed = [join(dataDir, "uploads"), resolve(config.configFile ?? join(dataDir, "config.json")), join(dataDir, "key-encryption.key")];
  if (!journal || typeof journal.id !== "string" || !Array.isArray(journal.targets) || journal.targets.length > 3 ||
      typeof journal.work !== "string" || dirname(journal.work) !== dataDir || !basename(journal.work).startsWith(".restore-")) {
    failure("Wiederherstellungsjournal ist ungültig; manuelle Prüfung erforderlich", 503);
  }
  for (const item of journal.targets) {
    if (!allowed.includes(item.target) || typeof item.old !== "string" || !item.old.startsWith(`${item.target}.before-`) || dirname(item.old) !== dirname(item.target)) {
      failure("Wiederherstellungsjournal enthält fremde Pfade", 503);
    }
  }
  const marker = database.prepare("SELECT value FROM app_settings WHERE key = 'restore_completed'").get() as { value: string } | undefined;
  const committed = marker?.value === journal.id;
  for (const item of [...journal.targets].reverse()) {
    if (committed) await rm(item.old, { recursive: true, force: true });
    else if (await exists(item.old)) {
      await rm(item.target, { recursive: true, force: true });
      await rename(item.old, item.target);
    } else if (!item.hadOld) await rm(item.target, { recursive: true, force: true });
  }
  await rm(journal.work, { recursive: true, force: true });
  await rm(journalPath);
}

export class BackupManager {
  private operation: "backup" | "restore" | null = null;
  private activeWrites = 0;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  private intervalTimer: ReturnType<typeof setInterval> | undefined;
  readonly backupDir: string;
  private dataDir: string;
  private configFile: string;
  private backupPassphrase: string;

  constructor(private database: DatabaseSync, config: AppConfig) {
    this.dataDir = resolve(config.dataDir);
    this.backupDir = resolve(config.backupDir ?? join(this.dataDir, "backups"));
    this.configFile = resolve(config.configFile ?? join(this.dataDir, "config.json"));
    this.backupPassphrase = config.backupPassphrase ?? "";
    if (this.backupPassphrase.length < 16) failure("BACKUP_PASSPHRASE muss mindestens 16 Zeichen lang sein", 500);
    const uploads = join(this.dataDir, "uploads");
    if (this.backupDir === this.dataDir || this.backupDir === uploads || this.backupDir.startsWith(uploads + sep)) failure("Sicherungsordner darf nicht DATA_DIR oder uploads sein");
  }

  private state(): BackupState {
    const row = this.database.prepare("SELECT value FROM app_settings WHERE key = 'backup_state'").get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : { dirty: false, lastBackupAt: null, lastBackupName: null, lastError: null };
  }

  private setState(state: BackupState) {
    this.database.prepare("INSERT INTO app_settings(key, value) VALUES('backup_state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(state));
  }

  status() { return { ...this.state(), operation: this.operation, directory: this.backupDir }; }
  isRestoring() { return this.operation === "restore"; }
  beginWrite() {
    if (this.operation) failure("Sicherung oder Wiederherstellung läuft; bitte erneut versuchen", 503);
    this.activeWrites++;
  }
  endWrite(changed: boolean) {
    this.activeWrites = Math.max(0, this.activeWrites - 1);
    if (changed) this.markChanged();
  }
  markChanged() {
    this.setState({ ...this.state(), dirty: true });
    if (["changes", "both"].includes(readSettings(this.database).backupMode)) {
      if (this.changeTimer) clearTimeout(this.changeTimer);
      this.changeTimer = setTimeout(() => { void this.tick(true); }, 30000);
      this.changeTimer.unref();
    }
  }
  start() {
    this.intervalTimer = setInterval(() => { void this.tick(false); }, 60000);
    this.intervalTimer.unref();
    if (this.state().dirty) this.markChanged();
  }
  stop() { if (this.changeTimer) clearTimeout(this.changeTimer); if (this.intervalTimer) clearInterval(this.intervalTimer); }

  async tick(change: boolean) {
    if (change) this.changeTimer = undefined;
    const settings = readSettings(this.database);
    const state = this.state();
    const intervalDue = ["interval", "both"].includes(settings.backupMode) &&
      (!state.lastBackupAt || Date.now() - Date.parse(state.lastBackupAt) >= settings.backupIntervalDays * 86400000);
    const changesDue = ["changes", "both"].includes(settings.backupMode) && state.dirty;
    if (this.operation || this.activeWrites || !(intervalDue || (change || !this.changeTimer) && changesDue)) return;
    try { await this.create(); } catch {}
  }

  async list(): Promise<BackupInfo[]> {
    await mkdir(this.backupDir, { recursive: true, mode: 0o700 });
    const files: BackupInfo[] = [];
    for (const name of await readdir(this.backupDir)) {
      if (!archivePattern.test(name)) continue;
      const info = await lstat(join(this.backupDir, name));
      if (info.isFile() && !info.isSymbolicLink()) files.push({ name, size: info.size, createdAt: info.mtime.toISOString(), kind: name.startsWith("mapper-safety-") ? "safety" : "backup" });
    }
    return files.sort((first, second) => second.createdAt.localeCompare(first.createdAt) || second.name.localeCompare(first.name));
  }

  async archivePath(name: string) {
    if (!archivePattern.test(name)) failure("Sicherung nicht gefunden", 404);
    const path = join(this.backupDir, name);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) failure("Sicherung nicht gefunden", 404);
    return path;
  }

  private async prune() {
    for (const old of (await this.list()).slice(readSettings(this.database).backupKeep)) await rm(join(this.backupDir, old.name));
  }

  private async makeArchive(kind: "backup" | "safety", prune: boolean) {
    await mkdir(this.backupDir, { recursive: true, mode: 0o700 });
    const work = await mkdtemp(join(this.dataDir, ".backup-"));
    const name = `mapper-${kind}-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID()}.zip`;
    const output = join(this.backupDir, name);
    try {
      const snapshot = join(work, "mapper.sqlite");
      await sqliteBackup(this.database, snapshot);
      const files: ArchiveFile[] = [{ path: "mapper.sqlite", size: (await stat(snapshot)).size, sha256: await checksum(snapshot) }];
      const keyPath = join(work, "key-encryption.key");
      await copyFile(join(this.dataDir, "key-encryption.key"), keyPath);
      files.push({ path: "key-encryption.key", size: (await stat(keyPath)).size, sha256: await checksum(keyPath) });
      if (await exists(this.configFile)) {
        if ((await lstat(this.configFile)).isSymbolicLink()) failure("Dateikonfiguration darf kein symbolischer Link sein");
        await copyFile(this.configFile, join(work, "config.json"));
        files.push({ path: "config.json", size: (await stat(join(work, "config.json"))).size, sha256: await checksum(join(work, "config.json")) });
      }
      files.push(...await uploadFiles(join(this.dataDir, "uploads")));
      if (files.length >= maxArchiveEntries || files.reduce((total, file) => total + file.size, 0) > maxExtractedBytes) failure("Mapper-Daten überschreiten die Sicherungsgrenze von 4 GiB");
      const manifest: Manifest = { format: "immich-gpx-mapper", version: 2, createdAt: new Date().toISOString(), files };
      const archive = new ZipWriter();
      const plainArchive = join(work, "backup.zip");
      const outputStream = createWriteStream(plainArchive, { flags: "wx", mode: 0o600 });
      archive.on("error", (error) => outputStream.destroy(error));
      const written = pipeline(archive.outputStream, outputStream);
      for (const file of files) archive.addFile(file.path.startsWith("uploads/") ? join(this.dataDir, ...file.path.split("/")) : join(work, file.path), file.path);
      archive.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json");
      archive.end();
      await written;
      await encryptArchive(plainArchive, `${output}.partial`, this.backupPassphrase);
      await rename(`${output}.partial`, output);
      this.setState({ dirty: false, lastBackupAt: manifest.createdAt, lastBackupName: name, lastError: null });
      if (prune) await this.prune();
      return (await this.list()).find((file) => file.name === name)!;
    } finally { await rm(work, { recursive: true, force: true }); await rm(`${output}.partial`, { force: true }); }
  }

  async create() {
    if (this.operation || this.activeWrites) failure("Andere Schreibvorgänge laufen; bitte erneut versuchen", 409);
    this.operation = "backup";
    try { return await this.makeArchive("backup", true); }
    catch (error) { this.setState({ ...this.state(), lastError: error instanceof Error ? error.message : "Sicherung fehlgeschlagen" }); throw error; }
    finally { this.operation = null; }
  }

  async restore(archive: string, passphrase: string) {
    if (this.operation || this.activeWrites) failure("Andere Schreibvorgänge laufen; bitte erneut versuchen", 409);
    this.operation = "restore";
    let work = "";
    let source: DatabaseSync | undefined;
    let attached = false;
    let transaction = false;
    let committed = false;
    let safetyName = "";
    const journalPath = join(this.dataDir, ".restore-journal.json");
    const restoreId = randomUUID();
    const swaps: Array<{ target: string; old: string; hadOld: boolean }> = [];
    try {
      work = await mkdtemp(join(this.dataDir, ".restore-"));
      const plainArchive = join(work, "backup.zip");
      await decryptArchive(archive, plainArchive, passphrase);
      await extractArchive(plainArchive, work);
      const restoredKeyPath = join(work, "key-encryption.key");
      source = new DatabaseSync(join(work, "mapper.sqlite"), { readOnly: true });
      source.exec("PRAGMA trusted_schema = OFF");
      const check = source.prepare("PRAGMA quick_check").get();
      if (!check || Object.values(check)[0] !== "ok" || source.prepare("PRAGMA foreign_key_check").all().length) failure("Sicherungsdatenbank ist beschädigt");
      const schema = source.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Array<{ name: string; type: string }>;
      if (schema.some((item) => item.type === "trigger" || item.type === "view" || item.type === "table" && !tables.includes(item.name))) failure("Unbekanntes Datenbankschema");
      for (const table of tables) {
        const current = this.database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
        const imported = source.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
        if (JSON.stringify(current) !== JSON.stringify(imported)) failure("Sicherung passt nicht zu dieser Programmversion");
      }
      const settings = source.prepare("SELECT value FROM app_settings WHERE key = 'settings'").get() as { value: string } | undefined;
      if (settings) validateSettings(JSON.parse(settings.value));
      const rows = source.prepare("SELECT gpx_file_path, komoot_map_image_path, elevation_profile_image_path FROM tours").all();
      for (const row of rows) for (const file of Object.values(row)) {
        if (file !== null && (typeof file !== "string" || basename(file) !== file || !(await exists(join(work, "uploads", file))))) failure("Sicherung enthält nicht alle verknüpften Uploads");
      }
      source.close(); source = undefined;
      const safety = await this.makeArchive("safety", false);
      safetyName = safety.name;
      this.database.prepare("ATTACH DATABASE ? AS restored").run(join(work, "mapper.sqlite")); attached = true;
      this.database.exec("BEGIN IMMEDIATE"); transaction = true;
      for (const table of [...tables].reverse()) this.database.exec(`DELETE FROM main.${table}`);
      for (const table of tables) this.database.exec(`INSERT INTO main.${table} SELECT * FROM restored.${table}`);
      if (this.database.prepare("PRAGMA main.foreign_key_check").all().length) failure("Wiederhergestellte Beziehungen sind ungültig");
      await mkdir(join(work, "uploads"), { recursive: true });
      const targets = [
        { source: join(work, "uploads"), target: join(this.dataDir, "uploads") },
        { source: restoredKeyPath, target: join(this.dataDir, "key-encryption.key") }
      ];
      if (await exists(join(work, "config.json"))) targets.push({ source: join(work, "config.json"), target: this.configFile });
      const plans = [];
      for (const item of targets) {
        await mkdir(dirname(item.target), { recursive: true });
        const old = `${item.target}.before-${randomUUID()}`;
        const hadOld = await exists(item.target);
        plans.push({ ...item, old, hadOld });
      }
      await writeFile(journalPath, JSON.stringify({ id: restoreId, work, targets: plans }), { flag: "wx", mode: 0o600 });
      this.database.prepare("INSERT INTO app_settings(key, value) VALUES('restore_completed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(restoreId);
      for (const item of plans) {
        const { old, hadOld } = item;
        if (hadOld) await rename(item.target, old);
        swaps.push({ target: item.target, old, hadOld });
        await rename(item.source, item.target);
      }
      this.database.exec("COMMIT"); transaction = false; committed = true;
      this.database.exec("DETACH DATABASE restored"); attached = false;
      this.setState({ dirty: true, lastBackupAt: safety.createdAt, lastBackupName: safety.name, lastError: null });
      for (const item of swaps) await rm(item.old, { recursive: true, force: true });
      swaps.length = 0;
      await rm(journalPath);
      await this.prune();
      return { restored: true, safetyBackup: safety.name, restartRequired: true };
    } catch (error) {
      if (committed) {
        return { restored: true, safetyBackup: safetyName, restartRequired: true,
          warning: "Daten wiederhergestellt; alte Arbeitsdateien oder Aufbewahrung konnten nicht vollständig bereinigt werden" };
      }
      if (transaction) this.database.exec("ROLLBACK");
      for (const item of swaps.reverse()) {
        await rm(item.target, { recursive: true, force: true });
        if (item.hadOld) await rename(item.old, item.target);
      }
      await rm(journalPath, { force: true });
      throw error;
    } finally {
      source?.close();
      if (attached) this.database.exec("DETACH DATABASE restored");
      if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined);
      this.operation = null;
    }
  }
}