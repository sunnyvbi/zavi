import { describe, expect, it } from "vitest";
import { cloudflareGatewayRoutes, gatewayRoutePattern } from "../gateway-route";
import type { StaticFetch } from "@/services/hosting/static-publish";

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_STATIC_API_TOKEN: "tok", CLOUDFLARE_ZONE_ID: "zone",
  ZAVI_STATIC_R2_BUCKET: "b", ZAVI_STATIC_KV_NAMESPACE_ID: "kv", ZAVI_STATIC_WORKER_NAME: "zavi-static-host",
  ZAVI_SITE_GATEWAY_WORKER_NAME: "zavi-site-gateway",
};

function cf(routes: Array<{ id: string; pattern: string; script: string }>) {
  const log: string[] = [];
  const fetchFn = (async (url: string, init?: { method?: string; body?: string | Uint8Array }) => {
    const method = init?.method ?? "GET";
    log.push(`${method} ${url.replace("https://api.cloudflare.com/client/v4", "")}`);
    let result: unknown = null;
    if (method === "GET") result = routes;
    if (method === "POST") {
      const b = JSON.parse(String(init?.body));
      routes.push({ id: `r${routes.length + 1}`, ...b });
      result = routes.at(-1);
    }
    if (method === "DELETE") {
      const id = url.split("/").pop();
      routes.splice(routes.findIndex((r) => r.id === id), 1);
    }
    const text = JSON.stringify({ success: true, result });
    return { status: 200, headers: { get: () => "application/json" }, text: async () => text };
  }) as unknown as StaticFetch;
  return { fetchFn, log, routes };
}

describe("gateway /api/* route", () => {
  it("pattern is the normalized hostname + /api/*", () => {
    expect(gatewayRoutePattern("Shop-AB12.zaviagent.com:443")).toBe("shop-ab12.zaviagent.com/api/*");
  });

  it("creates <host>/api/* -> gateway once, next to static-host's <host>/*; removes only its own", async () => {
    const c = cf([{ id: "s1", pattern: "shop.zaviagent.com/*", script: "zavi-static-host" }]);
    const r = cloudflareGatewayRoutes({ env: ENV, fetchFn: c.fetchFn });
    await r.ensure("shop.zaviagent.com");
    await r.ensure("shop.zaviagent.com");
    expect(c.routes.map((x) => `${x.pattern}->${x.script}`)).toEqual([
      "shop.zaviagent.com/*->zavi-static-host",
      "shop.zaviagent.com/api/*->zavi-site-gateway",
    ]);
    await r.remove("shop.zaviagent.com");
    await r.remove("shop.zaviagent.com");
    expect(c.routes.map((x) => x.pattern)).toEqual(["shop.zaviagent.com/*"]);
  });

  it("never takes over or deletes a route owned by another worker", async () => {
    const c = cf([{ id: "x", pattern: "shop.zaviagent.com/api/*", script: "someone-else" }]);
    const r = cloudflareGatewayRoutes({ env: ENV, fetchFn: c.fetchFn });
    await expect(r.ensure("shop.zaviagent.com")).rejects.toThrow(/another worker/);
    await expect(r.remove("shop.zaviagent.com")).rejects.toThrow(/another worker/);
    expect(c.routes).toHaveLength(1);
  });

  it("missing gateway worker config is SiteCredentialsMissing (no call made)", async () => {
    const c = cf([]);
    const { ZAVI_SITE_GATEWAY_WORKER_NAME: _drop, ...env } = ENV;
    await expect(cloudflareGatewayRoutes({ env, fetchFn: c.fetchFn }).ensure("shop.zaviagent.com")).rejects.toThrow(/ZAVI_SITE_GATEWAY_WORKER_NAME/);
    expect(c.log).toEqual([]);
  });

  it("adds no per-site route when the zone wildcard /api/* route already points at the gateway", async () => {
    const c = cf([
      { id: "w1", pattern: "*.zaviagent.com/*", script: "zavi-static-host" },
      { id: "w2", pattern: "*.zaviagent.com/api/*", script: "zavi-site-gateway" },
    ]);
    await cloudflareGatewayRoutes({ env: ENV, fetchFn: c.fetchFn }).ensure("shop.zaviagent.com");
    expect(c.log.filter((l) => !l.startsWith("GET"))).toEqual([]);
  });

  it("still adds <host>/api/* when the host has its own exact route (an exact host beats the wildcard)", async () => {
    const c = cf([
      { id: "w2", pattern: "*.zaviagent.com/api/*", script: "zavi-site-gateway" },
      { id: "s1", pattern: "shop.zaviagent.com/*", script: "zavi-static-host" },
    ]);
    await cloudflareGatewayRoutes({ env: ENV, fetchFn: c.fetchFn }).ensure("shop.zaviagent.com");
    expect(c.routes.map((x) => x.pattern)).toContain("shop.zaviagent.com/api/*");
  });

  it("a dev gateway still adds its own route (the wildcard belongs to the prod gateway)", async () => {
    const c = cf([{ id: "w2", pattern: "*.zaviagent.com/api/*", script: "zavi-site-gateway" }]);
    await cloudflareGatewayRoutes({ env: { ...ENV, ZAVI_SITE_GATEWAY_WORKER_NAME: "zavi-site-gateway-dev" }, fetchFn: c.fetchFn }).ensure("shop-dev.zaviagent.com");
    expect(c.routes).toContainEqual(expect.objectContaining({ pattern: "shop-dev.zaviagent.com/api/*", script: "zavi-site-gateway-dev" }));
  });
});
