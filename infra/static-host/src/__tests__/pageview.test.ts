import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dailySalt,
  deviceClass,
  handle,
  pageViewPath,
  PAGEVIEW_API_PATH,
  PAGEVIEW_PATH,
  PAGEVIEW_SALT_TTL_S,
  PAGEVIEW_SCRIPT,
  admitPageView,
  PAGEVIEW_MAX_PER_CLIENT_HOUR,
  referrerHost,
  resetPageViewState,
  visitorId,
  withPageViewScript,
  type Env,
  type R2ObjectBodyLike,
} from "../worker";

const HOST = "golden-fork-1a2b3c4d.zaviagent.com";
const DEPLOY = "d_20261007";
const NOW = Date.parse("2026-10-07T12:00:00Z");
const SECRET = "wake-secret";
const IP = "203.0.113.7";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1";
const PAGE = "<!doctype html><html><head><title>Golden Fork</title></head><body><div id=root></div></body></html>";

function world(opts: { spa?: boolean; paused?: boolean; kv?: Record<string, string>; domain?: string } = {}) {
  const kv: Record<string, string> = {
    [`host:${HOST}`]: JSON.stringify({ deploy_id: DEPLOY, sha: "abc", tenant_id: "t1", published_at: "2026-10-01T00:00:00Z", spa: opts.spa ?? true }),
    ...(opts.paused ? { [`paused:${HOST}`]: "1" } : {}),
    ...opts.kv,
  };
  const puts: Array<{ key: string; value: string; ttl?: number }> = [];
  const files: Record<string, string> = { [`sites/${HOST}/${DEPLOY}/index.html`]: PAGE };
  const env: Env = {
    SITES: {
      async get(key: string): Promise<R2ObjectBodyLike | null> {
        if (!(key in files)) return null;
        const bytes = new TextEncoder().encode(files[key]);
        return { body: new Blob([bytes]).stream(), size: bytes.byteLength, httpEtag: `"e-${key.length}"` };
      },
    },
    HOSTS: {
      async get(key: string) {
        return key in kv ? kv[key] : null;
      },
      async put(key: string, value: string, o?: { expirationTtl?: number }) {
        kv[key] = value;
        puts.push({ key, value, ttl: o?.expirationTtl });
      },
    },
    WAKE_HMAC_SECRET: SECRET,
    ZAVI_API: "https://api.zaviagent.com",
    PREVIEW_DOMAIN: opts.domain,
  };
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
  return { env, ctx, puts, kv, settle: () => Promise.all(waits) };
}

