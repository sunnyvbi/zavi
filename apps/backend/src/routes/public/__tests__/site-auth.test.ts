
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createSiteAuthHandler } from "../site-auth";
import { GW, signGatewayRequest } from "@/services/site-auth/gateway-auth";
import { SITE_A, SITE_B, claimsOf, world } from "@/services/site-auth/__tests__/fakes";

const SECRET = "g".repeat(40);
const NOW = Date.parse("2026-10-01T12:00:00Z");

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    send(b: unknown) { this.body = b; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; },
  };
}

interface CallOpts {
  method?: "GET" | "POST";
  site?: string;
  shard?: string;
  ip?: string;
  query?: string;
  requestId?: string;
  raw?: string;
  auth?: string;
  signed?: Partial<{ site: string; shard: string; ip: string; body: string; action: string; query: string; ts: number; method: string }>;
  drop?: string;
  secret?: string;
  ctype?: string;
}

function setup(secret: string | undefined = SECRET) {
  const w = world({ now: () => NOW });
  const deps = { ...w.deps, sleep: async () => {} };
  const handler = createSiteAuthHandler({ broker: () => deps, gatewaySecret: () => secret, now: () => NOW });
  async function call(action: string, body: unknown, o: CallOpts = {}) {
    const method = o.method ?? "POST";
    const raw = o.raw ?? (method === "GET" ? "" : JSON.stringify(body));
    const site = o.site ?? SITE_A;
    const shard = o.shard ?? "shard-1";
    const ip = o.ip ?? "203.0.113.9";
    const query = o.query ?? "";
    const host = w.sites[site]?.hostname ?? "x.zaviagent.com";
    const requestId = o.requestId ?? randomUUID();
    const ts = String(Math.floor((o.signed?.ts ?? NOW) / 1000));
    const sig = signGatewayRequest(o.secret ?? SECRET, {
      ts, requestId, siteId: o.signed?.site ?? site, host, shardId: o.signed?.shard ?? shard,
      method: o.signed?.method ?? method, action: o.signed?.action ?? action, query: o.signed?.query ?? query,
      ip: o.signed?.ip ?? ip, body: Buffer.from(o.signed?.body ?? raw),
    });
    const headers: Record<string, string> = {
      [GW.ts]: ts, [GW.requestId]: requestId, [GW.site]: site, [GW.host]: host, [GW.shard]: shard, [GW.ip]: ip, [GW.sig]: sig,
    };
    if (o.drop) delete headers[o.drop];
    if (o.auth) headers.authorization = o.auth;
    if (o.ctype) headers["content-type"] = o.ctype;
    const res = makeRes();
    await handler(
      { method, originalUrl: `/api/public/site-auth/${action}${query}`, params: { op: action }, headers, body: method === "POST" ? Buffer.from(raw) : {} } as any,
      res as any,
    );
    return { res, requestId, headers };
  }
  return { w, call, handler };
}

const SIGNUP = { email: "alice@x.com", password: "correct horse 1" };

