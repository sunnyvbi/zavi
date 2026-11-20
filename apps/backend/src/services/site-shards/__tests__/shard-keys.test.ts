import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openSealedShardKey, sealShardKey, sealedKvKeyStore, shardKeySecretName, workerSecretKeyStore } from "../shard-keys";

function kek() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    priv: { ...(privateKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "kek-1" },
    pub: { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "kek-1" },
  };
}
const SHARD_JWK = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "PRIVATE-D", kid: "zavi-gw-1" };

describe("shard private keys reach the signer only", () => {
  it("secret name matches S2's shardKeySecretName", () => {
    expect(shardKeySecretName("abcdefghijklmnopqrst")).toBe("SHARD_KEY_ABCDEFGHIJKLMNOPQRST");
  });

  it("sealed KV store: only the KEK private key opens it, bound to its shard ref", async () => {
    const k = kek();
    const m = new Map<string, string>();
    const store = sealedKvKeyStore({ kv: { get: async (x) => m.get(x) ?? null, put: async (x, v) => void m.set(x, v) }, kekPublicJwk: () => k.pub });
    await store.put("abcdefghijklmnopqrst", SHARD_JWK);
    const raw = m.get("shardkey:abcdefghijklmnopqrst") as string;
    expect(raw).not.toContain("PRIVATE-D");
    const sealed = JSON.parse(raw);
    expect(openSealedShardKey(k.priv, "abcdefghijklmnopqrst", sealed)).toEqual(SHARD_JWK);
    expect(() => openSealedShardKey(k.priv, "otherrefotherrefothe", sealed)).toThrow();
    expect(() => openSealedShardKey(kek().priv, "abcdefghijklmnopqrst", sealed)).toThrow();
    const ct = Buffer.from(sealed.ct, "base64url");
    ct[0] ^= 1;
    expect(() => openSealedShardKey(k.priv, "abcdefghijklmnopqrst", { ...sealed, ct: ct.toString("base64url") })).toThrow();
  });

  it("refuses a PRIVATE KEK in the backend and a malformed ref", () => {
    const k = kek();
    expect(() => sealShardKey(k.priv, "abcdefghijklmnopqrst", SHARD_JWK)).toThrow(/PUBLIC/);
    expect(() => sealShardKey(k.pub, "../x", SHARD_JWK)).toThrow(/ref/);
  });

  it("worker secret store never echoes the vendor response and needs its own token", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const store = workerSecretKeyStore({
      env: { CLOUDFLARE_ACCOUNT_ID: "acct", SITE_SIGNER_WORKER_NAME: "zavi-site-signer", CLOUDFLARE_SIGNER_API_TOKEN: "tok" },
      fetchFn: async (url, init) => (calls.push({ url, body: init.body }), { status: 500 }),
    });
    await expect(store.put("abcdefghijklmnopqrst", SHARD_JWK)).rejects.toThrow(/^signer secret put failed \(500\)$/);
    expect(JSON.parse(calls[0].body as string).name).toBe("SHARD_KEY_ABCDEFGHIJKLMNOPQRST");
    await expect(workerSecretKeyStore({ env: {} }).put("abcdefghijklmnopqrst", SHARD_JWK)).rejects.toThrow(/credentials missing/);
  });
});