function beacon(body: unknown, headers: Record<string, string> = {}, host = HOST) {
  return new Request(`https://${host}${PAGEVIEW_PATH}`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "user-agent": UA, "cf-connecting-ip": IP, "content-type": "text/plain;charset=UTF-8", ...headers },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
function mockFetch() {
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
}
afterEach(() => {
  vi.unstubAllGlobals();
  resetPageViewState();
});

describe("pure parts", () => {
  it("counts the path only: no query, no fragment, no trailing slash, never the private pages", () => {
    expect(pageViewPath("/")).toBe("/");
    expect(pageViewPath("/menu/?utm_source=x#top")).toBe("/menu");
    expect(pageViewPath("/admin")).toBeNull();
    expect(pageViewPath("/login?next=/admin")).toBeNull();
    expect(pageViewPath("/auth/confirm")).toBeNull();
    expect(pageViewPath("/administration-services")).toBe("/administration-services");
    expect(pageViewPath("//evil.example/x")).toBeNull();
    expect(pageViewPath("https://x/")).toBeNull();
    expect(pageViewPath("/" + "a".repeat(400))?.length).toBe(200);
  });

  it("keeps a referring host, and none for the site itself or anything that is not a host", () => {
    expect(referrerHost("www.google.com", HOST)).toBe("www.google.com");
    expect(referrerHost(HOST, HOST)).toBeNull();
    expect(referrerHost("https://www.google.com/search?q=golden+fork", HOST)).toBeNull();
    expect(referrerHost("", HOST)).toBeNull();
  });

  it("counts a repeat of the same page once per half hour, and caps one client per hour", () => {
    expect(admitPageView("v1", "c1", "h/", NOW)).toBe(true);
    expect(admitPageView("v1", "c1", "h/", NOW + 60_000)).toBe(false);
    expect(admitPageView("v1", "c1", "h/menu", NOW + 60_000)).toBe(true);
    expect(admitPageView("v1", "c1", "h/", NOW + 31 * 60_000)).toBe(true);
    resetPageViewState();
    for (let i = 0; i < PAGEVIEW_MAX_PER_CLIENT_HOUR; i++) expect(admitPageView(`v${i}`, "flood", "h/", NOW)).toBe(true);
    expect(admitPageView("fresh", "flood", "h/", NOW)).toBe(false);
    expect(admitPageView("fresh", "flood", "h/", NOW + 3_600_000)).toBe(true);
  });

  it("tells device classes apart", () => {
    expect(deviceClass(UA)).toBe("mobile");
    expect(deviceClass("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("tablet");
    expect(deviceClass("Mozilla/5.0 (Linux; Android 14; SM-X200) Safari")).toBe("tablet");
    expect(deviceClass("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("desktop");
  });

  it("puts the beacon in the head once, and leaves a page without head or body alone", () => {
    const once = withPageViewScript(PAGE);
    expect(once).toContain(`${PAGEVIEW_SCRIPT}</head>`);
    expect(withPageViewScript(once)).toBe(once);
    expect(withPageViewScript("<h1>x</h1>")).toBe("<h1>x</h1>");
    expect(PAGEVIEW_SCRIPT).not.toMatch(/document\.cookie|localStorage|sessionStorage|sendBeacon/);
    expect(PAGEVIEW_SCRIPT).toContain('credentials:"omit",referrerPolicy:"no-referrer"');
  });

  it("the visitor id is a 32-hex hash that changes with the salt and never contains the IP", async () => {
    const a = await visitorId("salt-1", HOST, IP, UA);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await visitorId("salt-1", HOST, IP, UA)).toBe(a);
    expect(await visitorId("salt-2", HOST, IP, UA)).not.toBe(a);
    expect(await visitorId("salt-1", "other.zaviagent.com", IP, UA)).not.toBe(a);
  });

  it("makes one random salt per UTC day (and tomorrow's a day early), each expiring within 3 days", async () => {
    const w = world();
    const s1 = await dailySalt(w.env, NOW);
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
    expect(w.puts.map((p) => [p.key, p.ttl])).toEqual([
      ["pvsalt:2026-10-07", PAGEVIEW_SALT_TTL_S],
      ["pvsalt:2026-10-08", PAGEVIEW_SALT_TTL_S],
    ]);
    expect(PAGEVIEW_SALT_TTL_S).toBeLessThanOrEqual(3 * 86400);
    expect(await dailySalt(w.env, NOW + 3600_000)).toBe(s1);
    const tomorrow = w.kv["pvsalt:2026-10-08"];
    resetPageViewState();
    expect(await dailySalt(w.env, NOW + 24 * 3600_000)).toBe(tomorrow);
    expect(tomorrow).not.toBe(s1);
  });

  it("uses the salt KV holds over one this isolate made, and never writes a day twice", async () => {
    const w = world();
    const made = await dailySalt(w.env, NOW);
    w.kv["pvsalt:2026-10-07"] = "f".repeat(64);
    expect(await dailySalt(w.env, NOW + 1000)).toBe("f".repeat(64));
    expect(w.puts.filter((p) => p.key === "pvsalt:2026-10-07")).toHaveLength(1);
    expect(made).not.toBe("f".repeat(64));
  });
});

describe("live pages carry the beacon", () => {
  it("a live page GET gets it; HEAD does not", async () => {
    const w = world();
    const res = await handle(new Request(`https://${HOST}/`, { headers: { accept: "text/html" } }), w.env, w.ctx, () => NOW);
    const body = await res.text();
    expect(body).toContain('data-zavi="pv"');
    expect(res.headers.get("content-length")).toBe(String(new TextEncoder().encode(body).length));
    expect(res.headers.get("etag")).toBeNull();
    const head = await handle(new Request(`https://${HOST}/`, { method: "HEAD", headers: { accept: "text/html" } }), w.env, w.ctx, () => NOW);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBeNull();
    expect(head.headers.get("etag")).toBeNull();
  });

  it("an old (non-SPA) site is left as it was", async () => {
    const w = world({ spa: false });
    const res = await handle(new Request(`https://${HOST}/`, { headers: { accept: "text/html" } }), w.env, w.ctx, () => NOW);
    expect(await res.text()).toBe(PAGE);
  });
});

describe("POST /__zavi/e", () => {
  it("a reload of the same page is counted once", async () => {
    mockFetch();
    const w = world();
    await handle(beacon({ p: "/menu" }), w.env, w.ctx, () => NOW);
    await handle(beacon({ p: "/menu" }), w.env, w.ctx, () => NOW + 5000);
    await w.settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("answers 204 and sends a signed event with a hashed visitor, never the IP, user agent or a cookie", async () => {
    mockFetch();
    const w = world();
    const res = await handle(
      beacon({ p: "/menu/?x=1", r: "www.google.com", s: "spring_promo" }, { cookie: "session=abc" }),
      w.env,
      w.ctx,
      () => NOW,
    );
    expect(res.status).toBe(204);
    await w.settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe(`https://api.zaviagent.com${PAGEVIEW_API_PATH}`);
    const body = String(init.body);
    const event = JSON.parse(body);
    expect(event).toEqual({
      hostname: HOST,
      path: "/menu",
      referrer_host: "www.google.com",
      source: "spring_promo",
      visitor: await visitorId(w.kv["pvsalt:2026-10-07"], HOST, IP, UA),
      device: "mobile",
      country: null,
    });
    const sent = JSON.stringify(init);
    expect(sent).not.toContain(IP);
    expect(sent).not.toContain("iPhone");
    expect(sent).not.toContain("session=abc");
    expect(sent).not.toContain(w.kv["pvsalt:2026-10-07"]);
    const ts = init.headers["x-zavi-pv-ts"];
    expect(init.headers["x-zavi-pv-sig"]).toBe(createHmac("sha256", SECRET).update(`pageview.${ts}.${body}`).digest("hex"));
  });

  it.each([
    ["a bot", beacon({ p: "/" }, { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" })],
    ["no user agent", beacon({ p: "/" }, { "user-agent": "" })],
    ["no client IP", beacon({ p: "/" }, { "cf-connecting-ip": "" })],
    ["a private page", beacon({ p: "/admin" })],
    ["a body that is not JSON", beacon("not json")],
    ["an oversized body", beacon({ p: "/", s: "x".repeat(3000) })],
  ])("drops %s quietly (204, nothing sent)", async (_name, request) => {
    mockFetch();
    const w = world();
    expect((await handle(request, w.env, w.ctx, () => NOW)).status).toBe(204);
    await w.settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts nothing for an unpublished, paused or old site, and 404s on a preview host", async () => {
    mockFetch();
    for (const w of [world({ paused: true }), world({ spa: false })]) {
      expect((await handle(beacon({ p: "/" }), w.env, w.ctx, () => NOW)).status).toBe(204);
      await w.settle();
    }
    const unknown = world();
    expect((await handle(beacon({ p: "/" }, {}, "nobody.zaviagent.com"), unknown.env, unknown.ctx, () => NOW)).status).toBe(204);
    const preview = world({ domain: "zavi-preview.dev" });
    expect((await handle(beacon({ p: "/" }, {}, `${"a".repeat(26)}.zavi-preview.dev`), preview.env, preview.ctx, () => NOW)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("other POSTs are still refused", async () => {
    const w = world();
    expect((await handle(new Request(`https://${HOST}/anything`, { method: "POST" }), w.env, w.ctx, () => NOW)).status).toBe(405);
  });
});
