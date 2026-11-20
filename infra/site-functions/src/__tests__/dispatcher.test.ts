import { beforeEach, describe, expect, it } from "vitest";
import { handleDispatch, parseSiteRecord, principalsAllow, resetKillCache, sanitizeResponse, FD_METHOD_HEADER, type DispatcherEnv } from "../dispatcher";
import { INVOCATION_HEADER, fnSiteKey, signInvocation, type FnSiteRecord, type InvocationMeta } from "../shared";

const SECRET = "dispatch-secret-0123456789abcdef";
const SITE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const enc = new TextEncoder();

function record(over: Partial<FnSiteRecord> = {}): FnSiteRecord {
  return {
    v: 1, site_id: SITE, status: "active", generation: 3, script: "zfn-11111111111141118111111111111111-3",
    endpoints: {
      checkout: { type: "http", principals: ["anyone"], data: "function" },
      "members-only": { type: "http", principals: ["signed_in"], data: "function" },
      "admin-report": { type: "http", principals: ["admin"], data: "admin" },
      stripe: { type: "webhook", principals: [], data: "admin" },
    },
    schedules: { nightly: { data: "function" } },
    allowed_hosts: ["api.example.com"],
    ...over,
  };
}

interface Seen { name: string; limits: unknown; outbound: any; req: Request; body: string }

function env(kv: Record<string, string>, opts: { reply?: (r: Request) => Response | Promise<Response>; rl?: boolean } = {}) {
  const seen: Seen[] = [];
  const e: DispatcherEnv = {
    FN_DISPATCH_SECRET: SECRET,
    HOSTS: { get: async (k) => kv[k] ?? null },
    RL_FN_SITE: opts.rl === false ? undefined : { limit: async () => ({ success: true }) },
    DISPATCH: {
      get(name, _args, o) {
        return {
          async fetch(req: Request) {
            seen.push({ name, limits: o?.limits, outbound: o?.outbound, req, body: await req.clone().text() });
            return opts.reply ? opts.reply(req) : new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
          },
        };
      },
    },
  };
  return { e, seen };
}

function meta(over: Partial<InvocationMeta> = {}): InvocationMeta {
  return { v: 1, site_id: SITE, host: "shop.example.com", kind: "http", name: "checkout", request_id: "ray-1", user: null, public_path: "/api/fn/checkout?x=1", ...over };
}

async function signed(m: InvocationMeta, body = "{}", method = "POST", secret = SECRET, at = NOW) {
  const bytes = enc.encode(body);
  const h = await signInvocation(secret, m, method, bytes, at);
  return new Request("https://fn-dispatch.example.com/v1/invoke", {
    method: "POST",
    headers: { ...h, [FD_METHOD_HEADER]: method, "content-type": "application/json", authorization: "Bearer user-token", cookie: "a=b" },
    body: bytes,
  });
}

const kvFor = (r: FnSiteRecord) => ({ [fnSiteKey(r.site_id)]: JSON.stringify(r) });
const now = () => NOW;
const quiet = () => undefined;

