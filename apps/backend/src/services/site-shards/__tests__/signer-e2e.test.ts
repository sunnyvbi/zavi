
import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { importJWK, jwtVerify, decodeProtectedHeader } from "jose";
import { sealedKvKeyStore, workerSecretKeyStore } from "../shard-keys";
import { ANON_TTL_S, clearUnsealedCache, handleSigner } from "../../../../../../infra/site-gateway/signer/src/signer";

const REF = "abcdefghijklmnopqrst";
const OTHER = "zyxwvutsrqponmlkjihg";
const SITE = "11111111-1111-4111-8111-111111111111";
const NOW = Date.UTC(2026, 9, 1, 12);

function p256(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    priv: { ...privateKey.export({ format: "jwk" }), kid },
    pub: { ...publicKey.export({ format: "jwk" }), kid },
  };
}
function shardJwk() {
  const k = p256("zavi-gw-5a5a5a5a-1759320000000");
  return { priv: { ...k.priv, alg: "ES256", use: "sig" }, pub: k.pub };
}
const mint = (shard_id = REF) =>
  new Request("https://signer.internal/mint-anon", { method: "POST", body: JSON.stringify({ shard_id, site_id: SITE }) });

async function verified(res: Response, pub: Record<string, unknown>) {
  expect(res.status).toBe(200);
  const { token, exp } = (await res.json()) as { token: string; exp: number };
  const { payload } = await jwtVerify(token, await importJWK(pub as never, "ES256"), { currentDate: new Date(NOW) });
  expect(decodeProtectedHeader(token)).toEqual({ alg: "ES256", typ: "JWT", kid: pub.kid });
  expect(Object.keys(payload).sort()).toEqual(["exp", "iat", "jti", "role", "site_id"]);
  expect(payload).toMatchObject({ role: "anon", site_id: SITE, exp: NOW / 1000 + ANON_TTL_S });
  expect(exp).toBe(NOW / 1000 + ANON_TTL_S);
}

function memKv() {
  const m = new Map<string, string>();
  let gets = 0;
  return {
    m,
    gets: () => gets,
    backend: { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) },
    worker: { get: async (k: string, _t: "text") => (gets++, m.get(k) ?? null) },
  };
}

beforeEach(() => clearUnsealedCache());

describe("signer key stores, provisioning output -> signer", () => {
  it("Worker-secret mode: the secret the backend PUTs is the one the signer reads", async () => {
    const key = shardJwk();
    const env: Record<string, unknown> = {};
    const store = workerSecretKeyStore({
      env: { CLOUDFLARE_ACCOUNT_ID: "a", SITE_SIGNER_WORKER_NAME: "zavi-site-signer", CLOUDFLARE_SIGNER_API_TOKEN: "t" },
      fetchFn: async (_url, init) => {
        const b = JSON.parse(init.body as string) as { name: string; text: string };
        env[b.name] = b.text;
        return { status: 200 };
      },
    });
    await store.put(REF, key.priv);
    await verified(await handleSigner(mint(), env, () => NOW), key.pub);
  });

  it("sealed-KV (KEK) mode: the signer opens the backend's sealed record with its KEK and mints the anon template", async () => {
    const kek = p256("kek-2026-10");
    const key = shardJwk();
    const kv = memKv();
    await sealedKvKeyStore({ kv: kv.backend, kekPublicJwk: () => kek.pub }).put(REF, key.priv);
    expect(kv.m.get(`shardkey:${REF}`)).not.toContain(String(key.priv.d));
    const env = { SITE_SIGNER_KEK: JSON.stringify(kek.priv), HOSTS: kv.worker };
    await verified(await handleSigner(mint(), env, () => NOW), key.pub);
    await verified(await handleSigner(mint(), env, () => NOW), key.pub);
    expect(kv.gets()).toBe(1);
    const later = NOW + 6 * 60_000;
    expect((await handleSigner(mint(), env, () => later)).status).toBe(200);
    expect(kv.gets()).toBe(2);
  });

  it("[malicious] sealed-KV mode refuses: another KEK, a record moved to another shard's slot, tampering, no record", async () => {
    const kek = p256("kek-2026-10");
    const key = shardJwk();
    const kv = memKv();
    await sealedKvKeyStore({ kv: kv.backend, kekPublicJwk: () => kek.pub }).put(REF, key.priv);
    const sealed = kv.m.get(`shardkey:${REF}`)!;

    const imposter = p256("kek-2026-10");
    expect((await handleSigner(mint(), { SITE_SIGNER_KEK: JSON.stringify(imposter.priv), HOSTS: kv.worker }, () => NOW)).status).toBe(500);
    clearUnsealedCache();
    const env = { SITE_SIGNER_KEK: JSON.stringify(kek.priv), HOSTS: kv.worker };
    kv.m.set(`shardkey:${OTHER}`, sealed);
    expect((await handleSigner(mint(OTHER), env, () => NOW)).status).toBe(500);
    const rec = JSON.parse(sealed) as { ct: string };
    const ct = Buffer.from(rec.ct, "base64url");
    ct[3] ^= 1;
    kv.m.set(`shardkey:${OTHER}`, JSON.stringify({ ...rec, ct: ct.toString("base64url") }));
    expect((await handleSigner(mint(OTHER), env, () => NOW)).status).toBe(500);
    kv.m.delete(`shardkey:${OTHER}`);
    expect((await handleSigner(mint(OTHER), env, () => NOW)).status).toBe(404);
    expect((await handleSigner(mint(), { HOSTS: kv.worker }, () => NOW)).status).toBe(404);
  });
});
