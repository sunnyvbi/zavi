import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: () => { throw new Error("no db in this test"); } }));

import { ensureStaticRouting, matchingWildcardRoute, restoreRenderRouting } from "../static-publish";
import { FULL_ENV, FakeCloudflare } from "./static-fakes";

const HOST = "acme-1234abcd.zaviagent.com";

describe("static routing", () => {
  let cf: FakeCloudflare;
  const deps = () => ({ env: FULL_ENV, fetchFn: cf.fetch });
  beforeEach(() => {
    cf = new FakeCloudflare();
  });

  it("is not_configured without the static env and makes no calls", async () => {
    expect(await ensureStaticRouting(HOST, { env: { ...FULL_ENV, CLOUDFLARE_ZONE_ID: "" }, fetchFn: cf.fetch })).toEqual({ ok: false, error: "not_configured" });
    expect(cf.calls).toHaveLength(0);
  });

  it("routes a Render CNAME host to the worker, is idempotent, and restore puts the original DNS back", async () => {
    const original = { id: "dnsR", name: HOST, type: "CNAME", content: "acme.onrender.com", proxied: false, ttl: 300 };
    const unrelated = { id: "dnsW", name: "www.zaviagent.com", type: "CNAME", content: "x.onrender.com", proxied: false, ttl: 300 };
    cf.dns = [{ ...original }, { ...unrelated }];
    cf.routes = [{ id: "rOther", pattern: "zaviagent.com/*", script: "marketing" }];

    const first = await ensureStaticRouting(HOST.toUpperCase(), deps());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.changed).toBe(true);
    expect(cf.routes).toContainEqual(expect.objectContaining({ pattern: `${HOST}/*`, script: "zavi-static-host" }));
    expect(cf.dns.find((d) => d.id === "dnsR")).toEqual({ ...original, proxied: true });
    expect(cf.dns.find((d) => d.id === "dnsW")).toEqual(unrelated);

    const writes = cf.mutations().length;
    const second = await ensureStaticRouting(HOST, deps());
    expect(second).toEqual({ ok: true, changed: false, previous: { dns: [], created_dns_id: null, route: null, created_route_id: null } });
    expect(cf.mutations()).toHaveLength(writes);
    expect(cf.routes.filter((r) => r.pattern === `${HOST}/*`)).toHaveLength(1);

    expect(await restoreRenderRouting(HOST, first.previous, deps())).toEqual({ ok: true });
    expect(cf.dns).toEqual([original, unrelated]);
    expect(cf.routes).toEqual([{ id: "rOther", pattern: "zaviagent.com/*", script: "marketing" }]);
  });

  it("creates a proxied placeholder A record when the host has no DNS and restore removes it", async () => {
    const r = await ensureStaticRouting(HOST, deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(cf.dns).toEqual([expect.objectContaining({ name: HOST, type: "A", content: "192.0.2.1", proxied: true })]);
    expect(await restoreRenderRouting(HOST, r.previous, deps())).toEqual({ ok: true });
    expect(cf.dns).toEqual([]);
    expect(cf.routes).toEqual([]);
  });

  it("repoints a route owned by another script and restore hands it back", async () => {
    cf.dns = [{ id: "d1", name: HOST, type: "CNAME", content: "acme.onrender.com", proxied: true, ttl: 1 }];
    cf.routes = [{ id: "r1", pattern: `${HOST}/*`, script: "legacy" }];
    const r = await ensureStaticRouting(HOST, deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(cf.routes).toEqual([{ id: "r1", pattern: `${HOST}/*`, script: "zavi-static-host" }]);
    expect(r.previous.dns).toEqual([]);
    await restoreRenderRouting(HOST, r.previous, deps());
    expect(cf.routes).toEqual([{ id: "r1", pattern: `${HOST}/*`, script: "legacy" }]);
    expect(cf.dns[0].proxied).toBe(true);
  });

  it("rolls the route back when the DNS step fails", async () => {
    cf.dns = [{ id: "d1", name: HOST, type: "CNAME", content: "acme.onrender.com", proxied: false, ttl: 300 }];
    const realFetch = cf.fetch;
    cf.fetch = async (url, init) =>
      init?.method === "PATCH" ? { status: 500, headers: { get: () => null }, text: async () => JSON.stringify({ success: false, errors: [{ code: 1, message: "dns down" }] }) } : realFetch(url, init);
    const r = await ensureStaticRouting(HOST, deps());
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain("dns down");
    expect(cf.routes).toEqual([]);
    expect(cf.dns[0].proxied).toBe(false);
  });

  it("returns the routing snapshot when the DNS step fails and the route cannot be undone", async () => {
    cf.dns = [{ id: "d1", name: HOST, type: "CNAME", content: "acme.onrender.com", proxied: false, ttl: 300 }];
    const realFetch = cf.fetch;
    const down = { status: 500, headers: { get: () => null }, text: async () => JSON.stringify({ success: false, errors: [{ code: 1, message: "cf down" }] }) };
    cf.fetch = async (url, init) => (init?.method === "PATCH" || init?.method === "DELETE" ? down : realFetch(url, init));
    const r = await ensureStaticRouting(HOST, deps());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("restore:");
    expect(r.previous?.created_route_id).toBeTruthy();
  });

  it("a retried restore treats an already-deleted route or record (404) as done", async () => {
    const r = await ensureStaticRouting(HOST, deps());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await restoreRenderRouting(HOST, r.previous, deps())).toEqual({ ok: true });
    expect(await restoreRenderRouting(HOST, r.previous, deps())).toEqual({ ok: true });
  });

  describe("zone wildcard", () => {
    const WILD_DNS = { id: "w", name: "*.zaviagent.com", type: "A", content: "192.0.2.1", proxied: true, ttl: 1 };
    const WILD_ROUTES = [
      { id: "wp", pattern: "*.zaviagent.com/*", script: "zavi-static-host" },
      { id: "wa", pattern: "*.zaviagent.com/api/*", script: "zavi-site-gateway" },
    ];
    const DEV_HOST = "acme-1234abcd-dev.zaviagent.com";

    it("adds no record and no route when the proxied wildcard and its route serve the host", async () => {
      cf.dns = [{ ...WILD_DNS }];
      cf.routes = WILD_ROUTES.map((r) => ({ ...r }));
      const r = await ensureStaticRouting(HOST, deps());
      expect(r).toEqual({ ok: true, changed: false, previous: { dns: [], created_dns_id: null, route: null, created_route_id: null } });
      expect(cf.mutations()).toEqual([]);
    });

    it("adds a placeholder record but no route while the wildcard record is still DNS-only", async () => {
      cf.dns = [{ ...WILD_DNS, type: "CNAME", content: "d1.cloudfront.net", proxied: false }];
      cf.routes = WILD_ROUTES.map((r) => ({ ...r }));
      const r = await ensureStaticRouting(HOST, deps());
      expect(r.ok && r.changed).toBe(true);
      expect(cf.dns).toContainEqual(expect.objectContaining({ name: HOST, content: "192.0.2.1", proxied: true }));
      expect(cf.routes.map((x) => x.pattern)).not.toContain(`${HOST}/*`);
    });

    it("adds a placeholder record when any record (even TXT) sits at the exact name, since it blocks the wildcard", async () => {
      cf.dns = [{ ...WILD_DNS }, { id: "t", name: HOST, type: "TXT", content: "v=x", proxied: false, ttl: 1 }];
      cf.routes = WILD_ROUTES.map((r) => ({ ...r }));
      await ensureStaticRouting(HOST, deps());
      expect(cf.dns).toContainEqual(expect.objectContaining({ name: HOST, type: "A", content: "192.0.2.1" }));
    });

    it("a dev host keeps its own exact route to the dev Worker but needs no DNS record", async () => {
      cf.dns = [{ ...WILD_DNS }];
      cf.routes = WILD_ROUTES.map((r) => ({ ...r }));
      const r = await ensureStaticRouting(DEV_HOST, { env: { ...FULL_ENV, ZAVI_STATIC_WORKER_NAME: "zavi-static-host-dev" }, fetchFn: cf.fetch });
      expect(r.ok).toBe(true);
      expect(cf.routes).toContainEqual(expect.objectContaining({ pattern: `${DEV_HOST}/*`, script: "zavi-static-host-dev" }));
      expect(cf.dns.filter((d) => d.name === DEV_HOST)).toEqual([]);
    });

    it("keeps an existing exact route in charge (it beats the wildcard)", async () => {
      cf.dns = [{ ...WILD_DNS }];
      cf.routes = [...WILD_ROUTES.map((r) => ({ ...r })), { id: "ex", pattern: `${HOST}/*`, script: "legacy" }];
      await ensureStaticRouting(HOST, deps());
      expect(cf.routes.find((r) => r.id === "ex")?.script).toBe("zavi-static-host");
    });

    it("matchingWildcardRoute returns the one matching wildcard, and none when two wildcards match", () => {
      expect(matchingWildcardRoute(WILD_ROUTES, "shop.zaviagent.com", "/*")?.id).toBe("wp");
      expect(matchingWildcardRoute(WILD_ROUTES, "shop.zaviagent.com", "/api/*")?.id).toBe("wa");
      expect(matchingWildcardRoute(WILD_ROUTES, "zaviagent.com", "/*")).toBeNull();
      expect(matchingWildcardRoute(WILD_ROUTES, "shop.other.com", "/*")).toBeNull();
      const two = [...WILD_ROUTES, { id: "wd", pattern: "*-dev.zaviagent.com/*", script: "dev" }];
      expect(matchingWildcardRoute(two, "shop-dev.zaviagent.com", "/*")).toBeNull();
    });
  });
});