describe("site-auth route: gateway authentication", () => {
  it("a signed request runs the action and answers {data}", async () => {
    const { call } = setup();
    const { res } = await call("signup", SIGNUP);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ data: { status: "check_email" } });
  });

  it("[malicious] a bad signature (wrong secret) is refused and nothing runs", async () => {
    const { w, call } = setup();
    const { res } = await call("signup", SIGNUP, { secret: "x".repeat(40) });
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatchObject({ code: "unauthorized" });
    expect(typeof res.body.error.request_id).toBe("string");
    expect(w.store.idents).toHaveLength(0);
  });

  it("[malicious] every missing x-zavi-gw-* header is refused", async () => {
    const { w, call } = setup();
    for (const h of Object.values(GW)) {
      expect((await call("signup", SIGNUP, { drop: h })).res.statusCode).toBe(401);
    }
    expect(w.store.idents).toHaveLength(0);
  });

  it("[malicious] a timestamp more than 60s off is refused; 59s is accepted", async () => {
    const { call } = setup();
    expect((await call("signup", SIGNUP, { signed: { ts: NOW - 61_000 } })).res.statusCode).toBe(401);
    expect((await call("signup", SIGNUP, { signed: { ts: NOW + 61_000 } })).res.statusCode).toBe(401);
    expect((await call("signup", SIGNUP, { signed: { ts: NOW - 59_000 } })).res.statusCode).toBe(200);
  });

  it("[malicious] a replayed request (same signed request id) is refused", async () => {
    const { w, handler } = setup();
    const raw = JSON.stringify(SIGNUP);
    const requestId = "8f2b1c3d4e5f6a7b-SJC";
    const ts = String(Math.floor(NOW / 1000));
    const host = w.sites[SITE_A].hostname;
    const sig = signGatewayRequest(SECRET, { ts, requestId, siteId: SITE_A, host, shardId: "shard-1", method: "POST", action: "signup", query: "", ip: "203.0.113.9", body: Buffer.from(raw) });
    const headers = { [GW.ts]: ts, [GW.requestId]: requestId, [GW.site]: SITE_A, [GW.host]: host, [GW.shard]: "shard-1", [GW.ip]: "203.0.113.9", [GW.sig]: sig };
    const send = async () => {
      const res = makeRes();
      await handler({ method: "POST", originalUrl: "/api/public/site-auth/signup", params: { op: "signup" }, headers, body: Buffer.from(raw) } as any, res as any);
      return res;
    };
    expect((await send()).statusCode).toBe(200);
    const again = await send();
    expect(again.statusCode).toBe(401);
    expect(again.body.error.request_id).toBe(requestId);
  });

  it("[malicious] tampering with site, shard, IP, body, action, query or method after signing breaks it", async () => {
    const { w, call } = setup();
    const cases: CallOpts[] = [
      { site: SITE_B, signed: { site: SITE_A } },
      { shard: "shard-2", signed: { shard: "shard-1" } },
      { ip: "10.0.0.1", signed: { ip: "203.0.113.9" } },
      { signed: { body: JSON.stringify({ email: "other@x.com", password: "x".repeat(10) }) } },
      { signed: { action: "login" } },
      { query: "?a=1", signed: { query: "" } },
      { signed: { method: "GET" } },
    ];
    for (const c of cases) expect((await call("signup", SIGNUP, c)).res.statusCode).toBe(401);
    expect(w.store.idents).toHaveLength(0);
  });

  it("[malicious] a correctly signed call naming a shard that is not the site's shard is refused", async () => {
    const { w, call } = setup();
    const { res } = await call("signup", SIGNUP, { shard: "shard-9" });
    expect(res.statusCode).toBe(401);
    expect(w.store.idents).toHaveLength(0);
  });

  it("fails closed without a configured secret", async () => {
    const { call } = setup("");
    expect((await call("signup", SIGNUP)).res.statusCode).toBe(503);
  });

  it("unknown action -> 404; prototype keys are not actions; bad JSON / non-object -> 400; callback is GET-only", async () => {
    const { call } = setup();
    expect((await call("nope", {})).res.statusCode).toBe(404);
    expect((await call("constructor", {})).res.statusCode).toBe(404);
    expect((await call("callback", {})).res.statusCode).toBe(404);
    expect((await call("login", {}, { method: "GET" })).res.statusCode).toBe(404);
    expect((await call("signup", null, { raw: "{not json" })).res.statusCode).toBe(400);
    expect((await call("signup", null, { raw: "[1,2]" })).res.statusCode).toBe(400);
  });

  it("errors use {error:{code,message,request_id}}; rate limits add Retry-After", async () => {
    const { call } = setup();
    let res: ReturnType<typeof makeRes> | undefined;
    for (let i = 0; i < 11; i++) res = (await call("login", { email: "x@x.com", password: "bad pass 1" }, { ip: `198.51.100.${i}` })).res;
    expect(res!.statusCode).toBe(429);
    expect(res!.body.error.code).toBe("rate_limited");
    expect(res!.headers["Retry-After"]).toBe("60");
  });
});

