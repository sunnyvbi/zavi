import { createHash, createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { clearJwksCache } from "../jwt";
import { brokerSigningString, clearAnonCache, handle, TURNSTILE_VERIFY_URL } from "../worker";
import {
  BROKER, HOST_A, HOST_B, NOW, REF, SHARD_URL, SITE_A, SITE_B, USER_A,
  binding, decodeForwarded, harness, jsonReq, req, sessionToken, type Harness,
} from "./helpers";

const ID = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const IDEM = "idem-key-0123456789abcdef";
const now = () => NOW;

beforeEach(() => {
  clearJwksCache();
  clearAnonCache();
});

const run = (h: Harness, r: Request) => handle(r, h.env, { now, fetch: h.fetch });
const shardCalls = (h: Harness) => h.calls.filter((c) => c.url.startsWith(SHARD_URL));
const brokerCalls = (h: Harness) => h.calls.filter((c) => c.url.startsWith(BROKER));
const rpcs = (h: Harness) => shardCalls(h).filter((c) => c.url.includes("/rpc/")).map((c) => [c.url.split("/rpc/")[1], c.body]);
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const bearer = async (claims: Record<string, unknown> = {}) => ({ authorization: `Bearer ${await sessionToken(claims)}` });

describe("POST /api/data/:collection/:id/transition", () => {
  it("signed-in {to} -> transition_record; anonymous is refused before the shard", async () => {
    const h = await harness();
    h.setResponse(() => json({ id: ID, from: "pending", to: "accepted", transitioned: true }));
    const res = await run(h, jsonReq(HOST_A, `/api/data/requests/${ID}/transition`, "POST", { to: "accepted" }, await bearer()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: ID, from: "pending", to: "accepted", transitioned: true } });
    expect(rpcs(h)).toEqual([["transition_record", { p_collection: "requests", p_id: ID, p_to: "accepted" }]]);
    const anon = await run(h, jsonReq(HOST_A, `/api/data/requests/${ID}/transition`, "POST", { to: "accepted" }));
    expect(anon.status).toBe(401);
    expect((await anon.json()).error.code).toBe("sign_in_required");
    expect(shardCalls(h)).toHaveLength(1);
  });

  it("refuses bad bodies, extra keys, query params and other methods", async () => {
    const h = await harness();
    const auth = await bearer();
    for (const body of [{}, { to: "" }, { to: 3 }, { to: "x".repeat(65) }, { to: "a", site_id: SITE_B }, { state: "a" }, { to: "a\u0000b" }]) {
      const r = await run(h, jsonReq(HOST_A, `/api/data/requests/${ID}/transition`, "POST", body, auth));
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect((await run(h, jsonReq(HOST_A, `/api/data/requests/${ID}/transition?x=1`, "POST", { to: "a" }, auth))).status).toBe(400);
    expect((await run(h, jsonReq(HOST_A, `/api/data/requests/${ID}/transition`, "PATCH", { to: "a" }, auth))).status).toBe(404);
    expect((await run(h, jsonReq(HOST_A, `/api/data/requests/not-a-uuid/transition`, "POST", { to: "a" }, auth))).status).toBe(404);
    expect(shardCalls(h)).toHaveLength(0);
  });

  it("a compare-and-set transition carries expect / set to the kernel (shard 0013); bad shapes never reach it", async () => {
    const h = await harness();
    h.setResponse(() => json({ id: ID, from: "checkout_open", to: "paid", transitioned: true }));
    const auth = await bearer();
    const body = { to: "paid", expect: { checkout_session_id: "cs_1", amount_cents: 500 }, set: { paid_at: "2026-10-02T00:00:00Z" } };
    const res = await run(h, jsonReq(HOST_A, `/api/data/orders/${ID}/transition`, "POST", body, auth));
    expect(res.status).toBe(200);
    expect(rpcs(h)).toEqual([["transition_record", { p_collection: "orders", p_id: ID, p_to: "paid", p_expect: body.expect, p_set: body.set }]]);
    for (const bad of [{ to: "paid", expect: {} }, { to: "paid", set: [] }, { to: "paid", set: { "Bad-Key": 1 } }, { to: "paid", expect: "x" },
      { to: "paid", set: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, i])) }]) {
      const r = await run(h, jsonReq(HOST_A, `/api/data/orders/${ID}/transition`, "POST", bad, auth));
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect(shardCalls(h)).toHaveLength(1);
  });

  it("maps contract errors: an unauthorized or missing record is not_found; an illegal move is transition_conflict", async () => {
    const h = await harness();
    const auth = await bearer();
    h.setResponse(() => json({ code: "P0002", message: "not_found" }, 404));
    let r = await run(h, jsonReq(HOST_A, `/api/data/requests/${ID}/transition`, "POST", { to: "accepted" }, auth));
    expect([r.status, (await r.json()).error.code]).toEqual([404, "not_found"]);
    h.setResponse(() => json({ code: "55000", message: "transition_conflict" }, 400));
    r = await run(h, jsonReq(HOST_A, `/api/data/requests/${ID}/transition`, "POST", { to: "accepted" }, auth));
    expect([r.status, (await r.json()).error.code]).toEqual([409, "transition_conflict"]);
  });
});

