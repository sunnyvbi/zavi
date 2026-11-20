import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { decryptState, encryptState, Store, STATE_FILE, StoreError } from "../store";
import { resolveKey, KeyError, generatedKeyPath } from "../keys";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zc-store-"));
});

const TOKEN = "zconn_" + "a".repeat(64);
const DB = { dialect: "postgres" as const, connection_string: "postgres://ro:s3cret-pw@db.internal:5432/app", saved_at: "2026-10-12T00:00:00.000Z" };
const noSecret = () => ({ secretFile: join(dir, "no-such-secret"), envKey: null, dataDir: dir });

describe("encrypted store", () => {
  it("round-trips the state and never writes the password in plain text", () => {
    const store = Store.open(dir, resolveKey(noSecret()));
    store.update((s) => ({ ...s, token: TOKEN, database: DB }));
    const again = Store.open(dir, resolveKey(noSecret()));
    expect(again.read().token).toBe(TOKEN);
    expect(again.read().database?.connection_string).toBe(DB.connection_string);
    const onDisk = readFileSync(join(dir, STATE_FILE));
    expect(onDisk.includes(Buffer.from("s3cret-pw"))).toBe(false);
    expect(onDisk.includes(Buffer.from(TOKEN))).toBe(false);
  });

  it("a tampered file fails to decrypt (auth tag)", () => {
    const key = randomBytes(32);
    const blob = encryptState(key, Buffer.from('{"v":1}'));
    const bad = Buffer.from(blob);
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0x01;
    expect(() => decryptState(key, bad)).toThrow();
    const badNonce = Buffer.from(blob);
    badNonce[5] = (badNonce[5] ?? 0) ^ 0x01;
    expect(() => decryptState(key, badNonce)).toThrow();
    expect(() => decryptState(randomBytes(32), blob)).toThrow();
    expect(decryptState(key, blob).toString()).toBe('{"v":1}');
  });

  it("two writes of the same state differ (fresh nonce per write)", () => {
    const store = Store.open(dir, resolveKey(noSecret()));
    store.update((s) => ({ ...s, token: TOKEN }));
    const a = readFileSync(join(dir, STATE_FILE));
    store.update((s) => s);
    const b = readFileSync(join(dir, STATE_FILE));
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(4, 16).equals(b.subarray(4, 16))).toBe(false);
  });

  it("writes 0600 atomically and leaves no temp or lock file behind", () => {
    const store = Store.open(dir, resolveKey(noSecret()));
    store.update((s) => ({ ...s, token: TOKEN }));
    expect(statSync(join(dir, STATE_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(generatedKeyPath(dir)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual(["key", STATE_FILE]);
  });

  it("a wrong key is a clear error, never an empty state", () => {
    const store = Store.open(dir, resolveKey(noSecret()));
    store.update((s) => ({ ...s, token: TOKEN }));
    writeFileSync(generatedKeyPath(dir), randomBytes(32).toString("hex"));
    expect(() => Store.open(dir, resolveKey(noSecret()))).toThrow(StoreError);
  });
});

describe("key sources", () => {
  it("Docker secret file beats env beats generated", () => {
    const secretFile = join(dir, "secret");
    const fileKey = randomBytes(32).toString("hex");
    const envKey = randomBytes(32).toString("hex");
    writeFileSync(secretFile, fileKey + "\n");
    const a = resolveKey({ secretFile, envKey, dataDir: dir });
    expect(a.source).toBe("docker_secret");
    expect(a.key.toString("hex")).toBe(fileKey);
    const b = resolveKey({ secretFile: join(dir, "missing"), envKey, dataDir: dir });
    expect(b.source).toBe("env");
    expect(b.key.toString("hex")).toBe(envKey);
    const c = resolveKey(noSecret());
    expect(c.source).toBe("generated");
    expect(resolveKey(noSecret()).key.equals(c.key)).toBe(true);
  });

  it("a malformed key is refused, not stretched or padded", () => {
    expect(() => resolveKey({ secretFile: join(dir, "missing"), envKey: "short", dataDir: dir })).toThrow(KeyError);
    const secretFile = join(dir, "secret");
    writeFileSync(secretFile, "not-hex");
    expect(() => resolveKey({ secretFile, envKey: null, dataDir: dir })).toThrow(KeyError);
  });

  it("moving from the generated key to a Docker secret re-encrypts and deletes the old key file", () => {
    const store = Store.open(dir, resolveKey(noSecret()));
    store.update((s) => ({ ...s, token: TOKEN, database: DB }));
    const secretFile = join(dir, "secret");
    writeFileSync(secretFile, randomBytes(32).toString("hex"));
    const moved = Store.open(dir, resolveKey({ secretFile, envKey: null, dataDir: dir }));
    expect(moved.read().database?.connection_string).toBe(DB.connection_string);
    expect(existsSync(generatedKeyPath(dir))).toBe(false);
  });
});
