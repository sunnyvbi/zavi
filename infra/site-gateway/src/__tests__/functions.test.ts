import { beforeEach, describe, expect, it } from "vitest";
import { clearJwksCache, decodeJwt } from "../jwt";
import { clearAnonCache, handle } from "../worker";
import { clearFnTokenCache, FD_METHOD_HEADER, FN_TOKEN_CACHE_S } from "../functions";
import { handleSigner, FN_TTL_S, fnSub } from "../../signer/src/signer";
import { FA, signAssertion, verifyInvocation, type AssertionMeta } from "../../../site-functions/src/shared";
import { GW_KID, HOST_A, HOST_B, NOW, REF, SHARD_URL, SITE_A, SITE_B, USER_A, decodeForwarded, fakeLimiter, harness, keys, req, sessionToken, type Harness } from "./helpers";

const DISPATCH_SECRET = "dispatch-secret-0123456789abcdef";
const ASSERT_SECRET = "assertion-secret-0123456789abcdef";
const OTHER_UID = "f0000000-0000-4000-8000-000000000002";
const now = () => NOW;
const enc = new TextEncoder();

beforeEach(() => {
  clearJwksCache();
  clearAnonCache();
  clearFnTokenCache();
});

async function fnHarness(opts: { principal?: Record<string, unknown> | null } = {}) {
  const dispatched: Request[] = [];
  const h = await harness({
    kv: opts.principal === null ? {} : { [`fnprincipal:${SITE_A}`]: JSON.stringify(opts.principal ?? { v: 1, shard_id: REF, admin_fns: ["stripe"] }) },
    env: {
      FN_DISPATCH_SECRET: DISPATCH_SECRET,
      FN_ASSERTION_SECRET: ASSERT_SECRET,
      RL_HOOK: fakeLimiter(),
      FUNCTIONS: { fetch: async (r: Request) => { dispatched.push(r); return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json", "set-cookie": "x=1" } }); } },
    },
  });
  const k = await keys();
  const signerEnv = { SHARD_KEY_ABCDEFGHIJKLMNOPQRST: JSON.stringify({ ...k.gw.priv, kid: GW_KID }), HOSTS: h.env.HOSTS };
  const signerCalls: unknown[] = [];
  h.env.SIGNER = { async fetch(r: Request) { signerCalls.push(await r.clone().json().catch(() => null)); return handleSigner(r, signerEnv, () => NOW); } };
  return { h, dispatched, signerCalls };
}

const run = (h: Harness, r: Request) => handle(r, h.env, { now, fetch: h.fetch });

async function assertionReq(host: string, path: string, method: string, body: unknown, meta: Partial<AssertionMeta> = {}, secret = ASSERT_SECRET) {
  const m: AssertionMeta = { v: 1, site_id: SITE_A, host: HOST_A, fn: "checkout", data: "function", invocation_id: "ray-9", ...meta };
  const bytes = body === undefined ? new Uint8Array(0) : enc.encode(JSON.stringify(body));
  const sig = await signAssertion(secret, m, method, path, bytes, NOW);
  return req(host, path, { method, headers: { "content-type": "application/json", "idempotency-key": "idem-key-0123456789abcdef", ...sig }, body: bytes.byteLength ? bytes : undefined });
}

describe("gateway: invoking site functions", () => {
  it("signs an http invocation for the hostname's site and strips credentials", async () => {
    const { h, dispatched } = await fnHarness();
    const res = await run(h, req(HOST_A, "/api/fn/checkout?plan=pro", { method: "POST", body: '{"qty":1}', headers: { "content-type": "application/json", cookie: "c=1", "x-zavi-fd-meta": "forged" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(dispatched).toHaveLength(1);
    const d = dispatched[0];
    expect(d.headers.get("cookie")).toBeNull();
    expect(d.headers.get(FD_METHOD_HEADER)).toBe("POST");
    const body = new Uint8Array(await d.arrayBuffer());
    const meta = await verifyInvocation(DISPATCH_SECRET, d.headers, "POST", body, NOW);
    expect(meta).toMatchObject({ site_id: SITE_A, host: HOST_A, kind: "http", name: "checkout", user: null, public_path: "/api/fn/checkout?plan=pro" });
    expect(new TextDecoder().decode(body)).toBe('{"qty":1}');
  });

  it("passes a verified signed-in user (session checked); a bad token is 401, never anonymous", async () => {
    const { h, dispatched } = await fnHarness();
    const tok = await sessionToken({ site_role: "user" });
    const ok = await run(h, req(HOST_A, "/api/fn/me", { method: "POST", body: "{}", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" } }));
    expect(ok.status).toBe(200);
    expect(h.sessionChecks).toHaveLength(1);
    const meta = await verifyInvocation(DISPATCH_SECRET, dispatched[0].headers, "POST", new Uint8Array(await dispatched[0].arrayBuffer()), NOW);
    expect(meta?.user).toEqual({ id: USER_A, role: "user" });
    expect(dispatched[0].headers.get("authorization")).toBeNull();

    const other = await sessionToken({ site_id: SITE_B });
    expect((await run(h, req(HOST_A, "/api/fn/me", { method: "POST", body: "{}", headers: { authorization: `Bearer ${other}` } }))).status).toBe(401);
    expect((await run(h, req(HOST_A, "/api/fn/me", { method: "POST", body: "{}", headers: { authorization: "Bearer junk" } }))).status).toBe(401);
    expect(dispatched).toHaveLength(1);
  });

  it("webhooks never carry a user even with a valid token, and are POST only", async () => {
    const { h, dispatched } = await fnHarness();
    const tok = await sessionToken({});
    expect((await run(h, req(HOST_A, "/api/hooks/stripe", { method: "POST", body: "evt", headers: { authorization: `Bearer ${tok}`, "stripe-signature": "t=1,v1=abc" } }))).status).toBe(200);
    const meta = await verifyInvocation(DISPATCH_SECRET, dispatched[0].headers, "POST", new Uint8Array(await dispatched[0].arrayBuffer()), NOW);
    expect(meta).toMatchObject({ kind: "webhook", name: "stripe", user: null });
    expect(dispatched[0].headers.get("stripe-signature")).toBe("t=1,v1=abc");
    expect(h.sessionChecks).toHaveLength(0);
    expect((await run(h, req(HOST_A, "/api/hooks/stripe", { method: "GET" }))).status).toBe(405);
  });

  it("a foreign Origin is refused before dispatch; bad names are 404", async () => {
    const { h, dispatched } = await fnHarness();
    expect((await run(h, req(HOST_A, "/api/fn/checkout", { method: "POST", headers: { origin: "https://evil.example" } }))).status).toBe(403);
    expect((await run(h, req(HOST_A, "/api/fn/Bad_Name", { method: "POST" }))).status).toBe(404);
    expect(dispatched).toHaveLength(0);
  });

  it("without the binding or secret it is 503, never served", async () => {
    const { h } = await fnHarness();
    h.env.FUNCTIONS = undefined;
    expect((await run(h, req(HOST_A, "/api/fn/checkout", { method: "POST" }))).status).toBe(503);
  });

  it("webhooks are rate-limited per site + hook, not per sender IP", async () => {
    const { h } = await fnHarness();
    const rl = fakeLimiter(1);
    h.env.RL_HOOK = rl;
    expect((await run(h, req(HOST_A, "/api/hooks/stripe", { method: "POST", body: "a", headers: { "cf-connecting-ip": "1.1.1.1" } }))).status).toBe(200);
    expect((await run(h, req(HOST_A, "/api/hooks/stripe", { method: "POST", body: "a", headers: { "cf-connecting-ip": "2.2.2.2" } }))).status).toBe(429);
    expect(rl.calls).toEqual([`${SITE_A}:hook:stripe`, `${SITE_A}:hook:stripe`]);
  });
});

describe("gateway: a function's data calls", () => {
  it("run as the site's function principal minted by the signer", async () => {
    const { h, signerCalls } = await fnHarness();
    const res = await run(h, await assertionReq(HOST_A, "/api/data/orders", "POST", { data: { total: 5 } }));
    expect(res.status).toBe(201);
    const [c] = h.calls.filter((x) => x.url.startsWith(SHARD_URL));
    const p = decodeForwarded(c).payload;
    expect(p).toMatchObject({ role: "authenticated", sub: await fnSub(SITE_A, "checkout"), site_id: SITE_A, zfn: "checkout", zfn_admin: false });
    expect("site_role" in p).toBe(false);
    expect((p.exp as number) - (p.iat as number)).toBe(FN_TTL_S);
    expect(c.body).toMatchObject({ p_collection: "orders", p_data: { total: 5 } });
    expect(signerCalls).toEqual([{ shard_id: REF, site_id: SITE_A, fn: "checkout", principal: "function" }]);
    expect(h.sessionChecks).toHaveLength(0);
  });

  it("a cached function token is re-validated with the signer after FN_TOKEN_CACHE_S (revocation lands fast)", async () => {
    const { h, signerCalls } = await fnHarness();
    let t = NOW;
    const go = async () => handle(await assertionReq(HOST_A, "/api/data/orders", "GET", undefined), h.env, { now: () => t, fetch: h.fetch });
    expect((await go()).status).toBe(200);
    t = NOW + 5_000;
    expect((await go()).status).toBe(200);
    expect(signerCalls).toHaveLength(1);
    delete h.kv[`fnprincipal:${SITE_A}`];
    t = NOW + (FN_TOKEN_CACHE_S + 1) * 1000;
    expect((await go()).status).toBe(503);
  });

  it("admin only for a function the manifest granted it", async () => {
    const { h } = await fnHarness();
    const ok = await run(h, await assertionReq(HOST_A, "/api/data/orders/33333333-3333-4333-8333-333333333333", "PATCH", { patch: { paid: true } }, { fn: "stripe", data: "admin" }));
    expect(ok.status).toBe(200);
    const p = decodeForwarded(h.calls.filter((x) => x.url.startsWith(SHARD_URL))[0]).payload;
    expect(p).toMatchObject({ sub: await fnSub(SITE_A, "stripe"), zfn: "stripe", zfn_admin: true });
    const denied = await run(h, await assertionReq(HOST_A, "/api/data/orders", "GET", undefined, { fn: "checkout", data: "admin" }));
    expect(denied.status).toBe(403);
  });

  it("functions not active on the site (no control-plane record): refused, never another identity", async () => {
    const { h } = await fnHarness({ principal: null });
    expect((await run(h, await assertionReq(HOST_A, "/api/data/orders", "GET", undefined))).status).toBe(503);
    expect((await run(h, await assertionReq(HOST_A, "/api/data/orders", "GET", undefined, { data: "admin" }))).status).toBe(503);
    expect(h.calls.filter((x) => x.url.startsWith(SHARD_URL))).toHaveLength(0);
  });

  it("a client token carrying function claims is refused, never forwarded", async () => {
    const { h } = await fnHarness();
    const forged = await sessionToken({ zfn: "stripe", zfn_admin: true });
    expect((await run(h, req(HOST_A, "/api/data/orders", { headers: { authorization: `Bearer ${forged}` } }))).status).toBe(401);
    expect(h.calls.filter((x) => x.url.startsWith(SHARD_URL))).toHaveLength(0);
  });

  it("refuses forged, cross-site, replayed-elsewhere and tampered assertions", async () => {
    const { h } = await fnHarness();
    expect((await run(h, await assertionReq(HOST_A, "/api/data/orders", "GET", undefined, {}, "nope-nope-nope-nope"))).status).toBe(401);
    const forA = await assertionReq(HOST_A, "/api/data/orders", "GET", undefined);
    expect((await run(h, new Request(`https://${HOST_B}/api/data/orders`, { headers: forA.headers }))).status).toBe(403);
    const b = await assertionReq(HOST_B, "/api/data/orders", "GET", undefined, { site_id: SITE_A, host: HOST_A });
    expect((await run(h, b)).status).toBe(403);
    const a = await assertionReq(HOST_A, "/api/data/orders", "GET", undefined);
    expect((await run(h, new Request(`https://${HOST_A}/api/data/secrets`, { headers: a.headers }))).status).toBe(401);
    const w = await assertionReq(HOST_A, "/api/data/orders", "POST", { data: { total: 5 } });
    expect((await run(h, new Request(w.url, { method: "POST", headers: w.headers, body: JSON.stringify({ data: { total: 0 } }) }))).status).toBe(401);
    expect((await run(h, req(HOST_A, "/api/data/orders", { headers: { [FA.meta]: "x" } }))).status).toBe(401);
    expect(h.calls.filter((x) => x.url.startsWith(SHARD_URL))).toHaveLength(0);
  });

  it("auth and member routes are refused to functions", async () => {
    const { h } = await fnHarness();
    expect((await run(h, await assertionReq(HOST_A, "/api/auth/login", "POST", { email: "a@b.c", password: "x" }))).status).toBe(403);
    expect((await run(h, await assertionReq(HOST_A, "/api/members/list", "GET", undefined))).status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("the signer refuses a principal record for another shard and never takes a caller sub", async () => {
    const k = await keys();
    const kv: Record<string, string> = { [`fnprincipal:${SITE_A}`]: JSON.stringify({ v: 1, shard_id: "zzzzzzzzzzzzzzzzzzzz" }) };
    const env = { SHARD_KEY_ABCDEFGHIJKLMNOPQRST: JSON.stringify({ ...k.gw.priv, kid: GW_KID }), HOSTS: { get: async (x: string) => kv[x] ?? null } };
    const mint = (b: unknown) => handleSigner(new Request("https://signer.internal/mint-fn", { method: "POST", body: JSON.stringify(b) }), env, now);
    expect((await mint({ shard_id: REF, site_id: SITE_A, fn: "checkout", principal: "function" })).status).toBe(404);
    expect((await mint({ shard_id: REF, site_id: SITE_A, fn: "checkout", principal: "function", sub: OTHER_UID })).status).toBe(400);
    expect((await mint({ shard_id: REF, site_id: SITE_A, fn: "checkout", principal: "service_role" })).status).toBe(400);
    kv[`fnprincipal:${SITE_A}`] = JSON.stringify({ v: 1, shard_id: REF, admin_fns: [] });
    const r = await mint({ shard_id: REF, site_id: SITE_A, fn: "checkout", principal: "function" });
    expect(r.status).toBe(200);
    const d = decodeJwt(((await r.json()) as { token: string }).token)!;
    expect(d.payload).toMatchObject({ sub: await fnSub(SITE_A, "checkout"), zfn: "checkout", zfn_admin: false });
    expect(await fnSub(SITE_A, "checkout")).not.toBe(await fnSub(SITE_A, "other"));
    expect(await fnSub(SITE_A, "checkout")).not.toBe(await fnSub(SITE_B, "checkout"));
    expect((await mint({ shard_id: REF, site_id: SITE_A, fn: "checkout", principal: "admin" })).status).toBe(403);
  });
});

describe("gateway: functions on a publish-gate preview host (S4a)", () => {
  const DOMAIN = "zavi-preview.dev";
  const P1 = `${"a".repeat(26)}.${DOMAIN}`;
  const TEST_1 = "44444444-4444-4444-8444-444444444444";
  const nowS = Math.floor(NOW / 1000);
  const previewRec = JSON.stringify({ v: 1, hostname: HOST_A, test_site_id: TEST_1, deploy_id: "d012345678-0a1b2c3d", exp: nowS + 900, shard_id: REF, shard_url: SHARD_URL });

  it("a function's signed data call reaches the TEST site without the browser cookie; a browser without it is still refused", async () => {
    const { h } = await fnHarness();
    h.kv[`preview:${P1}`] = previewRec;
    h.kv[`fnprincipal:${TEST_1}`] = JSON.stringify({ v: 1, shard_id: REF, admin_fns: [] });
    h.env.PREVIEW_DOMAIN = DOMAIN;
    h.env.PREVIEW_HMAC_SECRET = "preview-secret";
    const ok = await run(h, await assertionReq(P1, "/api/data/orders", "GET", undefined, { site_id: TEST_1, host: P1 }));
    expect(ok.status).toBe(200);
    expect(decodeForwarded(h.calls.filter((x) => x.url.startsWith(SHARD_URL))[0]).payload).toMatchObject({ site_id: TEST_1, zfn: "checkout" });
    expect((await run(h, await assertionReq(P1, "/api/data/orders", "GET", undefined, { site_id: SITE_A, host: P1 }))).status).toBe(403);
    expect((await run(h, req(P1, "/api/data/orders"))).status).toBe(403);
    expect((await run(h, req(P1, "/api/data/orders", { headers: { [FA.sig]: "a".repeat(64), [FA.ts]: String(nowS), [FA.meta]: "eyJ2IjoxfQ" } }))).status).toBe(401);
  });
});
