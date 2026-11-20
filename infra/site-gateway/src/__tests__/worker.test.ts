import { createHmac, createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { clearJwksCache, decodeJwt, verifyEs256 } from "../jwt";
import { brokerSigningString, clearAnonCache, handle, MAX_BODY_BYTES, TURNSTILE_VERIFY_URL } from "../worker";
import {
  BROKER, GW_KID, HOST_A, HOST_B, NOW, SHARD_URL, SITE_A, SITE_B, USER_A,
  REF, binding, decodeForwarded, fakeLimiter, harness, jsonReq, keys, req, sessionToken, type Harness,
} from "./helpers";

const ID = "33333333-3333-4333-8333-333333333333";
const IDEM = "idem-key-0123456789abcdef";
const now = () => NOW;

beforeEach(() => {
  clearJwksCache();
  clearAnonCache();
});

const run = (h: Harness, r: Request) => handle(r, h.env, { now, fetch: h.fetch });
const shardCalls = (h: Harness) => h.calls.filter((c) => c.url.startsWith(SHARD_URL));
const brokerCalls = (h: Harness) => h.calls.filter((c) => c.url.startsWith(BROKER));
const created = () => new Response(JSON.stringify({ id: ID, replayed: false }), { status: 200 });

describe("hostname binding", () => {
  it("resolves the site from the hostname and forwards to the shard RPC with the api profile", async () => {
    const h = await harness();
    const res = await run(h, req(HOST_A, `/api/data/products?filter=${encodeURIComponent(JSON.stringify({ category: "shoes" }))}&limit=10`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { items: [], next_cursor: null } });
    const [c] = shardCalls(h);
    expect(c.url).toBe(`${SHARD_URL}/rest/v1/rpc/list_records`);
    expect(c.method).toBe("POST");
    expect(c.headers["content-profile"]).toBe("api");
    expect(c.headers.apikey).toBe("sb_publishable_test");
    expect(c.body).toEqual({ p_collection: "products", p_filter: { category: "shoes" }, p_limit: 10, p_cursor: null, p_sort: null });
    expect(decodeForwarded(c).payload.site_id).toBe(SITE_A);
    expect(h.signerCalls).toEqual([{ shard_id: REF, site_id: SITE_A }]);
  });

  it("the same path on another hostname is bound to that hostname's site", async () => {
    const h = await harness();
    await run(h, req(HOST_B, "/api/data/products"));
    expect(decodeForwarded(shardCalls(h)[0]).payload.site_id).toBe(SITE_B);
  });

  it("host lookup is case-insensitive and ignores a trailing dot", async () => {
    const h = await harness();
    expect((await run(h, req("ALPHA.zaviagent.com.", "/api/data/products"))).status).toBe(200);
  });

  it("unknown host is 404 in the error envelope and never reaches a shard", async () => {
    const h = await harness();
    const res = await run(h, req("nobody.zaviagent.com", "/api/data/products", { headers: { "cf-ray": "ray-1" } }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "site_not_found", message: "This site does not exist.", request_id: "ray-1" } });
    expect(h.calls).toHaveLength(0);
    expect(h.signerCalls).toHaveLength(0);
  });

  it("a published static site without a database binding is 404", async () => {
    const h = await harness({ kv: { [`host:${HOST_A}`]: JSON.stringify({ deploy_id: "d1", spa: true }) } });
    const res = await run(h, req(HOST_A, "/api/data/products"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("site_has_no_database");
  });

  it("only `active` is served: paused, suspended, deleting, tombstoned are 503", async () => {
    for (const status of ["paused", "suspended", "deleting", "tombstoned"]) {
      const h = await harness({ kv: { [`host:${HOST_A}`]: binding(SITE_A, { status }) } });
      const res = await run(h, req(HOST_A, "/api/data/products"));
      expect(res.status, status).toBe(503);
      expect((await res.json()).error.code).toBe(`site_${status}`);
      expect(h.calls).toHaveLength(0);
    }
  });

  it("a malformed binding (wrong version, bad uuid, poisoned shard url) is 503 and nothing is fetched", async () => {
    for (const extra of [{ v: 2 }, { site_id: "not-a-uuid" }, { shard_url: "https://evil.example.com" }, { shard_url: "https://abcdefghijklmnopqrst.supabase.co.evil.com" }, { shard_id: "../x" }, { shard_id: "s001" }, { shard_id: "zyxwvutsrqponmlkjihg" }, { shard_id: "zyxwvutsrqponmlkjihg", shard_url: "https://zyxwvutsrqponmlkjihg.supabase.co.evil.com" }]) {
      const h = await harness({ kv: { [`host:${HOST_A}`]: binding(SITE_A, extra) } });
      const res = await run(h, req(HOST_A, "/api/data/products"));
      expect(res.status, JSON.stringify(extra)).toBe(503);
      expect(h.calls).toHaveLength(0);
    }
  });

  it("missing shard apikey record is 503", async () => {
    const h = await harness({ kv: { "shard:abcdefghijklmnopqrst": "" } });
    expect((await run(h, req(HOST_A, "/api/data/products"))).status).toBe(503);
  });

  it("route ownership: every non-/api path is refused here (static-host owns it)", async () => {
    const h = await harness();
    for (const p of ["/", "/index.html", "/api", "/apix/data/p", "/assets/app.js"]) {
      expect((await run(h, req(HOST_A, p))).status, p).toBe(404);
    }
    expect(h.calls).toHaveLength(0);
  });

  it("unknown or malformed routes are 404", async () => {
    const h = await harness();
    for (const [p, m] of [
      ["/api/data/Bad-Name", "GET"], ["/api/data/x/not-a-uuid", "GET"], ["/api/data/products", "PUT"],
      ["/api/collections/products", "GET"], ["/api/storage/photos/..%2F..%2Fother", "DELETE"],
      ["/api/storage/photos/upload-url", "GET"], ["/api/auth/admin", "POST"], ["/api/auth/login", "GET"],
      ["/api/data//x", "GET"],
    ]) {
      expect((await run(h, req(HOST_A, p, { method: m }))).status, `${m} ${p}`).toBe(404);
    }
    expect(h.calls).toHaveLength(0);
  });
});

describe("spoofed site identifiers are ignored", () => {
  it("x-zavi-site headers, a site_id in the body, and x-forwarded-host never change the forwarded site", async () => {
    const h = await harness();
    await run(h, req(HOST_A, "/api/data/products", { headers: { "x-zavi-site": SITE_B, "x-site-id": SITE_B, "x-forwarded-host": HOST_B } }));
    expect(decodeForwarded(shardCalls(h)[0]).payload.site_id).toBe(SITE_A);

    h.setResponse(created);
    await run(h, jsonReq(HOST_A, "/api/data/bookings", "POST", { data: { name: "x", site_id: SITE_B } }, { "idempotency-key": IDEM, "x-zavi-site": SITE_B }));
    const create = shardCalls(h).at(-1)!;
    expect(decodeForwarded(create).payload.site_id).toBe(SITE_A);
    expect(JSON.stringify(create.headers)).not.toContain(SITE_B);
    expect(h.signerCalls.every((b) => JSON.stringify(b) === JSON.stringify({ shard_id: REF, site_id: SITE_A }))).toBe(true);
  });

  it("?site_id= is refused, not silently ignored", async () => {
    const h = await harness();
    expect((await run(h, req(HOST_A, `/api/data/products?site_id=${SITE_B}`))).status).toBe(400);
  });

  it("the client's apikey header never reaches the shard", async () => {
    const h = await harness();
    await run(h, req(HOST_A, "/api/data/products", { headers: { apikey: "service_role_from_client" } }));
    expect(shardCalls(h)[0].headers.apikey).toBe("sb_publishable_test");
  });
});

describe("anon token (from the signer)", () => {
  it("pinned template: ES256 + kid + typ; {role:anon, site_id, iat, exp, jti}; no sub/aud/iss; exp-iat <= 300", async () => {
    const h = await harness();
    await run(h, req(HOST_A, "/api/data/products"));
    const fwd = decodeForwarded(shardCalls(h)[0]);
    expect(fwd.header).toEqual({ alg: "ES256", typ: "JWT", kid: GW_KID });
    expect(Object.keys(fwd.payload).sort()).toEqual(["exp", "iat", "jti", "role", "site_id"]);
    expect(fwd.payload.role).toBe("anon");
    expect(fwd.payload.site_id).toBe(SITE_A);
    expect(fwd.payload.iat).toBe(Math.floor(NOW / 1000));
    const ttl = (fwd.payload.exp as number) - (fwd.payload.iat as number);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
    const k = await keys();
    expect(await verifyEs256(k.gw.pub, decodeJwt(fwd.raw)!)).toBe(true);
    expect(await verifyEs256(k.rogue.pub, decodeJwt(fwd.raw)!)).toBe(false);
  });

  it("the anon token is cached per site, not per request", async () => {
    const h = await harness();
    await run(h, req(HOST_A, "/api/data/products"));
    await run(h, req(HOST_A, "/api/data/products"));
    await run(h, req(HOST_B, "/api/data/products"));
    expect(h.signerCalls).toHaveLength(2);
  });

  it("a signer response that is not this site's anon token is refused", async () => {
    const h = await harness();
    const userTok = await sessionToken({});
    h.env.SIGNER = { fetch: async () => new Response(JSON.stringify({ token: userTok, exp: Math.floor(NOW / 1000) + 100 }), { status: 200 }) };
    expect((await run(h, req(HOST_A, "/api/data/products"))).status).toBe(503);
    expect(shardCalls(h)).toHaveLength(0);
  });

  it("signer down is 503", async () => {
    const h = await harness();
    h.env.SIGNER = { fetch: async () => new Response("{}", { status: 500 }) };
    expect((await run(h, req(HOST_A, "/api/data/products"))).status).toBe(503);
  });
});

describe("signed-in users: native token forwarded unchanged", () => {
  it("a valid shard Auth token for this site is forwarded byte-for-byte; the signer is not called", async () => {
    const h = await harness();
    const session = await sessionToken({});
    const res = await run(h, req(HOST_A, "/api/data/products", { headers: { authorization: `Bearer ${session}` } }));
    expect(res.status).toBe(200);
    expect(shardCalls(h)[0].headers.authorization).toBe(`Bearer ${session}`);
    expect(h.signerCalls).toHaveLength(0);
  });

  const bad: Array<[string, () => Promise<string>]> = [
    ["expired", () => sessionToken({ exp: Math.floor(NOW / 1000) - 1 })],
    ["no exp", () => sessionToken({ exp: undefined })],
    ["role anon", () => sessionToken({ role: "anon" })],
    ["role service_role", () => sessionToken({ role: "service_role" })],
    ["sub not a uuid", () => sessionToken({ sub: "admin" })],
    ["no site_id", () => sessionToken({ site_id: undefined })],
    ["unknown kid", () => sessionToken({}, { kid: "nope" })],
    ["signed by a rogue key under the real kid", async () => sessionToken({}, { key: (await keys()).rogue.key })],
    ["anon signer token presented as a session", async () => sessionToken({ role: "anon", sub: undefined }, { kid: GW_KID, key: (await keys()).gw.key })],
    ["alg none", async () => {
      const t = await sessionToken({});
      return `${btoa(JSON.stringify({ alg: "none", kid: "auth-s001" })).replace(/=+$/, "")}.${t.split(".")[1]}.`;
    }],
    ["garbage", async () => "not.a.jwt"],
  ];
  for (const [name, make] of bad) {
    it(`refuses: ${name} (401, nothing forwarded, no downgrade to anon)`, async () => {
      const h = await harness();
      const res = await run(h, req(HOST_A, "/api/data/products", { headers: { authorization: `Bearer ${await make()}` } }));
      expect(res.status).toBe(401);
      expect(shardCalls(h)).toHaveLength(0);
      expect(h.signerCalls).toHaveLength(0);
    });
  }

  it("a non-Bearer authorization header is 401, not anon", async () => {
    const h = await harness();
    expect((await run(h, req(HOST_A, "/api/data/products", { headers: { authorization: "Basic abc" } }))).status).toBe(401);
  });
});

describe("cross-site token replay", () => {
  it("a session from site A replayed on site B's hostname is refused; A's site_id is never forwarded", async () => {
    const h = await harness();
    const sessionA = await sessionToken({ site_id: SITE_A });
    for (const r of [
      req(HOST_B, "/api/data/products", { headers: { authorization: `Bearer ${sessionA}` } }),
      jsonReq(HOST_B, `/api/data/products/${ID}`, "PATCH", { patch: { x: 1 } }, { authorization: `Bearer ${sessionA}` }),
      req(HOST_B, `/api/data/products/${ID}`, { method: "DELETE", headers: { authorization: `Bearer ${sessionA}` } }),
      jsonReq(HOST_B, "/api/storage/photos/download-url", "POST", { name: "a.png" }, { authorization: `Bearer ${sessionA}` }),
    ]) {
      const res = await run(h, r);
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("session_wrong_site");
    }
    expect(shardCalls(h)).toHaveLength(0);
  });

  it("everything B's hostname forwards carries B's site_id", async () => {
    const h = await harness();
    await run(h, req(HOST_B, "/api/data/products"));
    await run(h, req(HOST_B, "/api/data/products", { headers: { authorization: `Bearer ${await sessionToken({ site_id: SITE_B })}` } }));
    expect(shardCalls(h).map((c) => decodeForwarded(c).payload.site_id)).toEqual([SITE_B, SITE_B]);
  });
});

describe("anonymous writes", () => {
  it("anon PATCH, DELETE and file delete are refused at the gateway and never forwarded", async () => {
    const h = await harness();
    const up = await run(h, jsonReq(HOST_A, `/api/data/bookings/${ID}`, "PATCH", { patch: { status: "x" } }));
    const del = await run(h, req(HOST_A, `/api/data/bookings/${ID}`, { method: "DELETE" }));
    const fdel = await run(h, req(HOST_A, "/api/storage/photos/a.png", { method: "DELETE" }));
    expect([up.status, del.status, fdel.status]).toEqual([401, 401, 401]);
    expect(shardCalls(h)).toHaveLength(0);
    expect(h.signerCalls).toHaveLength(0);
  });

  it("anon create requires a valid Idempotency-Key and passes it through", async () => {
    const h = await harness();
    h.setResponse(created);
    expect((await run(h, jsonReq(HOST_A, "/api/data/bookings", "POST", { data: { name: "a" } }))).status).toBe(400);
    expect((await run(h, jsonReq(HOST_A, "/api/data/bookings", "POST", { data: { name: "a" } }, { "idempotency-key": "short" }))).status).toBe(400);
    expect(shardCalls(h)).toHaveLength(0);
    const res = await run(h, jsonReq(HOST_A, "/api/data/bookings", "POST", { data: { name: "a" } }, { "idempotency-key": IDEM }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { id: ID, replayed: false } });
    expect(shardCalls(h)[0].body).toEqual({ p_collection: "bookings", p_data: { name: "a" }, p_idempotency_key: IDEM });
  });

  it("a replayed create is 200 with replayed=true", async () => {
    const h = await harness();
    h.setResponse(() => new Response(JSON.stringify({ id: ID, replayed: true }), { status: 200 }));
    const res = await run(h, jsonReq(HOST_A, "/api/data/bookings", "POST", { data: { name: "a" } }, { "idempotency-key": IDEM }));
    expect(res.status).toBe(200);
  });
});

describe("rate limits", () => {
  it("keys by site + IP + op, plus a per-site aggregate", async () => {
    const h = await harness();
    await run(h, req(HOST_A, "/api/data/products", { headers: { "cf-connecting-ip": "1.2.3.4" } }));
    expect((h.env.RL_READ as ReturnType<typeof fakeLimiter>).calls).toEqual([`${SITE_A}:1.2.3.4:list`]);
    expect((h.env.RL_SITE as ReturnType<typeof fakeLimiter>).calls).toEqual([SITE_A]);
  });

  it("over the per-IP write limit is 429 and nothing is forwarded; another IP keeps its budget", async () => {
    const h = await harness({ env: { RL_WRITE: fakeLimiter(2) } });
    h.setResponse(created);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await run(h, jsonReq(HOST_A, "/api/data/bookings", "POST", { data: { n: i } }, { "idempotency-key": `${IDEM}-${i}`, "cf-connecting-ip": "9.9.9.9" }))).status);
    }
    expect(statuses).toEqual([201, 201, 429]);
    expect(shardCalls(h)).toHaveLength(2);
    expect((await run(h, jsonReq(HOST_A, "/api/data/bookings", "POST", { data: { n: 9 } }, { "idempotency-key": `${IDEM}-x`, "cf-connecting-ip": "8.8.8.8" }))).status).toBe(201);
  });

  it("the per-site aggregate trips independently of IP", async () => {
    const h = await harness({ env: { RL_SITE: fakeLimiter(1) } });
    expect((await run(h, req(HOST_A, "/api/data/p", { headers: { "cf-connecting-ip": "1.1.1.1" } }))).status).toBe(200);
    const res = await run(h, req(HOST_A, "/api/data/p", { headers: { "cf-connecting-ip": "2.2.2.2" } }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("rate limits run before token verification (no JWKS fetch for a throttled caller)", async () => {
    const h = await harness({ env: { RL_READ: fakeLimiter(0) } });
    const res = await run(h, req(HOST_A, "/api/data/p", { headers: { authorization: `Bearer ${await sessionToken({})}` } }));
    expect(res.status).toBe(429);
    expect(h.calls).toHaveLength(0);
  });

  it("fails closed when a rate-limit binding is missing", async () => {
    const h = await harness({ env: { RL_SITE: undefined } });
    expect((await run(h, req(HOST_A, "/api/data/p"))).status).toBe(503);
    expect(shardCalls(h)).toHaveLength(0);
  });
});

describe("payload limits", () => {
  it("an oversize body is 413 by content-length and by streamed bytes", async () => {
    const h = await harness();
    expect((await run(h, jsonReq(HOST_A, "/api/data/bookings", "POST", { data: { blob: "x".repeat(MAX_BODY_BYTES) } }, { "idempotency-key": IDEM }))).status).toBe(413);
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 80; i++) c.enqueue(new TextEncoder().encode("x".repeat(1024)));
        c.close();
      },
    });
    const r2 = await run(h, new Request(`https://${HOST_A}/api/data/bookings`, {
      method: "POST", body: stream, headers: { "content-type": "application/json", "idempotency-key": IDEM }, duplex: "half",
    } as RequestInit));
    expect(r2.status).toBe(413);
    expect(shardCalls(h)).toHaveLength(0);
  });

  it("non-JSON is 415; a non-object document is 400", async () => {
    const h = await harness();
    expect((await run(h, req(HOST_A, "/api/data/b", { method: "POST", body: "a=1", headers: { "content-type": "application/x-www-form-urlencoded", "idempotency-key": IDEM } }))).status).toBe(415);
    expect((await run(h, jsonReq(HOST_A, "/api/data/b", "POST", [1, 2], { "idempotency-key": IDEM }))).status).toBe(400);
  });
});