describe("POST /api/actions/:name", () => {
  it("forward {target_id, data} and inverse {record_id} map to run_action with the Idempotency-Key", async () => {
    const h = await harness();
    h.setResponse(() => json({ action: "reserve_slot", target_id: ID, record_id: OTHER, counter: 1, replayed: false }));
    const auth = await bearer();
    const f = await run(h, jsonReq(HOST_A, "/api/actions/reserve_slot", "POST", { target_id: ID, data: { note: "hi" } }, { ...auth, "idempotency-key": IDEM }));
    expect(f.status).toBe(200);
    expect(await f.json()).toEqual({ data: { action: "reserve_slot", target_id: ID, record_id: OTHER, counter: 1, replayed: false } });
    const i = await run(h, jsonReq(HOST_A, "/api/actions/cancel_slot", "POST", { record_id: OTHER }, { ...auth, "idempotency-key": IDEM }));
    expect(i.status).toBe(200);
    expect(rpcs(h)).toEqual([
      ["run_action", { p_action: "reserve_slot", p_target_id: ID, p_record_id: null, p_data: { note: "hi" }, p_idempotency_key: IDEM }],
      ["run_action", { p_action: "cancel_slot", p_target_id: null, p_record_id: OTHER, p_data: {}, p_idempotency_key: IDEM }],
    ]);
  });

  it("requires a valid Idempotency-Key and exactly one body form", async () => {
    const h = await harness();
    const auth = await bearer();
    const noKey = await run(h, jsonReq(HOST_A, "/api/actions/reserve_slot", "POST", { target_id: ID, data: {} }, auth));
    expect([noKey.status, (await noKey.json()).error.code]).toEqual([400, "idempotency_key_required"]);
    expect((await run(h, jsonReq(HOST_A, "/api/actions/reserve_slot", "POST", { target_id: ID }, { ...auth, "idempotency-key": "short" }))).status).toBe(400);
    for (const body of [
      {}, { target_id: ID, record_id: OTHER }, { target_id: "nope" }, { record_id: OTHER, data: {} },
      { target_id: ID, data: [1] }, { target_id: ID, data: {}, recipient_id: USER_A }, { target_id: ID, site_id: SITE_B },
    ]) {
      const r = await run(h, jsonReq(HOST_A, "/api/actions/reserve_slot", "POST", body, { ...auth, "idempotency-key": IDEM }));
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect((await run(h, jsonReq(HOST_A, "/api/actions/Bad-Name", "POST", { target_id: ID }, { ...auth, "idempotency-key": IDEM }))).status).toBe(404);
    expect(shardCalls(h)).toHaveLength(0);
  });

  it("[malicious] anonymous actions need Turnstile and go out with the site's anon token", async () => {
    const h = await harness({ env: { TURNSTILE_SECRET: "ts-secret" } });
    let ok = false;
    h.setResponse((c) => (c.url === TURNSTILE_VERIFY_URL ? json({ success: ok, hostname: HOST_A }) : json({ counter: 1 })));
    const body = { target_id: ID, data: {} };
    const none = await run(h, jsonReq(HOST_A, "/api/actions/reserve_slot", "POST", body, { "idempotency-key": IDEM }));
    expect([none.status, (await none.json()).error.code]).toEqual([403, "turnstile_required"]);
    const failed = await run(h, jsonReq(HOST_A, "/api/actions/reserve_slot", "POST", body, { "idempotency-key": IDEM, "x-zavi-turnstile-token": "t" }));
    expect(failed.status).toBe(403);
    expect(rpcs(h)).toHaveLength(0);
    ok = true;
    const pass = await run(h, jsonReq(HOST_A, "/api/actions/reserve_slot", "POST", body, { "idempotency-key": IDEM, "x-zavi-turnstile-token": "t" }));
    expect(pass.status).toBe(200);
    const c = shardCalls(h).find((x) => x.url.endsWith("/rpc/run_action"))!;
    expect(decodeForwarded(c).payload).toMatchObject({ role: "anon", site_id: SITE_A });
    expect(h.sessionChecks).toHaveLength(0);
  });

  it("maps capacity / replay / permission errors", async () => {
    const h = await harness();
    const auth = { ...(await bearer()), "idempotency-key": IDEM };
    const cases: Array<[unknown, number, string]> = [
      [{ code: "55000", message: "action_bound" }, 409, "action_bound"],
      [{ code: "22023", message: "idempotency_conflict" }, 409, "idempotency_conflict"],
      [{ code: "42501", message: "action_not_allowed" }, 403, "action_not_allowed"],
      [{ code: "22023", message: "invalid_reference" }, 400, "invalid_reference"],
      [{ code: "22023", message: "invalid_action_input" }, 400, "invalid_action_input"],
      [{ code: "22023", message: "invalid_idempotency_key" }, 400, "invalid_idempotency_key"],
      [{ code: "53400", message: "recipient_rate_limited" }, 429, "recipient_rate_limited"],
      [{ code: "53400", message: "quota_exceeded: max_records" }, 429, "quota_exceeded"],
      [{ code: "23505", message: "unique_conflict" }, 409, "unique_conflict"],
      [{ code: "42501", message: "field_not_writable: booked_count" }, 403, "field_not_writable"],
      [{ code: "55000", message: "reference_restricted" }, 409, "reference_restricted"],
      [{ code: "54000", message: "cascade_too_large" }, 422, "cascade_too_large"],
      [{ code: "55000", message: "index_building" }, 503, "index_building"],
      [{ code: "XX000", message: "action_bound" }, 400, "request_failed"],
    ];
    for (const [body, status, code] of cases) {
      h.setResponse(() => json(body, 400));
      const r = await run(h, jsonReq(HOST_A, "/api/actions/reserve_slot", "POST", { target_id: ID, data: {} }, auth));
      const out = await r.json();
      expect([r.status, out.error.code], code).toEqual([status, code]);
      expect(JSON.stringify(out)).not.toContain("booked_count");
    }
  });
});

describe("POST /api/aggregates/:name", () => {
  it("signed-in {filter} -> aggregate; {} means no filter; anonymous is refused", async () => {
    const h = await harness();
    h.setResponse(() => json({ value: 7 }));
    const auth = await bearer();
    expect(await (await run(h, jsonReq(HOST_A, "/api/aggregates/booking_count", "POST", { filter: { slot_id: ID, status: "booked" } }, auth))).json()).toEqual({ data: { value: 7 } });
    await run(h, jsonReq(HOST_A, "/api/aggregates/booking_count", "POST", {}, auth));
    expect(rpcs(h)).toEqual([
      ["aggregate", { p_name: "booking_count", p_filter: { slot_id: ID, status: "booked" } }],
      ["aggregate", { p_name: "booking_count", p_filter: {} }],
    ]);
    const anon = await run(h, jsonReq(HOST_A, "/api/aggregates/booking_count", "POST", { filter: {} }));
    expect([anon.status, (await anon.json()).error.code]).toEqual([401, "sign_in_required"]);
  });

  it("refuses malformed filters and bodies; maps aggregate_too_large / aggregate_not_allowed", async () => {
    const h = await harness();
    const auth = await bearer();
    for (const body of [{ filter: [] }, { filter: { "bad-field": 1 } }, { filter: { a: { regex: "x" } } }, { filter: {}, x: 1 }, { where: {} }]) {
      expect((await run(h, jsonReq(HOST_A, "/api/aggregates/n", "POST", body, auth))).status, JSON.stringify(body)).toBe(400);
    }
    expect(shardCalls(h)).toHaveLength(0);
    h.setResponse(() => json({ code: "54000", message: "aggregate_too_large" }, 400));
    let r = await run(h, jsonReq(HOST_A, "/api/aggregates/n", "POST", { filter: {} }, auth));
    expect([r.status, (await r.json()).error.code]).toEqual([422, "aggregate_too_large"]);
    h.setResponse(() => json({ code: "42501", message: "aggregate_not_allowed" }, 403));
    r = await run(h, jsonReq(HOST_A, "/api/aggregates/n", "POST", { filter: {} }, auth));
    expect([r.status, (await r.json()).error.code]).toEqual([403, "aggregate_not_allowed"]);
  });
});

describe("session revocation is checked on every signed-in data request (strongly consistent)", () => {
  it("each signed-in call asks the shard's api.session_valid() with the caller's own token", async () => {
    const h = await harness();
    const auth = await bearer();
    await run(h, req(HOST_A, "/api/data/products", { headers: auth }));
    expect(h.sessionChecks).toHaveLength(1);
    expect(h.sessionChecks[0].headers.authorization).toBe(auth.authorization);
    expect(h.sessionChecks[0].headers["content-profile"]).toBe("api");
    await run(h, req(HOST_A, "/api/data/products"));
    expect(h.sessionChecks).toHaveLength(1);
  });

  it("[malicious] right after a password reset the old session is refused at once: reads return nothing, writes never run", async () => {
    const h = await harness();
    const auth = await bearer();
    h.sessionValid = () => json(false);
    h.setResponse(() => json({ items: [{ id: ID, data: { secret: 1 } }], next_cursor: null }));
    const read = await run(h, req(HOST_A, "/api/data/products", { headers: auth }));
    expect(read.status).toBe(401);
    const body = await read.json();
    expect(body.error.code).toBe("invalid_session");
    expect(JSON.stringify(body)).not.toContain("secret");
    const before = shardCalls(h).length;
    for (const r of [
      jsonReq(HOST_A, "/api/data/products", "POST", { data: { a: 1 } }, auth),
      jsonReq(HOST_A, `/api/data/products/${ID}`, "PATCH", { patch: { a: 1 } }, auth),
      req(HOST_A, `/api/data/products/${ID}`, { method: "DELETE", headers: auth }),
      jsonReq(HOST_A, `/api/data/requests/${ID}/transition`, "POST", { to: "accepted" }, auth),
      jsonReq(HOST_A, "/api/actions/reserve_slot", "POST", { target_id: ID, data: {} }, { ...auth, "idempotency-key": IDEM }),
      req(HOST_A, "/api/storage/photos/a.png", { method: "DELETE", headers: auth }),
    ]) {
      expect((await run(h, r)).status).toBe(401);
    }
    expect(shardCalls(h).length).toBe(before);
  });

  it("fails closed when the check cannot run (shard down / error / non-boolean)", async () => {
    for (const answer of [
      () => { throw new Error("down"); },
      () => json({ code: "XX000", message: "boom" }, 500),
      () => json("true"),
      () => json(null),
    ]) {
      const h = await harness();
      h.sessionValid = answer as never;
      const r = await run(h, jsonReq(HOST_A, "/api/data/products", "POST", { data: { a: 1 } }, await bearer()));
      expect([401, 503]).toContain(r.status);
      expect(shardCalls(h)).toHaveLength(0);
    }
  });

  it("[malicious] a signed-in user's file URL dies with their session (removal / reset), anonymous URLs do not need it", async () => {
    const h = await harness();
    h.setResponse((c) => {
      if (c.url.includes("/object/sign/") && c.method === "POST") return json({ signedURL: `/object/sign/site-files/${SITE_A}/photos/a.png?token=down.tok` });
      if (c.url.includes("/object/sign/")) return new Response("PNG!", { headers: { "content-type": "image/png" } });
      return json({});
    });
    const auth = await bearer({ session_started_at: 1700000000.5 });
    const r = await run(h, jsonReq(HOST_A, "/api/storage/photos/download-url", "POST", { name: "a.png" }, auth));
    const { url } = (await r.json()).data as { url: string };
    expect((await run(h, req(HOST_A, url))).status).toBe(200);
    const check = h.sessionChecks.at(-1)!;
    expect(check.url.endsWith("/rpc/session_valid_for")).toBe(true);
    expect(check.body).toEqual({ p_sub: USER_A, p_started: 1700000000.5 });
    expect(decodeForwarded(check).payload).toMatchObject({ role: "anon", site_id: SITE_A });
    h.sessionValid = () => json(false);
    const dead = await run(h, req(HOST_A, url));
    expect([dead.status, (await dead.json()).error.code]).toEqual([403, "invalid_file_token"]);
    h.sessionValid = () => { throw new Error("down"); };
    expect((await run(h, req(HOST_A, url))).status).toBe(503);
  });

  it("[malicious] a token without the hook's session_started_at claim is refused offline", async () => {
    const h = await harness();
    const r = await run(h, req(HOST_A, "/api/data/products", { headers: await bearer({ session_started_at: undefined }) }));
    expect(r.status).toBe(401);
    expect(h.sessionChecks).toHaveLength(0);
    expect(shardCalls(h)).toHaveLength(0);
  });
});

describe("/api/members/* -> auth broker", () => {
  const ok = () => json({ data: { email: "sam@x.com", role: "seller", status: "invited" } });

  it("requires a verified native token of THIS site before anything is forwarded", async () => {
    const h = await harness();
    h.setResponse(ok);
    const body = { email: "sam@x.com", role: "seller" };
    expect((await run(h, jsonReq(HOST_A, "/api/members/invite", "POST", body))).status).toBe(401);
    expect((await run(h, jsonReq(HOST_A, "/api/members/invite", "POST", body, { authorization: "Bearer not.a.jwt" }))).status).toBe(401);
    const cross = await run(h, jsonReq(HOST_A, "/api/members/invite", "POST", body, await bearer({ site_id: SITE_B })));
    expect([cross.status, (await cross.json()).error.code]).toEqual([401, "session_wrong_site"]);
    expect(brokerCalls(h)).toHaveLength(0);
  });

  it("forwards each op to `members-<op>` with the signed site assertion, the exact body and the user's token", async () => {
    const h = await harness();
    h.setResponse(ok);
    const auth = await bearer();
    const ops: Array<[string, string, unknown]> = [
      ["/api/members/invite", "members-invite", { email: "sam@x.com", role: "seller" }],
      ["/api/members/set-role", "members-set-role", { user_id: ID, role: "admin" }],
      ["/api/members/disable", "members-disable", { user_id: ID }],
      ["/api/members/remove", "members-remove", { user_id: ID }],
      ["/api/members/reenable", "members-reenable", { user_id: ID }],
      ["/api/members/reassign-owner", "members-reassign-owner", { collection: "listings", id: ID, to_user_id: OTHER }],
      ["/api/members/delete-data", "members-delete-data", { user_id: ID, confirm: true }],
    ];
    for (const [path, action, body] of ops) {
      const res = await run(h, jsonReq(HOST_A, path, "POST", body, { ...auth, "cf-connecting-ip": "7.7.7.7", "cf-ray": "r1" }));
      expect(res.status, path).toBe(200);
      const c = brokerCalls(h).at(-1)!;
      expect(c.url).toBe(`${BROKER}/${action}`);
      expect(c.method).toBe("POST");
      expect(c.headers.authorization).toBe(auth.authorization);
      expect(JSON.parse(new TextDecoder().decode(c.body as Uint8Array))).toEqual(body);
      const raw = new TextEncoder().encode(JSON.stringify(body));
      const sig = createHmac("sha256", "broker-secret").update(brokerSigningString({
        ts: Math.floor(NOW / 1000), request_id: "r1", site_id: SITE_A, host: HOST_A, shard_id: REF,
        method: "POST", action, query: "", client_ip: "7.7.7.7", body_sha256: createHash("sha256").update(raw).digest("hex"),
      })).digest("hex");
      expect(c.headers["x-zavi-gw-sig"]).toBe(sig);
    }
    expect(shardCalls(h)).toHaveLength(0);
  });

  it("list is a GET with only limit/cursor; anything else is refused", async () => {
    const h = await harness();
    h.setResponse(() => json({ data: { items: [], next_cursor: null } }));
    const auth = await bearer();
    expect((await run(h, req(HOST_A, `/api/members/list?limit=50&cursor=${ID}`, { headers: auth }))).status).toBe(200);
    expect(brokerCalls(h)[0]).toMatchObject({ url: `${BROKER}/members-list?limit=50&cursor=${ID}`, method: "GET" });
    for (const q of ["?limit=0", "?limit=101", "?cursor=x", "?site_id=" + SITE_B, "?limit=1&limit=2"]) {
      expect((await run(h, req(HOST_A, `/api/members/list${q}`, { headers: auth }))).status, q).toBe(400);
    }
    expect((await run(h, jsonReq(HOST_A, "/api/members/list", "POST", {}, auth))).status).toBe(404);
    expect((await run(h, req(HOST_A, "/api/members/invite", { headers: auth }))).status).toBe(404);
    expect(brokerCalls(h)).toHaveLength(1);
  });

  it("refuses malformed bodies (shape, extra keys, role syntax, size) before the broker", async () => {
    const h = await harness();
    h.setResponse(ok);
    const auth = await bearer();
    const bad: Array<[string, unknown]> = [
      ["/api/members/invite", { email: "sam@x.com" }],
      ["/api/members/invite", { email: "sam@x.com", role: "Admin" }],
      ["/api/members/invite", { email: "sam@x.com", role: "seller", site_id: SITE_B }],
      ["/api/members/invite", { email: 5, role: "seller" }],
      ["/api/members/set-role", { user_id: "nope", role: "admin" }],
      ["/api/members/set-role", { user_id: ID }],
      ["/api/members/disable", { user_id: ID, role: "admin" }],
      ["/api/members/remove", {}],
      ["/api/members/delete-data", { user_id: ID }],
      ["/api/members/delete-data", { user_id: ID, confirm: "yes" }],
      ["/api/members/reassign-owner", { collection: "listings", record_id: ID, to_user_id: OTHER }],
      ["/api/members/reassign-owner", { collection: "Bad-Name", id: ID, to_user_id: OTHER }],
      ["/api/members/reassign-owner", { id: ID, to_user_id: OTHER }],
      ["/api/members/reenable", { user_id: ID, role: "admin" }],
      ["/api/members/invite", { email: "a".repeat(3000) + "@x.com", role: "seller" }],
    ];
    for (const [path, body] of bad) {
      expect((await run(h, jsonReq(HOST_A, path, "POST", body, auth))).status, `${path} ${JSON.stringify(body).slice(0, 60)}`).toBeGreaterThanOrEqual(400);
    }
    expect(brokerCalls(h)).toHaveLength(0);
  });

  it("member writes are rate limited as writes, keyed by site + IP + op", async () => {
    const h = await harness();
    h.setResponse(ok);
    await run(h, jsonReq(HOST_A, "/api/members/invite", "POST", { email: "sam@x.com", role: "seller" }, { ...(await bearer()), "cf-connecting-ip": "9.9.9.9" }));
    expect((h.env.RL_WRITE as unknown as { calls: string[] }).calls).toContain(`${SITE_A}:9.9.9.9:member_invite`);
  });

  it("passes broker errors through (member_admin_required, last_admin)", async () => {
    const h = await harness();
    h.setResponse(() => json({ error: { code: "last_admin", message: "The site needs at least one active admin.", request_id: "r" } }, 409));
    const r = await run(h, jsonReq(HOST_A, "/api/members/set-role", "POST", { user_id: ID, role: "user" }, await bearer()));
    expect([r.status, (await r.json()).error.code]).toEqual([409, "last_admin"]);
  });
});

describe("signup confirm: GET interstitial and form POST", () => {
  it("the link's GET forwards to the broker and passes its locked-down HTML headers through", async () => {
    const h = await harness();
    h.setResponse(() => new Response("<!doctype html><form method=post action=/api/auth/confirm>", {
      status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'" },
    }));
    const r = await run(h, req(HOST_A, "/api/auth/callback?type=signup&token_hash=abcdefgh1234", { headers: { "sec-fetch-site": "cross-site" } }));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("honours the interstitial's strict-origin referrer policy, and only that value", async () => {
    for (const [upstream, want] of [["strict-origin", "strict-origin"], ["unsafe-url", "no-referrer"], ["origin", "no-referrer"]]) {
      const h = await harness();
      h.setResponse(() => new Response("<!doctype html>", {
        status: 200, headers: { "content-type": "text/html; charset=utf-8", "referrer-policy": upstream },
      }));
      const r = await run(h, req(HOST_A, "/api/auth/callback?type=signup&token_hash=abcdefgh1234", { headers: { "sec-fetch-site": "cross-site" } }));
      expect(r.headers.get("referrer-policy")).toBe(want);
    }
  });

  it("the interstitial's urlencoded form POST is forwarded as-is (same origin only); the 303 stays on the site", async () => {
    const h = await harness();
    h.setResponse(() => new Response(null, { status: 303, headers: { location: "/auth/confirm#type=signup&access_token=x" } }));
    const form = "type=signup&token_hash=abcdefgh1234";
    const r = await run(h, req(HOST_A, "/api/auth/confirm", {
      method: "POST", body: form,
      headers: { "content-type": "application/x-www-form-urlencoded", origin: `https://${HOST_A}`, "sec-fetch-site": "same-origin" },
    }));
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/auth/confirm#type=signup&access_token=x");
    const c = brokerCalls(h)[0];
    expect(c.url).toBe(`${BROKER}/confirm`);
    expect(c.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect((await run(h, req(HOST_A, "/api/auth/confirm", { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded", origin: `https://${HOST_B}` } }))).status).toBe(403);
    expect((await run(h, req(HOST_A, "/api/auth/confirm", { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    expect((await run(h, req(HOST_A, "/api/auth/confirm", { method: "POST", body: form, headers: { "content-type": "text/plain" } }))).status).toBe(415);
    expect((await run(h, req(HOST_A, "/api/auth/confirm"))).status).toBe(404);
    expect(brokerCalls(h)).toHaveLength(1);
  });
});

describe("GET /api/site: the PUBLIC Turnstile site key", () => {
  const site = async (h: Harness, host = HOST_A) => (await (await run(h, req(host, "/api/site"))).json()) as { data: Record<string, unknown> };

  it("null when Turnstile is not enforced (no secret, or the site opted out)", async () => {
    expect((await site(await harness({ env: { TURNSTILE_SITE_KEY: "0x4AAAAAAAdefault" } }))).data).toEqual({ site_id: SITE_A, turnstile_site_key: null });
    const optOut = await harness({ env: { TURNSTILE_SECRET: "ts-secret", TURNSTILE_SITE_KEY: "0x4AAAAAAAdefault" }, kv: { [`host:${HOST_A}`]: binding(SITE_A, { turnstile: false }) } });
    expect((await site(optOut)).data.turnstile_site_key).toBeNull();
  });

  it("the site's own key, else the platform default; malformed keys are ignored; the secret never appears", async () => {
    const h = await harness({
      env: { TURNSTILE_SECRET: "ts-secret-value", TURNSTILE_SITE_KEY: "0x4AAAAAAAdefault" },
      kv: { [`host:${HOST_A}`]: binding(SITE_A, { turnstile_site_key: "0x4AAAAAAAsiteA" }), [`host:${HOST_B}`]: binding(SITE_B, { turnstile_site_key: "<script>" }) },
    });
    const a = await run(h, req(HOST_A, "/api/site"));
    const text = await a.text();
    expect(JSON.parse(text)).toEqual({ data: { site_id: SITE_A, turnstile_site_key: "0x4AAAAAAAsiteA" } });
    expect(text).not.toContain("ts-secret-value");
    expect((await site(h, HOST_B)).data.turnstile_site_key).toBe("0x4AAAAAAAdefault");
    expect(h.calls).toHaveLength(0);
  });
});

describe("per-site Turnstile secret (custom widget) and frozen-site uploads", () => {
  const custom = () => ({ kv: { [`host:${HOST_A}`]: binding(SITE_A, { turnstile_site_key: "0x4AAAAAAAsiteA" }) } });

  it("a custom-widget site's token is verified by the broker with the site's own secret; the platform secret is not used", async () => {
    const h = await harness({ env: { TURNSTILE_SECRET: "platform-secret" }, ...custom() });
    let brokerSays = true;
    h.setResponse((c) => {
      if (c.url === `${BROKER}/turnstile-verify`) return json({ data: { success: brokerSays } });
      if (c.url === TURNSTILE_VERIFY_URL) return json({ success: true, hostname: HOST_A });
      return json({ id: ID, replayed: false });
    });
    const hdr = { "idempotency-key": IDEM, "x-zavi-turnstile-token": "site-tok", "cf-connecting-ip": "5.5.5.5" };
    const ok = await run(h, jsonReq(HOST_A, "/api/data/b", "POST", { data: { a: 1 } }, hdr));
    expect(ok.status).toBe(201);
    const v = brokerCalls(h)[0];
    expect(JSON.parse(new TextDecoder().decode(v.body as Uint8Array))).toEqual({ token: "site-tok", ip: "5.5.5.5" });
    expect(v.headers["x-zavi-gw-site-id"]).toBe(SITE_A);
    const raw = JSON.stringify({ token: "site-tok", ip: "5.5.5.5" });
    expect(v.headers["x-zavi-gw-sig"]).toBe(createHmac("sha256", "broker-secret").update(brokerSigningString({
      ts: Math.floor(NOW / 1000), request_id: v.headers["x-zavi-gw-request-id"], site_id: SITE_A, host: HOST_A, shard_id: REF,
      method: "POST", action: "turnstile-verify", query: "", client_ip: "5.5.5.5", body_sha256: createHash("sha256").update(raw).digest("hex"),
    })).digest("hex"));
    expect(h.calls.some((c) => c.url === TURNSTILE_VERIFY_URL)).toBe(false);
    brokerSays = false;
    const bad = await run(h, jsonReq(HOST_A, "/api/data/b", "POST", { data: { a: 1 } }, hdr));
    expect([bad.status, (await bad.json()).error.code]).toEqual([403, "turnstile_failed"]);
    h.setResponse(() => json({ error: { code: "unavailable" } }, 503));
    expect((await run(h, jsonReq(HOST_A, "/api/data/b", "POST", { data: { a: 1 } }, hdr))).status).toBe(503);
    expect(await (await run(h, req(HOST_A, "/api/site"))).text()).not.toContain("secret");
  });

  it("a site without a custom widget keeps the platform secret at the gateway", async () => {
    const h = await harness({ env: { TURNSTILE_SECRET: "platform-secret" } });
    h.setResponse((c) => (c.url === TURNSTILE_VERIFY_URL ? json({ success: true, hostname: HOST_A }) : json({ id: ID, replayed: false })));
    await run(h, jsonReq(HOST_A, "/api/data/b", "POST", { data: { a: 1 } }, { "idempotency-key": IDEM, "x-zavi-turnstile-token": "t" }));
    expect(h.calls.find((c) => c.url === TURNSTILE_VERIFY_URL)!.body).toMatchObject({ secret: "platform-secret" });
    expect(brokerCalls(h)).toHaveLength(0);
  });

  it("[malicious] upload bytes to a frozen / deleting site are refused (shard status is the hard stop), nothing reaches Storage", async () => {
    const h = await harness();
    h.setResponse((c) => (c.url.includes("/object/upload/sign/") && c.method === "POST"
      ? json({ url: `/object/upload/sign/site-files/${SITE_A}/photos/a.png?token=shardtok.u` }) : json({ Key: "x" })));
    const r = await run(h, jsonReq(HOST_A, "/api/storage/photos/upload-url", "POST", { name: "a.png", content_type: "image/png", size: 4 }));
    const { url } = (await r.json()).data as { url: string };
    h.sessionValid = (c) => json(!c.url.endsWith("/site_active"));
    const before = shardCalls(h).length;
    const put = await run(h, req(HOST_A, url, { method: "PUT", body: "abcd", headers: { "content-type": "image/png" } }));
    expect([put.status, (await put.json()).error.code]).toEqual([503, "site_unavailable"]);
    expect(shardCalls(h).length).toBe(before);
    h.sessionValid = () => json(true);
    expect((await run(h, req(HOST_A, url, { method: "PUT", body: "abcd", headers: { "content-type": "image/png" } }))).status).toBe(200);
  });
});
