import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, openSync, closeSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CONNECTOR_TOKEN_PATTERN } from "@zavi/shared/db-guard";
import { atomicWrite } from "./fsutil";
import { generatedKeyPath, readGeneratedKey, type ResolvedKey } from "./keys";

export const STATE_FILE = "state.enc";
const LOCK_FILE = "state.lock";
const MAGIC = Buffer.from("ZCS1", "ascii");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

const HASH = z.string().regex(/^[0-9a-f]{64}$/);

export const DatabaseConfig = z.object({
  dialect: z.enum(["postgres", "mysql", "mongodb"]),
  connection_string: z.string().min(1).max(4096),
  saved_at: z.string().max(40),
  source_instance_id: z.string().regex(/^[0-9a-f]{32}$/).optional(),
});
export type DatabaseConfig = z.infer<typeof DatabaseConfig>;

export const State = z.object({
  v: z.literal(1),
  token: z.string().regex(CONNECTOR_TOKEN_PATTERN).nullable().default(null),
  paired_code_hash: HASH.nullable().default(null),
  paired_at: z.string().max(40).nullable().default(null),
  admin_token_hash: HASH.nullable().default(null),
  admin_epoch: z.number().int().nonnegative().default(0),
  database: DatabaseConfig.nullable().default(null),
});
export type State = z.infer<typeof State>;

export const EMPTY_STATE: State = State.parse({ v: 1 });

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export function encryptState(key: Buffer, plaintext: Buffer): Buffer {
  if (key.length !== 32) throw new StoreError("The encryption key must be 32 bytes.");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(MAGIC);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ct]);
}

export function decryptState(key: Buffer, blob: Buffer): Buffer {
  if (blob.length < MAGIC.length + NONCE_BYTES + TAG_BYTES || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new StoreError("The state file is not a Zavi Connector state file.");
  }
  const nonce = blob.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES);
  const tag = blob.subarray(MAGIC.length + NONCE_BYTES, MAGIC.length + NONCE_BYTES + TAG_BYTES);
  const ct = blob.subarray(MAGIC.length + NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class Store {
  private readonly path: string;
  private readonly lockPath: string;
  private cache: { mtimeMs: number; size: number; ino: number; state: State } | null = null;

  private constructor(
    private readonly dataDir: string,
    private readonly key: Buffer,
  ) {
    this.path = join(dataDir, STATE_FILE);
    this.lockPath = join(dataDir, LOCK_FILE);
  }

  static open(dataDir: string, resolved: ResolvedKey, log: (msg: string) => void = () => undefined): Store {
    const store = new Store(dataDir, resolved.key);
    if (!existsSync(store.path)) return store;
    const blob = readFileSync(store.path);
    try {
      decryptState(resolved.key, blob);
      return store;
    } catch {
    }
    const old = resolved.source !== "generated" ? readGeneratedKey(dataDir) : null;
    if (old) {
      let plain: Buffer | null = null;
      try {
        plain = decryptState(old, blob);
      } catch {
        plain = null;
      }
      if (plain) {
        store.withLock(() => atomicWrite(store.path, encryptState(resolved.key, plain!)));
        rmSync(generatedKeyPath(dataDir), { force: true });
        log("Moved the stored secrets to the new encryption key and deleted the old key file from the data volume.");
        return store;
      }
    }
    throw new StoreError(
      "The stored secrets cannot be decrypted with the configured key. Start the connector with the key it was set up with, or remove the data volume and pair again.",
    );
  }

  read(): State {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(this.path);
    } catch {
      this.cache = null;
      return EMPTY_STATE;
    }
    const c = this.cache;
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size && c.ino === st.ino) return c.state;
    const raw = decryptState(this.key, readFileSync(this.path));
    const parsed = State.safeParse(JSON.parse(raw.toString("utf8")));
    if (!parsed.success) throw new StoreError("The stored state is not valid.");
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, state: parsed.data };
    return parsed.data;
  }

  update(fn: (s: State) => State): State {
    return this.withLock(() => {
      this.cache = null;
      const next = State.parse(fn(this.read()));
      atomicWrite(this.path, encryptState(this.key, Buffer.from(JSON.stringify(next), "utf8")));
      this.cache = null;
      return next;
    });
  }

  private withLock<T>(fn: () => T): T {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = openSync(this.lockPath, "wx", 0o600);
        writeSync(fd, `${process.pid}\n`);
        closeSync(fd);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) rmSync(this.lockPath, { force: true });
        } catch {
        }
        if (Date.now() > deadline) throw new StoreError("The state file is locked by another process.");
        sleepSync(20);
      }
    }
    try {
      return fn();
    } finally {
      rmSync(this.lockPath, { force: true });
    }
  }
}