describe("list query bounds", () => {
  const f = (v: unknown) => `filter=${encodeURIComponent(JSON.stringify(v))}`;
  it("refuses out-of-bounds or malformed list params before the shard", async () => {
    const h = await harness();
    for (const qs of [
      "limit=101", "limit=0", "limit=1.5", "sort=Name", "sort=--x", "sort=a;drop", "cursor=%25%25", `cursor=${"A".repeat(2000)}`,
      "filter=nope", f([1]), f({ a: 1, b: 2, c: 3, d: 4, e: 5 }), f({ Bad: 1 }), f({ a: { like: "%" } }), f({ a: { in: [] } }),
      f({ a: { in: Array(51).fill(1) } }), f({ a: { in: [{ x: 1 }] } }), f({ a: { eq: { nested: 1 } } }), f({ a: {} }), f({ a: null }),
      f({ a: "x".repeat(513) }), `filter=${encodeURIComponent("{" + " ".repeat(5000) + "}")}`,
      "where.a=1", "order=-created_at", "select=*", "limit=5&limit=6",
    ]) {
      expect((await run(h, req(HOST_A, `/api/data/products?${qs}`))).status, qs).toBe(400);
    }
    expect(shardCalls(h)).toHaveLength(0);
  });

  it("maps filter / sort / limit / cursor 1:1 to the RPC arguments", async () => {
    const h = await harness();
    const filter = { category: "shoes", price: { gte: 10, lt: 50 }, tag: { in: ["a", "b"] }, title: { prefix: "Ne" } };
    const cursor = btoa(JSON.stringify({ k: "-price", s: 10, t: "1700000000000000", i: ID }));
    const res = await run(h, req(HOST_A, `/api/data/products?${f(filter)}&sort=-price&limit=100&cursor=${encodeURIComponent(cursor)}`));
    expect(res.status).toBe(200);
    expect(shardCalls(h)[0].body).toEqual({ p_collection: "products", p_filter: filter, p_limit: 100, p_cursor: cursor, p_sort: "-price" });
  });
});