describe("dispatcher", () => {
  beforeEach(() => resetKillCache());

  it("runs the site's recorded script with pinned limits and outbound params, minus credentials", async () => {
    const { e, seen } = env(kvFor(record()));
    const res = await handleDispatch(await signed(meta()), e, { now, log: quiet });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe("zfn-11111111111141118111111111111111-3");
    expect(seen[0].limits).toEqual({ cpuMs: 50, subRequests: 50 });
    expect(seen[0].outbound.zfn).toMatchObject({ site_id: SITE, host: "shop.example.com", fn: "checkout", data: "function", allowed_hosts: ["api.example.com"] });
    const r = seen[0].req;
    expect(r.url).toBe("https://shop.example.com/api/fn/checkout?x=1");
    expect(r.headers.get("authorization")).toBeNull();
    expect(r.headers.get("cookie")).toBeNull();
    expect([...r.headers.keys()].filter((k) => k.startsWith("x-zavi-fd"))).toEqual([]);
    const inv = JSON.parse(r.headers.get(INVOCATION_HEADER)!);
    expect(inv).toMatchObject({ type: "request", function: "checkout", site_id: SITE, user: null });
  });

  it("refuses unsigned, stale, wrong-secret and tampered requests before any lookup", async () => {
    const { e, seen } = env(kvFor(record()));
    const unsigned = new Request("https://d/v1/invoke", { method: "POST", body: "{}" });
    expect((await handleDispatch(unsigned, e, { now, log: quiet })).status).toBe(401);
    expect((await handleDispatch(await signed(meta(), "{}", "POST", "wrong-secret-xxxxxxxxxxxxxxxx"), e, { now, log: quiet })).status).toBe(401);
    expect((await handleDispatch(await signed(meta(), "{}", "POST", SECRET, NOW - 120_000), e, { now, log: quiet })).status).toBe(401);
    const good = await signed(meta(), '{"a":1}');
    const swapped = new Request(good.url, { method: "POST", headers: good.headers, body: '{"a":2}' });
    expect((await handleDispatch(swapped, e, { now, log: quiet })).status).toBe(401);
    const m2 = await signed(meta(), "{}", "POST");
    const h = new Headers(m2.headers);
    h.set(FD_METHOD_HEADER, "DELETE");
    expect((await handleDispatch(new Request(m2.url, { method: "POST", headers: h, body: "{}" }), e, { now, log: quiet })).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("never runs another site's script: the record is read for the SIGNED site only", async () => {
    const { e, seen } = env({ [fnSiteKey(OTHER)]: JSON.stringify(record({ site_id: OTHER, script: "zfn-22222222222242228222222222222222-1" })) });
    const res = await handleDispatch(await signed(meta()), e, { now, log: quiet });
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
    const { e: e2, seen: s2 } = env({ [fnSiteKey(SITE)]: JSON.stringify(record({ site_id: OTHER })) });
    expect((await handleDispatch(await signed(meta()), e2, { now, log: quiet })).status).toBe(404);
    expect(s2).toHaveLength(0);
  });

  it("enforces the kind: an http call cannot reach a webhook or a schedule-only function, and vice versa", async () => {
    const { e, seen } = env(kvFor(record()));
    expect((await handleDispatch(await signed(meta({ name: "stripe" })), e, { now, log: quiet })).status).toBe(404);
    expect((await handleDispatch(await signed(meta({ name: "nightly" })), e, { now, log: quiet })).status).toBe(404);
    expect((await handleDispatch(await signed(meta({ kind: "webhook", name: "checkout", public_path: "/api/hooks/checkout" })), e, { now, log: quiet })).status).toBe(404);
    const hook = await handleDispatch(await signed(meta({ kind: "webhook", name: "stripe", public_path: "/api/hooks/stripe" })), e, { now, log: quiet });
    expect(hook.status).toBe(200);
    expect(seen.map((s) => s.outbound.zfn.data)).toEqual(["admin"]);
  });

  it("gates http endpoints on their principals", async () => {
    const { e } = env(kvFor(record()));
    expect((await handleDispatch(await signed(meta({ name: "members-only" })), e, { now, log: quiet })).status).toBe(401);
    expect((await handleDispatch(await signed(meta({ name: "members-only", user: { id: USER, role: "user" } })), e, { now, log: quiet })).status).toBe(200);
    expect((await handleDispatch(await signed(meta({ name: "admin-report", user: { id: USER, role: "user" } })), e, { now, log: quiet })).status).toBe(403);
    expect((await handleDispatch(await signed(meta({ name: "admin-report", user: { id: USER, role: "admin" } })), e, { now, log: quiet })).status).toBe(200);
    expect(principalsAllow(["role:staff"], { id: USER, role: "staff" })).toBe(true);
    expect(principalsAllow(["role:staff"], { id: USER, role: "user" })).toBe(false);
  });

  it("schedule invocations carry no user and a stable idempotency key", async () => {
    const { e, seen } = env(kvFor(record()));
    const m = meta({ kind: "schedule", name: "nightly", public_path: undefined, scheduled_time: "2026-10-02T03:00:00.000Z", idempotency_key: `${SITE}:nightly:1790996400`, attempt: 2 });
    const res = await handleDispatch(await signed(m, ""), e, { now, log: quiet });
    expect(res.status).toBe(200);
    const inv = JSON.parse(seen[0].req.headers.get(INVOCATION_HEADER)!);
    expect(inv).toMatchObject({ type: "schedule", function: "nightly", user: null, idempotency_key: `${SITE}:nightly:1790996400`, attempt: 2 });
    expect(seen[0].outbound.zfn.invocation_id).toBe(`${SITE}:nightly:1790996400`);
    expect(seen[0].req.headers.get("content-type")).toBeNull();
  });

  it("kill switches: per site and global", async () => {
    const { e, seen } = env(kvFor(record({ status: "disabled" })));
    expect((await handleDispatch(await signed(meta()), e, { now, log: quiet })).status).toBe(503);
    resetKillCache();
    const { e: e2 } = env({ ...kvFor(record()), "fn:kill_all": "1" });
    const r2 = await handleDispatch(await signed(meta()), e2, { now, log: quiet });
    expect(r2.status).toBe(503);
    expect(await r2.json()).toMatchObject({ error: { code: "functions_disabled" } });
    expect(seen).toHaveLength(0);
  });

  it("re-checks the record right before invoking: a kill or redeploy in between wins", async () => {
    const { e, seen } = env(kvFor(record()));
    let reads = 0;
    const killed = JSON.stringify(record({ status: "disabled" }));
    const live = JSON.stringify(record());
    e.HOSTS = { get: async (k: string) => (k === "fn:kill_all" ? null : (++reads === 1 ? live : killed)) };
    const res = await handleDispatch(await signed(meta()), e, { now, log: quiet });
    expect(res.status).toBe(503);
    expect(seen).toHaveLength(0);
  });

  it("fails closed without the rate limiter", async () => {
    const { e } = env(kvFor(record()), { rl: false });
    expect((await handleDispatch(await signed(meta()), e, { now, log: quiet })).status).toBe(503);
  });

  it("maps limit breaches and timeouts, and logs one structured line without bodies", async () => {
    const lines: Record<string, unknown>[] = [];
    const { e } = env(kvFor(record()), { reply: () => { throw new Error("Worker exceeded CPU time limit."); } });
    const res = await handleDispatch(await signed(meta(), '{"card":"4242"}'), e, { now, log: (l) => lines.push(l) });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "function_limit_exceeded" } });
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines[0])).not.toContain("4242");
    expect(lines[0]).toMatchObject({ evt: "site_fn_invoke", site_id: SITE, fn: "checkout", outcome: "function_limit_exceeded" });

    const slow = env(kvFor(record({ limits: { wall_ms: 5 } })), { reply: () => new Promise<Response>(() => undefined) });
    const r2 = await handleDispatch(await signed(meta()), slow.e, { now, log: quiet });
    expect(r2.status).toBe(504);
  });

  it("the deadline covers response streaming and aborts the user worker's request", async () => {
    let clock = NOW;
    let signal: AbortSignal | null = null;
    const { e } = env(kvFor(record({ limits: { wall_ms: 1000 } })), {
      reply: (r) => {
        signal = r.signal;
        return new Response(new ReadableStream({ pull: () => new Promise(() => undefined) }), { headers: { "content-type": "application/json" } });
      },
    });
    const res = await handleDispatch(await signed(meta()), e, { now: () => clock, log: quiet });
    expect(res.status).toBe(200);
    clock = NOW + 2000;
    await expect(res.text()).rejects.toBeTruthy();
    expect(signal!.aborted).toBe(true);
  });

  it("the deadline fires even when the client never pulls the body (backpressure)", async () => {
    let signal: AbortSignal | null = null;
    const { e } = env(kvFor(record({ limits: { wall_ms: 30 } })), {
      reply: (r) => { signal = r.signal; return new Response(new ReadableStream({ pull: () => new Promise(() => undefined) })); },
    });
    const res = await handleDispatch(await signed(meta(), "{}", "POST", SECRET, Date.now()), e, { log: quiet, now: Date.now });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 80));
    expect(signal!.aborted).toBe(true);
  });

  it("caps the response size", async () => {
    const big = new Uint8Array(11 * 1024 * 1024);
    const { e } = env(kvFor(record()), { reply: () => new Response(big, { headers: { "content-type": "application/octet-stream" } }) });
    const res = await handleDispatch(await signed(meta()), e, { now, log: quiet });
    await expect(res.arrayBuffer()).rejects.toBeTruthy();
  });

  it("a record may lower limits but never raise them past the platform maximum", async () => {
    const { e, seen } = env(kvFor(record({ limits: { cpu_ms: 10_000_000, subrequests: 5 } })));
    await handleDispatch(await signed(meta()), e, { now, log: quiet });
    expect(seen[0].limits).toEqual({ cpuMs: 30_000, subRequests: 5 });
  });

  it("sanitizes function output: no cookies, HTML sandboxed", async () => {
    const r = sanitizeResponse(new Response("<script>x</script>", { headers: { "content-type": "text/html", "set-cookie": "s=1" } }), "rid");
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("content-security-policy")).toContain("sandbox");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const j = sanitizeResponse(new Response("{}", { headers: { "content-type": "application/json" } }), "rid");
    expect(j.headers.get("content-security-policy")).toBeNull();
  });

  it("rejects malformed records instead of guessing", () => {
    expect(parseSiteRecord("not json", SITE)).toBeNull();
    expect(parseSiteRecord(JSON.stringify({ ...record(), script: "../evil" }), SITE)).toBeNull();
    expect(parseSiteRecord(JSON.stringify({ ...record(), endpoints: { checkout: { type: "http", principals: ["everyone"], data: "function" } } }), SITE)).toBeNull();
    expect(parseSiteRecord(JSON.stringify({ ...record(), endpoints: { checkout: { type: "http", principals: ["anyone"], data: "root" } } }), SITE)).toBeNull();
    expect(parseSiteRecord(JSON.stringify({ ...record(), allowed_hosts: ["http://x"] }), SITE)).toBeNull();
    expect(parseSiteRecord(JSON.stringify(record()), SITE)).not.toBeNull();
  });
});
