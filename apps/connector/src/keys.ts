import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fchmodSync, fsyncSync, linkSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fsyncDir } from "./fsutil";

export type KeySource = "docker_secret" | "env" | "generated";
export type ResolvedKey = { key: Buffer; source: KeySource };

export const GENERATED_KEY_FILE = "key";
const HEX64 = /^[0-9a-fA-F]{64}$/;

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

function parseHexKey(raw: string, where: string): Buffer {
  const v = raw.trim();
  if (!HEX64.test(v)) throw new KeyError(`${where} must hold exactly 64 hex characters (create one with: openssl rand -hex 32).`);
  return Buffer.from(v, "hex");
}

export function generatedKeyPath(dataDir: string): string {
  return join(dataDir, GENERATED_KEY_FILE);
}

export function readGeneratedKey(dataDir: string): Buffer | null {
  const p = generatedKeyPath(dataDir);
  if (!existsSync(p)) return null;
  return parseHexKey(readFileSync(p, "utf8"), p);
}

function createGeneratedKey(dataDir: string): Buffer {
  const p = generatedKeyPath(dataDir);
  const tmp = join(dataDir, `.key.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const key = randomBytes(32);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, key.toString("hex") + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
  fsyncDir(dataDir);
  return readGeneratedKey(dataDir)!;
}

export function resolveKey(cfg: { secretFile: string; envKey: string | null; dataDir: string }): ResolvedKey {
  if (existsSync(cfg.secretFile)) {
    let raw: string;
    try {
      raw = readFileSync(cfg.secretFile, "utf8");
    } catch (e) {
      throw new KeyError(`The Docker secret ${cfg.secretFile} cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"}). It must be readable by the connector's user (uid 1000).`);
    }
    return { key: parseHexKey(raw, `The Docker secret ${cfg.secretFile}`), source: "docker_secret" };
  }
  if (cfg.envKey) return { key: parseHexKey(cfg.envKey, "ZAVI_SECRET_KEY"), source: "env" };
  return { key: readGeneratedKey(cfg.dataDir) ?? createGeneratedKey(cfg.dataDir), source: "generated" };
}

export const GENERATED_KEY_WARNING =
  "Accidental-plaintext protection only: the key is stored next to the data. Use a Docker secret for real protection.";