describe("site-auth route: signup confirm (GET interstitial, POST confirm)", () => {
  async function pendingSignup(w: ReturnType<typeof setup>["w"], call: ReturnType<typeof setup>["call"]) {
    await call("signup", SIGNUP);
    await w.settle();
    const link = new URL(w.mailer.sent.find((m) => m.kind === "verify_signup")!.link!);
    return { query: link.search, token: link.searchParams.get("token_hash")! };
  }

  it("[malicious] the link's GET (with or without confirm=1) only renders the interstitial and consumes nothing", async () => {
    const { w, call } = setup();
    const { query, token } = await pendingSignup(w, call);
    for (const q of [query, `${query}&confirm=1`]) {
      const r = (await call("callback", null, { method: "GET", query: q })).res;
      expect(r.statusCode).toBe(200);
      expect(r.headers["Cache-Control"]).toBe("no-store");
      expect(r.headers["Referrer-Policy"]).toBe("strict-origin");
      expect(String(r.body)).toContain('<meta name="referrer" content="strict-origin">');
      expect(r.headers["Content-Security-Policy"]).toContain("default-src 'none'");
      expect(String(r.body)).toContain(`name="token_hash" value="${token}"`);
      expect(String(r.body)).toContain('action="/api/auth/confirm"');
    }
    expect(w.store.idents).toHaveLength(0);
    expect(w.gotrue.users.size).toBe(0);
  });

  it("the form POST confirms and lands on a session fragment; a replay gets no session; a guessed token errors", async () => {
    const { w, call } = setup();
    const { token } = await pendingSignup(w, call);
    const form = `type=signup&token_hash=${encodeURIComponent(token)}`;
    const r = (await call("confirm", null, { raw: form, ctype: "application/x-www-form-urlencoded" })).res;
    expect(r.statusCode).toBe(303);
    expect(r.headers["Referrer-Policy"]).toBe("no-referrer");
    const frag = new URLSearchParams(r.headers.Location.split("#")[1]);
    expect(r.headers.Location.startsWith("/auth/confirm#")).toBe(true);
    expect(claimsOf(frag.get("access_token")!).site_id).toBe(SITE_A);
    expect(w.store.idents[0].state).toBe("active");
    const again = (await call("confirm", null, { raw: form, ctype: "application/x-www-form-urlencoded" })).res;
    expect(again.headers.Location).toBe("/auth/confirm#type=signup&confirmed=1");
    expect(w.gotrue.users.size).toBe(1);
    const bad = (await call("confirm", null, { raw: "type=signup&token_hash=guessedtoken123", ctype: "application/x-www-form-urlencoded" })).res;
    expect(bad.headers.Location).toBe("/auth/confirm#type=signup&error=invalid_link");
  });

  it("[malicious] a site-A token confirmed through site B's hostname lands on an error, no account", async () => {
    const { w, call } = setup();
    const { token } = await pendingSignup(w, call);
    const r = (await call("confirm", { type: "signup", token_hash: token }, { site: SITE_B })).res;
    expect(r.headers.Location).toBe("/auth/confirm#type=signup&error=invalid_link");
    expect(w.store.idents).toHaveLength(0);
  });

  it("end to end: confirm, set a password, login on A gives an A token; the same credentials on B fail", async () => {
    const { w, call } = setup();
    const { token } = await pendingSignup(w, call);
    const r = (await call("confirm", { type: "signup", token_hash: token })).res;
    const at = new URLSearchParams(r.headers.Location.split("#")[1]).get("access_token")!;
    const pw = (await call("password", { password: SIGNUP.password }, { auth: `Bearer ${at}` })).res;
    expect(pw.body.data.updated).toBe(true);
    const a = (await call("login", SIGNUP)).res;
    expect(claimsOf(a.body.data.session.access_token).site_id).toBe(SITE_A);
    const b = (await call("login", SIGNUP, { site: SITE_B })).res;
    expect(b.statusCode).toBe(401);
    expect(b.body.error.code).toBe("invalid_credentials");
    const out = (await call("logout", {}, { auth: `Bearer ${a.body.data.session.access_token}` })).res;
    expect(out.body).toEqual({ data: { signed_out: true } });
  });
});

