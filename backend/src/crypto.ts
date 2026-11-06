import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const keyLength = 32;
const backupMagic = Buffer.from("IMGMAPB1");

export async function loadEncryptionKey(dataDir: string) {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, "key-encryption.key");
  try {
    await writeFile(path, randomBytes(keyLength), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const key = await readFile(path);
  if (key.length !== keyLength) throw new Error("Der Schlüssel im Datenverzeichnis ist ungültig");
  return key;
}

export function encryptSecret(value: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptSecret(value: string, key: Buffer) {
  const [version, encodedIv, encodedTag, encodedData, ...extra] = value.split(":");
  if (version !== "v1" || !encodedIv || !encodedTag || !encodedData || extra.length) {
    throw new Error("Verschlüsselter Schlüssel ist ungültig");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encodedIv, "base64url"));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedData, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

export function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { maxmem: 128 * 1024 * 1024 });
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string) {
  const [algorithm, encodedSalt, encodedHash, ...extra] = stored.split("$");
  if (algorithm !== "scrypt" || !encodedSalt || !encodedHash || extra.length) return false;
  const salt = Buffer.from(encodedSalt, "base64url");
  const expected = Buffer.from(encodedHash, "base64url");
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = scryptSync(password, salt, expected.length, { maxmem: 128 * 1024 * 1024 });
  return timingSafeEqual(actual, expected);
}

export function createBackupCipher(passphrase: string) {
  const salt = randomBytes(16);
  const derived = scryptSync(passphrase, salt, keyLength, { maxmem: 128 * 1024 * 1024 });
  const iv = randomBytes(12);
  return {
    header: Buffer.concat([backupMagic, salt, iv]),
    cipher: createCipheriv("aes-256-gcm", derived, iv)
  };
}

export function createBackupDecipher(header: Buffer, passphrase: string) {
  if (header.length !== 36 || !header.subarray(0, 8).equals(backupMagic)) {
    throw new Error("Sicherung ist nicht gültig verschlüsselt");
  }
  const salt = header.subarray(8, 24);
  const iv = header.subarray(24, 36);
  const derived = scryptSync(passphrase, salt, keyLength, { maxmem: 128 * 1024 * 1024 });
  return createDecipheriv("aes-256-gcm", derived, iv);
}