describe("turnstile", () => {
  it("skips when no secret is configured, and says so in a header", async () => {
    const h = await harness();
    h.setResponse(created);
    const res = await run(h, jsonReq(HOST_A, "/api/data/b", "POST", { data: { a: 1 } }, { "idempotency-key": IDEM }));
    expect(res.status).toBe(201);
    expect(res.headers.get("x-zavi-turnstile")).toBe("skipped-not-configured");
  });

  it("anon create: missing token 403; failed 403; token from another site's hostname 403; success forwards", async () => {
    const h = await harness({ env: { TURNSTILE_SECRET: "ts-secret" } });
    let verdict: Record<string, unknown> = { success: false, hostname: HOST_A };
    h.setResponse((c) => (c.url === TURNSTILE_VERIFY_URL ? new Response(JSON.stringify(verdict), { status: 200 }) : created()));
    const noToken = await run(h, jsonReq(HOST_A, "/api/data/b", "POST", { data: { a: 1 } }, { "idempotency-key": IDEM }));
    expect(noToken.status).toBe(403);
    expect((await noToken.json()).error.code).toBe("turnstile_required");

    const hdr = { "idempotency-key": IDEM, "x-zavi-turnstile-token": "tok", "cf-connecting-ip": "5.5.5.5" };
    expect((await run(h, jsonReq(HOST_A, "/api/data/b", "POST", { data: { a: 1 } }, hdr))).status).toBe(403);
    expect(h.calls.find((c) => c.url === TURNSTILE_VERIFY_URL)!.body).toMatchObject({ secret: "ts-secret", response: "tok", remoteip: "5.5.5.5" });
    verdict = { success: true, hostname: HOST_B };
    expect((await run(h, jsonReq(HOST_A, "/api/data/b", "POST", { data: { a: 1 } }, hdr))).status).toBe(403);
    verdict = { success: true };
    expect((await run(h, jsonReq(HOST_A, "/api/data/b", "POST", { data: { a: 1 } }, hdr))).status).toBe(403);
    expect(shardCalls(h)).toHaveLength(0);

    verdict = { success: true, hostname: HOST_A };
    const ok = await run(h, jsonReq(HOST_A, "/api/data/b", "POST", { data: { a: 1 } }, hdr));
    expect(ok.status).toBe(201);
    expect(ok.headers.get("x-zavi-turnstile")).toBe("verified");
  });

  it("signed-in creates skip turnstile; anon upload-url and auth signup require it", async () => {
    const h = await harness({ env: { TURNSTILE_SECRET: "ts-secret" } });
    h.setResponse(created);
    const res = await run(h, jsonReq(HOST_A, "/api/data/b", "POST", { data: { a: 1 } }, { authorization: `Bearer ${await sessionToken({})}` }));
    expect(res.status).toBe(201);
    expect(h.calls.some((c) => c.url === TURNSTILE_VERIFY_URL)).toBe(false);
    expect((await run(h, jsonReq(HOST_A, "/api/storage/photos/upload-url", "POST", { name: "a.png" }))).status).toBe(403);
    expect((await run(h, jsonReq(HOST_A, "/api/auth/signup", "POST", { email: "a@b.co" }))).status).toBe(403);
    expect(brokerCalls(h)).toHaveLength(0);
  });

  it("a site can opt out in its binding", async () => {
    const h = await harness({ env: { TURNSTILE_SECRET: "ts-secret" }, kv: { [`host:${HOST_A}`]: binding(SITE_A, { turnstile: false }) } });
    h.setResponse(created);
    const res = await run(h, jsonReq(HOST_A, "/api/data/b", "POST", { data: { a: 1 } }, { "idempotency-key": IDEM }));
    expect(res.status).toBe(201);
    expect(res.headers.get("x-zavi-turnstile")).toBe("skipped-not-configured");
  });
});