describe("site-auth route: callback (GET, two hops) for GoTrue links", () => {
  it("the first GET consumes nothing, the confirm GET signs in, a second confirm fails; another site's hostname gets nothing", async () => {
    const { w, call } = setup();
    const { token } = await (async () => {
      await call("signup", SIGNUP);
      await w.settle();
      const link = new URL(w.mailer.sent.find((m) => m.kind === "verify_signup")!.link!);
      return { token: link.searchParams.get("token_hash")! };
    })();
    await call("confirm", { type: "signup", token_hash: token });
    await call("magic-link", { email: SIGNUP.email });
    await w.settle();
    const m = w.gotrue.hookOutbox.at(-1)!;
    const q = `?type=${m.type}&token_hash=${m.tokenHash}`;
    const hop1 = (await call("callback", null, { method: "GET", query: q })).res;
    expect(hop1.statusCode).toBe(303);
    expect(hop1.headers.Location).toBe(`/auth/confirm#type=magiclink&token_hash=${m.tokenHash}`);
    const hop2 = (await call("callback", null, { method: "GET", query: `${q}&confirm=1` })).res;
    expect(hop2.statusCode).toBe(303);
    expect(hop2.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(claimsOf(new URLSearchParams(hop2.headers.Location.split("#")[1]).get("access_token")!).site_id).toBe(SITE_A);
    const again = (await call("callback", null, { method: "GET", query: `${q}&confirm=1` })).res;
    expect(again.headers.Location).toBe("/auth/confirm#error=invalid_link");
    await call("magic-link", { email: SIGNUP.email }, { ip: "203.0.113.10" });
    await w.settle();
    const m2 = w.gotrue.hookOutbox.at(-1)!;
    const cross = (await call("callback", null, { method: "GET", site: SITE_B, query: `?type=${m2.type}&token_hash=${m2.tokenHash}&confirm=1` })).res;
    expect(cross.headers.Location).toBe("/auth/confirm#error=invalid_link");
  });
});

describe("site-auth route: members", () => {
  it("members-list is a signed GET with a Bearer; unknown or repeated query params are refused; POST ops map to the broker", async () => {
    const { w, call } = setup();
    const { ensureSiteAdmin } = await import("@/services/site-auth/admin");
    await ensureSiteAdmin(w.deps, { siteId: SITE_A, email: "owner@biz.com" });
    await call("magic-link", { email: "owner@biz.com" });
    await w.settle();
    const m = w.gotrue.hookOutbox.at(-1)!;
    const cb = (await call("callback", null, { method: "GET", query: `?type=${m.type}&token_hash=${m.tokenHash}&confirm=1` })).res;
    const at = new URLSearchParams(cb.headers.Location.split("#")[1]).get("access_token")!;
    const auth = `Bearer ${at}`;
    const list = (await call("members-list", null, { method: "GET", query: "?limit=10", auth })).res;
    expect(list.statusCode).toBe(200);
    expect(list.body.data.items).toEqual([expect.objectContaining({ email: "owner@biz.com", role: "admin", status: "active" })]);
    expect((await call("members-list", null, { method: "GET", query: "?site_id=x", auth })).res.statusCode).toBe(400);
    expect((await call("members-list", null, { method: "GET", query: "?limit=1&limit=2", auth })).res.statusCode).toBe(400);
    expect((await call("members-list", null, { method: "GET", query: "?limit=10" })).res.body.error.code).toBe("unauthorized");
    expect((await call("members-list", {}, { auth })).res.statusCode).toBe(404);
    const inv = (await call("members-invite", { email: "sam@x.com", role: "user" }, { auth })).res;
    expect(inv.body).toEqual({ data: { email: "sam@x.com", role: "user", status: "invited" } });
    const last = (await call("members-set-role", { user_id: claimsOf(at).sub, role: "user" }, { auth })).res;
    expect(last.statusCode).toBe(409);
    expect(last.body.error.code).toBe("last_admin");
  });
});
