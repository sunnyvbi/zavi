import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { clearJwksCache } from "../jwt";
import { clearAnonCache, handle, hostKind, previewDomainOf } from "../worker";
import { HOST_A, NOW, REF, SHARD_URL, SITE_A, binding, decodeForwarded, harness, jsonReq, req, type Harness } from "./helpers";

const DOMAIN = "zavi-preview.dev";
const SECRET = "preview-secret";
const P1 = `${"a".repeat(26)}.${DOMAIN}`;
const P2 = `${"b".repeat(26)}.${DOMAIN}`;
const TEST_1 = "44444444-4444-4444-8444-444444444444";
const TEST_2 = "55555555-5555-4555-8555-555555555555";
const DEPLOY_1 = "d012345678-0a1b2c3d";
const DEPLOY_2 = "d987654321-4e5f6a7b";
const nowS = Math.floor(NOW / 1000);

function record(test_site_id: string, deploy_id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, hostname: HOST_A, test_site_id, deploy_id, exp: nowS + 900, shard_id: REF, shard_url: SHARD_URL, ...extra });
}

function cookie(host: string, deploy: string, exp = nowS + 600, secret = SECRET): string {
  const sig = createHmac("sha256", secret).update(`preview.${host}.${deploy}.${exp}`).digest("hex");
  return `__zavi_preview=${deploy}.${exp}.${sig}`;
}

const env = { PREVIEW_DOMAIN: DOMAIN, PREVIEW_HMAC_SECRET: SECRET };
const kv = () => ({ [`preview:${P1}`]: record(TEST_1, DEPLOY_1), [`preview:${P2}`]: record(TEST_2, DEPLOY_2) });
const run = (h: Harness, r: Request) => handle(r, h.env, { now: () => NOW, fetch: h.fetch });
const shardCalls = (h: Harness) => h.calls.filter((c) => c.url.startsWith(SHARD_URL));

beforeEach(() => {
  clearJwksCache();
  clearAnonCache();
});

describe("preview host classification", () => {
  it("only a single 26-char base32 label under the configured domain is a preview host", () => {
    expect(previewDomainOf({ PREVIEW_DOMAIN: " Zavi-Preview.Dev. " })).toBe(DOMAIN);
    expect(previewDomainOf({})).toBeNull();
    expect(hostKind(P1, DOMAIN)).toBe("preview");
    expect(hostKind(DOMAIN, DOMAIN)).toBe("reserved");
    expect(hostKind(`evil.${DOMAIN}`, DOMAIN)).toBe("reserved");
    expect(hostKind(`${"a".repeat(26)}.${"b".repeat(26)}.${DOMAIN}`, DOMAIN)).toBe("reserved");
    expect(hostKind(`${"a".repeat(25)}1.${DOMAIN}`, DOMAIN)).toBe("reserved");
    expect(hostKind(`${"a".repeat(26)}.evil-${DOMAIN}`, DOMAIN)).toBe("site");
    expect(hostKind(HOST_A, DOMAIN)).toBe("site");
    expect(hostKind(P1, null)).toBe("site");
  });
});

