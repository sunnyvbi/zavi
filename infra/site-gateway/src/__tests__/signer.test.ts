import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeJwt, verifyEs256 } from "../jwt";
import { ANON_TTL_S, handleSigner } from "../../signer/src/signer";
import { GW_KID, NOW, REF, SITE_A, keys } from "./helpers";

async function env() {
  const k = await keys();
  return { SHARD_KEY_ABCDEFGHIJKLMNOPQRST: JSON.stringify({ ...k.gw.priv, kid: GW_KID }) };
}
const mint = (body: unknown, init: RequestInit = {}) =>
  new Request("https://signer.internal/mint-anon", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...init });

describe("signer worker", () => {
  it("mints exactly the anon template", async () => {
    const res = await handleSigner(mint({ shard_id: REF, site_id: SITE_A }), await env(), () => NOW);
    expect(res.status).toBe(200);
    const { token, exp } = (await res.json()) as { token: string; exp: number };
    const d = decodeJwt(token)!;
    expect(d.header).toEqual({ alg: "ES256", typ: "JWT", kid: GW_KID });
    expect(Object.keys(d.payload).sort()).toEqual(["exp", "iat", "jti", "role", "site_id"]);
    expect(d.payload).toMatchObject({ role: "anon", site_id: SITE_A, iat: NOW / 1000, exp: NOW / 1000 + ANON_TTL_S });
    expect(exp).toBe(NOW / 1000 + ANON_TTL_S);
    expect(ANON_TTL_S).toBeLessThanOrEqual(300);
    expect(await verifyEs256((await keys()).gw.pub, d)).toBe(true);
  });

  it("refuses any other role, claim, ttl or extra field", async () => {
    const e = await env();
    for (const body of [
      { shard_id: REF, site_id: SITE_A, role: "service_role" },
      { shard_id: REF, site_id: SITE_A, role: "authenticated" },
      { shard_id: REF, site_id: SITE_A, sub: "x" },
      { shard_id: REF, site_id: SITE_A, claims: { role: "service_role" } },
      { shard_id: REF, site_id: SITE_A, ttl: 86400 },
      { shard_id: REF, site_id: SITE_A, exp: 9999999999 },
      { shard_id: REF },
      { site_id: SITE_A },
      { shard_id: REF, site_id: "not-a-uuid" },
      { shard_id: "ABCDEFGHIJKLMNOPQRST", site_id: SITE_A },
      { shard_id: "../x", site_id: SITE_A },
      { shard_id: "s001", site_id: SITE_A },
      [SITE_A],
      "not json",
    ]) {
      const res = await handleSigner(mint(body), e, () => NOW);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("has exactly one operation", async () => {
    const e = await env();
    expect((await handleSigner(new Request("https://signer.internal/mint-anon"), e)).status).toBe(404);
    expect((await handleSigner(new Request("https://signer.internal/mint", { method: "POST", body: "{}" }), e)).status).toBe(404);
    expect((await handleSigner(new Request("https://signer.internal/mint-anon?role=authenticated", { method: "POST", body: JSON.stringify({ shard_id: REF, site_id: SITE_A }) }), e)).status).toBe(404);
  });

  it("unknown shard is 404; a key without kid is refused", async () => {
    expect((await handleSigner(mint({ shard_id: "zzzzzzzzzzzzzzzzzzzz", site_id: SITE_A }), await env())).status).toBe(404);
    const k = await keys();
    expect((await handleSigner(mint({ shard_id: REF, site_id: SITE_A }), { SHARD_KEY_ABCDEFGHIJKLMNOPQRST: JSON.stringify(k.gw.priv) })).status).toBe(500);
  });
});

describe("the public gateway holds no key material", () => {
  const root = join(__dirname, "..", "..");
  it("worker.ts never imports a signing function and reads no SHARD_KEY secret", () => {
    const src = readFileSync(join(root, "src", "worker.ts"), "utf8");
    expect(src).not.toMatch(/importSigningKey|signEs256|SHARD_KEY|service_role_key|SERVICE_ROLE/);
  });
  it("the gateway wrangler.toml binds the signer by service and declares no key secret; the signer has no route", () => {
    const gw = readFileSync(join(root, "wrangler.toml"), "utf8");
    expect(gw).toMatch(/\[\[services\]\][^[]*binding = "SIGNER"/);
    expect(gw).not.toMatch(/SHARD_KEY/);
    const signer = readFileSync(join(root, "signer", "wrangler.toml"), "utf8");
    expect(signer).toMatch(/workers_dev = false/);
    expect(signer).not.toMatch(/^\s*routes?\s*=|\[\[routes\]\]/m);
  });
});
