import { afterEach, describe, expect, it, vi } from "vitest";
import { handleOutbound, hostAllowed, isDeniedHost, type OutboundEnv } from "../outbound";
import { FA, verifyAssertion } from "../shared";

const SECRET = "assertion-secret-0123456789abcdef";
const SITE = "11111111-1111-4111-8111-111111111111";
const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const zfn = { v: 1, site_id: SITE, host: "shop.example.com", fn: "checkout", data: "function", invocation_id: "ray-1", allowed_hosts: ["api.example.com", "*.hooks.example.org"] };

function env(over: Partial<OutboundEnv> = {}) {
  const gw: Request[] = [];
  const e: OutboundEnv = {
    zfn,
    FN_ASSERTION_SECRET: SECRET,
    GATEWAY: { fetch: async (r) => { gw.push(r); return new Response('{"data":[]}', { status: 200 }); } },
    RL_EGRESS: { limit: async () => ({ success: true }) },
    HOSTS: { get: async (k: string) => (k === "host:other-site.customer.com" || k === "preview:abc.preview.example" ? "{}" : null) },
    ...over,
  };
  return { e, gw };
}

afterEach(() => vi.unstubAllGlobals());

describe("outbound: data calls become signed gateway calls", () => {
  it("signs the site, host, function and principal; strips credentials the function set", async () => {
    const { e, gw } = env();
    const res = await handleOutbound(new Request("https://data.zavi.internal/api/data/orders?limit=5", {
      method: "POST", body: '{"data":{"a":1}}', headers: { "content-type": "application/json", authorization: "Bearer stolen", cookie: "x=1", [FA.sig]: "f".repeat(64) },
    }), e, () => NOW);
    expect(res.status).toBe(200);
    expect(gw).toHaveLength(1);
    const r = gw[0];
    expect(r.url).toBe("https://shop.example.com/api/data/orders?limit=5");
    expect(r.headers.get("authorization")).toBeNull();
    expect(r.headers.get("cookie")).toBeNull();
    const body = new Uint8Array(await r.arrayBuffer());
    const meta = await verifyAssertion(SECRET, r.headers, "POST", "/api/data/orders?limit=5", body, NOW);
    expect(meta).toEqual({ v: 1, site_id: SITE, host: "shop.example.com", fn: "checkout", data: "function", invocation_id: "ray-1" });
  });

  it("refuses auth, member, function and unknown paths through the data origin", async () => {
    const { e, gw } = env();
    for (const p of ["/api/auth/login", "/api/members/list", "/api/fn/other", "/api/hooks/x", "/admin", "/api/site/x"]) {
      expect((await handleOutbound(new Request(`https://data.zavi.internal${p}`), e, () => NOW)).status).toBe(403);
    }
    expect(gw).toHaveLength(0);
  });

  it("without its secret it refuses rather than sending an unsigned call", async () => {
    const { e, gw } = env({ FN_ASSERTION_SECRET: undefined });
    expect((await handleOutbound(new Request("https://data.zavi.internal/api/data/x"), e, () => NOW)).status).toBe(503);
    expect(gw).toHaveLength(0);
  });

  it("without dispatcher params it refuses everything", async () => {
    const { e } = env({ zfn: undefined });
    expect((await handleOutbound(new Request("https://api.stripe.com/v1/x"), e)).status).toBe(503);
  });
});

describe("outbound: egress allowlist (SSRF-safe)", () => {
  it("allows Stripe and declared hosts over https only", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (r: Request) => { calls.push(r.url); return new Response("ok"); });
    const { e } = env();
    expect((await handleOutbound(new Request("https://api.stripe.com/v1/checkout/sessions", { method: "POST", body: "a=1" }), e)).status).toBe(200);
    expect((await handleOutbound(new Request("https://api.example.com/x"), e)).status).toBe(200);
    expect((await handleOutbound(new Request("https://a.hooks.example.org/x"), e)).status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("denies undeclared, internal, IP literal, platform, own-site, http and odd-port targets", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (r: Request) => { calls.push(r.url); return new Response("ok"); });
    const { e } = env({ zfn: { ...zfn, allowed_hosts: ["*.zaviagent.com", "localhost", "shop.example.com", "api.example.com"] } });
    const urls = [
      "https://evil.example.net/", "http://api.example.com/", "https://api.example.com:8443/", "https://169.254.169.254/latest",
      "https://[::1]/", "https://2130706433/", "https://api.zaviagent.com/x", "https://localhost/", "https://shop.example.com/api/data/x",
      "https://abcdefghijklmnopqrst.supabase.co/rest/v1/", "https://x.workers.dev/", "https://hooks.example.org/",
    ];
    for (const u of urls) {
      const r = await handleOutbound(new Request(u), e);
      expect(r.status, u).toBeGreaterThanOrEqual(400);
    }
    expect(calls).toEqual([]);
  });

  it("refuses every hostname the platform serves (another site's custom domain, preview hosts), even if declared", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (r: Request) => { calls.push(r.url); return new Response("ok"); });
    const { e } = env({ zfn: { ...zfn, allowed_hosts: ["other-site.customer.com", "abc.preview.example"] } });
    expect((await handleOutbound(new Request("https://other-site.customer.com/api/data/x"), e)).status).toBe(403);
    expect((await handleOutbound(new Request("https://abc.preview.example/"), e)).status).toBe(403);
    const noRegistry = env({ HOSTS: undefined });
    expect((await handleOutbound(new Request("https://api.stripe.com/v1/x"), noRegistry.e)).status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("returns redirects to the function instead of following them", async () => {
    vi.stubGlobal("fetch", async (r: Request) => { expect(r.redirect).toBe("manual"); return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }); });
    const { e } = env();
    expect((await handleOutbound(new Request("https://api.stripe.com/v1/x"), e)).status).toBe(302);
  });

  it("enforces the per-site egress quota and fails closed without it", async () => {
    vi.stubGlobal("fetch", async () => new Response("ok"));
    const limited = env({ RL_EGRESS: { limit: async ({ key }) => ({ success: key !== SITE }) } });
    expect((await handleOutbound(new Request("https://api.stripe.com/v1/x"), limited.e)).status).toBe(429);
    const none = env({ RL_EGRESS: undefined });
    expect((await handleOutbound(new Request("https://api.stripe.com/v1/x"), none.e)).status).toBe(503);
  });

  it("host helpers", () => {
    expect(hostAllowed("api.example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("example.com", ["*.example.com"])).toBe(false);
    expect(hostAllowed("evilexample.com", ["*.example.com"])).toBe(false);
    expect(isDeniedHost("10.0.0.1", "s.example.com")).toBe(true);
    expect(isDeniedHost("metadata.google.internal", "s.example.com")).toBe(true);
    expect(isDeniedHost("api.stripe.com", "s.example.com")).toBe(false);
  });
});