describe("preview host -> test site", () => {
  it("serves the TEST site's data (site id from the record) with a valid cookie, without Turnstile", async () => {
    const h = await harness({ kv: kv(), env: { ...env, TURNSTILE_SECRET: "ts" } });
    const res = await run(h, jsonReq(P1, "/api/data/bookings", "POST", { data: { n: 1 } }, { cookie: cookie(P1, DEPLOY_1), "idempotency-key": "idem-key-0123456789abcdef", origin: `https://${P1}` }));
    expect(res.status).toBe(201);
    expect(res.headers.get("x-zavi-turnstile")).toBe("skipped-not-configured");
    const [c] = shardCalls(h);
    expect(c.url).toBe(`${SHARD_URL}/rest/v1/rpc/create_record`);
    expect(decodeForwarded(c).payload.site_id).toBe(TEST_1);
    expect(h.signerCalls).toEqual([{ shard_id: REF, site_id: TEST_1 }]);
  });

  it("GET /api/site names the test site, never the live one", async () => {
    const h = await harness({ kv: kv(), env });
    const res = await run(h, req(P1, "/api/site", { headers: { cookie: cookie(P1, DEPLOY_1) } }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.site_id).toBe(TEST_1);
  });

  it("no cookie / forged / wrong-secret / expired / too-far-ahead cookies are 403 and reach nothing", async () => {
    const bad = [
      undefined,
      `__zavi_preview=${DEPLOY_1}.${nowS + 600}.${"0".repeat(64)}`,
      cookie(P1, DEPLOY_1, nowS + 600, "other-secret"),
      cookie(P1, DEPLOY_1, nowS - 1),
      cookie(P1, DEPLOY_1, nowS + 3600),
      `__zavi_preview=${DEPLOY_1}`,
    ];
    for (const c of bad) {
      const h = await harness({ kv: kv(), env });
      const res = await run(h, req(P1, "/api/data/bookings", c ? { headers: { cookie: c } } : {}));
      expect(res.status, String(c)).toBe(403);
      expect((await res.json()).error.code).toBe("preview_forbidden");
      expect(h.calls).toHaveLength(0);
      expect(h.signerCalls).toHaveLength(0);
    }
  });

  it("a cookie minted for another deploy of the same host is refused", async () => {
    const h = await harness({ kv: kv(), env });
    const res = await run(h, req(P1, "/api/data/bookings", { headers: { cookie: cookie(P1, DEPLOY_2) } }));
    expect(res.status).toBe(403);
    expect(h.signerCalls).toHaveLength(0);
  });

  it("swapping to another tenant's preview host with this host's cookie is refused", async () => {
    const h = await harness({ kv: kv(), env });
    for (const c of [cookie(P1, DEPLOY_1), cookie(P1, DEPLOY_2)]) {
      const res = await run(h, req(P2, "/api/data/bookings", { headers: { cookie: c } }));
      expect(res.status).toBe(403);
    }
    expect(h.calls).toHaveLength(0);
    expect(h.signerCalls).toHaveLength(0);
  });

  it("client headers, queries and bodies never choose the site", async () => {
    const h = await harness({ kv: kv(), env });
    const res = await run(h, req(P1, "/api/data/bookings", { headers: { cookie: cookie(P1, DEPLOY_1), "x-zavi-site": SITE_A, "x-forwarded-host": HOST_A } }));
    expect(res.status).toBe(200);
    expect(decodeForwarded(shardCalls(h)[0]).payload.site_id).toBe(TEST_1);
  });

  it("an expired record is 410 even while KV still holds it; a missing one is 404", async () => {
    const h = await harness({ kv: { [`preview:${P1}`]: record(TEST_1, DEPLOY_1, { exp: nowS }) }, env });
    const res = await run(h, req(P1, "/api/data/bookings", { headers: { cookie: cookie(P1, DEPLOY_1) } }));
    expect(res.status).toBe(410);
    expect((await res.json()).error.code).toBe("preview_expired");
    const h2 = await harness({ env });
    expect((await run(h2, req(P1, "/api/data/bookings", { headers: { cookie: cookie(P1, DEPLOY_1) } }))).status).toBe(404);
    expect(h.calls.length + h2.calls.length).toBe(0);
  });

  it("a malformed record (poisoned shard url, bad id, bad deploy, string exp) is 503 and fetches nothing", async () => {
    for (const extra of [{ shard_url: "https://evil.example.com" }, { test_site_id: "x" }, { deploy_id: "../d" }, { exp: String(nowS + 900) }, { v: 2 }]) {
      const h = await harness({ kv: { [`preview:${P1}`]: record(TEST_1, DEPLOY_1, extra) }, env });
      const res = await run(h, req(P1, "/api/data/bookings", { headers: { cookie: cookie(P1, DEPLOY_1) } }));
      expect(res.status, JSON.stringify(extra)).toBe(503);
      expect(h.calls).toHaveLength(0);
      expect(h.signerCalls).toHaveLength(0);
    }
  });

  it("a preview host never falls back to a planted host: record", async () => {
    const h = await harness({ kv: { [`host:${P1}`]: binding(SITE_A) }, env });
    const res = await run(h, req(P1, "/api/data/bookings", { headers: { cookie: cookie(P1, DEPLOY_1) } }));
    expect(res.status).toBe(404);
    expect(h.calls).toHaveLength(0);
  });

  it("a malformed host under the preview domain is 404 even when host: or preview: records exist for it", async () => {
    const evil = `evil.${DOMAIN}`;
    const h = await harness({ kv: { [`host:${evil}`]: binding(SITE_A), [`preview:${evil}`]: record(TEST_1, DEPLOY_1) }, env });
    for (const host of [evil, DOMAIN]) {
      const res = await run(h, req(host, "/api/data/bookings", { headers: { cookie: cookie(host, DEPLOY_1) } }));
      expect(res.status).toBe(404);
    }
    expect(h.calls).toHaveLength(0);
  });

  it("no PREVIEW_HMAC_SECRET = every preview request is refused (fail closed)", async () => {
    const h = await harness({ kv: kv(), env: { PREVIEW_DOMAIN: DOMAIN } });
    const res = await run(h, req(P1, "/api/data/bookings", { headers: { cookie: cookie(P1, DEPLOY_1) } }));
    expect(res.status).toBe(403);
  });
});

describe("live hostname is unaffected", () => {
  it("a live host serves its own site even with a planted preview: record and a valid-looking cookie", async () => {
    const h = await harness({ kv: { ...kv(), [`preview:${HOST_A}`]: record(TEST_1, DEPLOY_1) }, env });
    const res = await run(h, req(HOST_A, "/api/data/bookings", { headers: { cookie: cookie(HOST_A, DEPLOY_1) } }));
    expect(res.status).toBe(200);
    expect(decodeForwarded(shardCalls(h)[0]).payload.site_id).toBe(SITE_A);
    expect(h.signerCalls).toEqual([{ shard_id: REF, site_id: SITE_A }]);
  });

  it("live hosts need no preview cookie", async () => {
    const h = await harness({ kv: kv(), env });
    expect((await run(h, req(HOST_A, "/api/data/bookings"))).status).toBe(200);
  });
});