describe("CORS: same-origin only", () => {
  it("preflight from the own origin is allowed; any other origin is 403 without ACAO", async () => {
    const h = await harness();
    const ok = await run(h, req(HOST_A, "/api/data/b", { method: "OPTIONS", headers: { origin: `https://${HOST_A}` } }));
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(`https://${HOST_A}`);
    const evil = await run(h, req(HOST_A, "/api/data/b", { method: "OPTIONS", headers: { origin: `https://${HOST_B}` } }));
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("cross-origin requests (another Zavi site, http, null, cross-site fetch metadata) are refused before any upstream call", async () => {
    const h = await harness();
    for (const origin of [`https://${HOST_B}`, `http://${HOST_A}`, "null", "https://evil.example"]) {
      const res = await run(h, jsonReq(HOST_A, "/api/data/b", "POST", { data: { a: 1 } }, { origin, "idempotency-key": IDEM }));
      expect(res.status, origin).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect((await run(h, req(HOST_A, "/api/data/b", { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    expect((await run(h, jsonReq(HOST_A, "/api/auth/login", "POST", {}, { origin: `https://${HOST_B}` }))).status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("same-origin responses echo only the own origin and are no-store", async () => {
    const h = await harness();
    const res = await run(h, req(HOST_A, "/api/data/b", { headers: { origin: `https://${HOST_A}` } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(`https://${HOST_A}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("data routes map 1:1 to the api RPCs", () => {
  it("get / update / delete", async () => {
    const h = await harness();
    const auth = { authorization: `Bearer ${await sessionToken({})}` };
    h.setResponse(() => new Response("null", { status: 200 }));
    expect((await run(h, req(HOST_A, `/api/data/p/${ID}`))).status).toBe(404);
    h.setResponse(() => new Response(JSON.stringify({ id: ID, updated: true }), { status: 200 }));
    expect((await run(h, jsonReq(HOST_A, `/api/data/p/${ID}`, "PATCH", { patch: { a: null } }, auth))).status).toBe(200);
    expect((await run(h, req(HOST_A, `/api/data/p/${ID}`, { method: "DELETE", headers: auth }))).status).toBe(200);
    expect(shardCalls(h).map((c) => [c.url.split("/rpc/")[1], c.body])).toEqual([
      ["get_record", { p_collection: "p", p_id: ID }],
      ["update_record", { p_collection: "p", p_id: ID, p_patch: { a: null } }],
      ["delete_record", { p_collection: "p", p_id: ID }],
    ]);
  });

  it("maps facade errors to the envelope without leaking internals", async () => {
    const h = await harness();
    const cases: Array<[number, unknown, number, string]> = [
      [403, { code: "42501", message: "unknown_collection" }, 403, "unknown_collection"],
      [401, { code: "42501", message: "permission denied for table records" }, 403, "forbidden"],
      [400, { code: "22023", message: "filter_not_allowed" }, 400, "filter_not_allowed"],
      [404, { code: "P0002", message: "not_found" }, 404, "not_found"],
      [400, { code: "P0001", message: "quota_exceeded: max_records" }, 429, "quota_exceeded"],
      [500, { code: "XX000", message: "relation zsite.records secret detail" }, 502, "shard_error"],
    ];
    for (const [status, body, want, code] of cases) {
      h.setResponse(() => new Response(JSON.stringify(body), { status }));
      const res = await run(h, req(HOST_A, "/api/data/p"));
      expect(res.status, code).toBe(want);
      const out = await res.json();
      expect(out.error.code).toBe(code);
      expect(JSON.stringify(out)).not.toContain("zsite");
    }
  });
});

describe("storage: same-origin proxy URLs", () => {
  const signedDown = () => new Response(JSON.stringify({ signedURL: `/object/sign/site-files/${SITE_A}/photos/a.png?token=shardtok.d` }), { status: 200 });
  const signedUp = () => new Response(JSON.stringify({ url: `/object/upload/sign/site-files/${SITE_A}/photos/a.png?token=shardtok.u`, token: "shardtok.u" }), { status: 200 });
  const upReq = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    jsonReq(HOST_A, "/api/storage/photos/upload-url", "POST", { name: "a.png", content_type: "image/png", size: 4, upsert: false, ...body }, headers);

  it("download-url returns a same-origin path; the GET proxies the shard bytes with safe headers", async () => {
    const h = await harness();
    h.setResponse(signedDown);
    const res = await run(h, jsonReq(HOST_A, "/api/storage/photos/download-url", "POST", { name: "a.png" }));
    expect(res.status).toBe(200);
    const url = (await res.json()).data.url as string;
    expect(url.startsWith("/api/storage/photos/object/a.png?t=")).toBe(true);
    expect(shardCalls(h)[0].url).toBe(`${SHARD_URL}/storage/v1/object/sign/site-files/${SITE_A}/photos/a.png`);
    h.setResponse(() => new Response("PNG!", { status: 200, headers: { "content-type": "image/png", "content-length": "4" } }));
    const bytes = await run(h, req(HOST_A, url));
    expect(bytes.status).toBe(200);
    expect(await bytes.text()).toBe("PNG!");
    expect(bytes.headers.get("content-type")).toBe("image/png");
    expect(bytes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(bytes.headers.get("content-security-policy")).toContain("sandbox");
    expect(shardCalls(h).at(-1)!.url).toBe(`${SHARD_URL}/storage/v1/object/sign/site-files/${SITE_A}/photos/a.png?token=shardtok.d`);
  });

  it("a stored active type is never served as itself on the site origin", async () => {
    const h = await harness();
    h.setResponse(signedDown);
    const url = (await (await run(h, jsonReq(HOST_A, "/api/storage/photos/download-url", "POST", { name: "a.png" }))).json()).data.url;
    h.setResponse(() => new Response("<script>steal()</script>", { status: 200, headers: { "content-type": "text/html" } }));
    const res = await run(h, req(HOST_A, url));
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
  });

  it("upload-url returns a same-origin PUT; the PUT streams exactly the declared bytes to the shard", async () => {
    const h = await harness();
    h.setResponse(signedUp);
    const res = await run(h, upReq({}));
    expect(res.status).toBe(200);
    const t = (await res.json()).data as { url: string; method: string; headers: Record<string, string> };
    expect(t.method).toBe("PUT");
    expect(t.url.startsWith("/api/storage/photos/object/a.png?t=")).toBe(true);
    expect(t.headers).toEqual({ "content-type": "image/png" });
    expect(shardCalls(h)[0].url).toBe(`${SHARD_URL}/storage/v1/object/upload/sign/site-files/${SITE_A}/photos/a.png`);
    h.setResponse(() => new Response(JSON.stringify({ Key: "x" }), { status: 200 }));
    const put = await run(h, req(HOST_A, t.url, { method: "PUT", body: "abcd", headers: { "content-type": "image/png" } }));
    expect(put.status).toBe(200);
    const up = shardCalls(h).at(-1)!;
    expect(up.url).toBe(`${SHARD_URL}/storage/v1/object/upload/sign/site-files/${SITE_A}/photos/a.png?token=shardtok.u`);
    expect(up.method).toBe("PUT");
    expect(up.headers["content-type"]).toBe("image/png");
    expect(up.headers.authorization).toBeUndefined();
  });

  it("upload-url refuses active/unknown types, oversize, bad names, extra fields and anon upsert", async () => {
    const h = await harness();
    h.setResponse(signedUp);
    for (const [body, want] of [
      [{ content_type: "text/html" }, 415], [{ content_type: "image/svg+xml" }, 415], [{ content_type: "application/javascript" }, 415],
      [{ size: 10 * 1024 * 1024 + 1 }, 413], [{ size: 0 }, 413], [{ size: 1.5 }, 413],
      [{ name: "../x" }, 400], [{ name: `${SITE_B}/photos/a.png` }, 400], [{ prefix: SITE_B }, 400], [{ upsert: "yes" }, 400],
      [{ upsert: true }, 401],
    ] as Array<[Record<string, unknown>, number]>) {
      expect((await run(h, upReq(body))).status, JSON.stringify(body)).toBe(want);
    }
    expect(shardCalls(h)).toHaveLength(0);
  });

  it("the PUT refuses a wrong content type, a size mismatch, a tampered or expired token, and another path or site", async () => {
    const h = await harness();
    h.setResponse(signedUp);
    const url = ((await (await run(h, upReq({}))).json()).data.url) as string;
    const n = shardCalls(h).length;
    const put = (u: string, body: string, ct = "image/png", host = HOST_A) => run(h, req(host, u, { method: "PUT", body, headers: { "content-type": ct } }));
    expect((await put(url, "abcd", "text/html")).status).toBe(415);
    expect((await put(url, "abcdefgh")).status).toBe(413);
    expect((await put(url, "ab")).status).toBe(400);
    const [path, q] = url.split("?t=");
    const tok = decodeURIComponent(q);
    const tampered = tok.replace(/^./, (c) => (c === "e" ? "f" : "e"));
    expect((await put(`${path}?t=${encodeURIComponent(tampered)}`, "abcd")).status).toBe(403);
    expect((await put(url.replace("/object/a.png", "/object/b.png"), "abcd")).status).toBe(403);
    expect((await put(url.replace("/photos/", "/docs/"), "abcd")).status).toBe(403);
    expect((await put(url, "abcd", "image/png", HOST_B)).status).toBe(403);
    expect((await run(h, req(HOST_A, url))).status).toBe(403);
    expect(shardCalls(h)).toHaveLength(n);
    const later = await handle(req(HOST_A, url, { method: "PUT", body: "abcd", headers: { "content-type": "image/png" } }), h.env, { now: () => NOW + 601_000, fetch: h.fetch });
    expect(later.status).toBe(403);
  });

  it("storage names, prefixes and off-pattern signed responses are refused", async () => {
    const h = await harness();
    for (const n of ["..", ".hidden", `${SITE_B}/photos/a.png`, "a/b.png", ""]) {
      expect((await run(h, jsonReq(HOST_A, "/api/storage/photos/download-url", "POST", { name: n }))).status, n).toBe(400);
    }
    expect((await run(h, req(HOST_A, "/api/storage/Photos/list"))).status).toBe(404);
    expect(shardCalls(h)).toHaveLength(0);
    h.setResponse(() => new Response(JSON.stringify({ signedURL: "https://evil.example/x" }), { status: 200 }));
    expect((await run(h, jsonReq(HOST_A, "/api/storage/photos/download-url", "POST", { name: "a.png" }))).status).toBe(502);
  });

  it("list is scoped to the hostname's site prefix and returns the SDK's item shape", async () => {
    const h = await harness();
    h.setResponse(() => new Response(JSON.stringify([{ name: "a.png", created_at: "t", metadata: { size: 3, mimetype: "image/png" } }]), { status: 200 }));
    const res = await run(h, req(HOST_A, "/api/storage/photos/list"));
    expect(await res.json()).toEqual({ data: { items: [{ name: "a.png", size: 3, content_type: "image/png", created_at: "t" }] } });
    expect(shardCalls(h)[0].body).toMatchObject({ prefix: `${SITE_A}/photos/` });
    expect((await run(h, req(HOST_A, `/api/storage/photos/list?prefix=${SITE_B}`))).status).toBe(400);
  });

  it("storage RLS refusal maps to 403; signed-in delete goes through", async () => {
    const h = await harness();
    h.setResponse(() => new Response(JSON.stringify({ statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" }), { status: 400 }));
    expect((await run(h, upReq({}))).status).toBe(403);
    h.setResponse(() => new Response("{}", { status: 200 }));
    const del = await run(h, req(HOST_A, "/api/storage/photos/a.png", { method: "DELETE", headers: { authorization: `Bearer ${await sessionToken({})}` } }));
    expect(del.status).toBe(200);
    expect(shardCalls(h).at(-1)!.url).toBe(`${SHARD_URL}/storage/v1/object/site-files/${SITE_A}/photos/a.png`);
  });

  it("no storage proxy secret: 503", async () => {
    const h = await harness({ env: { STORAGE_PROXY_SECRET: undefined } });
    expect((await run(h, jsonReq(HOST_A, "/api/storage/photos/download-url", "POST", { name: "a.png" }))).status).toBe(503);
  });
});

describe("GET /api/site", () => {
  it("returns the hostname's site_id, cacheable, without a shard call or token", async () => {
    const h = await harness();
    const res = await run(h, req(HOST_A, "/api/site", { headers: { "x-zavi-site": SITE_B } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { site_id: SITE_A, turnstile_site_key: null } });
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(h.calls).toHaveLength(0);
    expect(h.signerCalls).toHaveLength(0);
    expect((await run(h, req(HOST_A, "/api/site", { method: "POST" }))).status).toBe(404);
    expect((await run(h, req("nobody.zaviagent.com", "/api/site"))).status).toBe(404);
  });
});

describe("auth proxy to the broker", () => {
  it("forwards with a signed site assertion the broker can verify; client site headers are not trusted", async () => {
    const h = await harness();
    h.setResponse(() => new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { "content-type": "application/json" } }));
    const body = { email: "a@b.co", password: "pw-123456" };
    const res = await run(h, jsonReq(HOST_A, "/api/auth/login", "POST", body, { "x-zavi-gw-site-id": SITE_B, "cf-connecting-ip": "7.7.7.7", "cf-ray": "r1" }));
    expect(res.status).toBe(200);
    const [c] = brokerCalls(h);
    expect(c.url).toBe(`${BROKER}/login`);
    expect(c.headers["x-zavi-gw-site-id"]).toBe(SITE_A);
    expect(c.headers["x-zavi-gw-host"]).toBe(HOST_A);
    const raw = new TextEncoder().encode(JSON.stringify(body));
    const expected = createHmac("sha256", "broker-secret").update(brokerSigningString({
      ts: Math.floor(NOW / 1000), request_id: "r1", site_id: SITE_A, host: HOST_A, shard_id: REF,
      method: "POST", action: "login", query: "", client_ip: "7.7.7.7", body_sha256: createHash("sha256").update(raw).digest("hex"),
    })).digest("hex");
    expect(c.headers["x-zavi-gw-sig"]).toBe(expected);
    expect(shardCalls(h)).toHaveLength(0);
  });

  it("callback is GET with the query forwarded; off-site redirects are refused", async () => {
    const h = await harness();
    h.setResponse(() => new Response(null, { status: 302, headers: { location: `https://${HOST_A}/account?x=1` } }));
    const res = await run(h, req(HOST_A, "/api/auth/callback?code=abc"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/account?x=1");
    expect(brokerCalls(h)[0].url).toBe(`${BROKER}/callback?code=abc`);
    h.setResponse(() => new Response(null, { status: 302, headers: { location: `https://${HOST_B}/steal` } }));
    expect((await run(h, req(HOST_A, "/api/auth/callback?code=abc"))).status).toBe(502);
  });

  it("a cross-site navigation to the callback (magic link from webmail) is allowed; other cross-site auth calls are not", async () => {
    const h = await harness();
    h.setResponse(() => new Response(null, { status: 302, headers: { location: "/" } }));
    expect((await run(h, req(HOST_A, "/api/auth/callback?code=abc", { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(302);
    expect((await run(h, jsonReq(HOST_A, "/api/auth/login", "POST", {}, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await run(h, req(HOST_A, "/api/auth/callback?code=abc", { headers: { origin: `https://${HOST_B}` } }))).status).toBe(403);
    expect(brokerCalls(h)).toHaveLength(1);
  });

  it("refuses when the broker secret is not configured", async () => {
    const h = await harness({ env: { BROKER_HMAC_SECRET: undefined } });
    expect((await run(h, jsonReq(HOST_A, "/api/auth/login", "POST", {}))).status).toBe(503);
  });
});
