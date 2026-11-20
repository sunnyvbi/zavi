import { describe, it, expect, vi, beforeEach } from "vitest";

const getUser = vi.fn(async () => ({ data: { user: null }, error: null }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser } }),
}));

import { isUnknownSiteHost } from "@/lib/siteHosts";
import { middleware } from "@/middleware";
import { NextRequest } from "next/server";
import { UNPUBLISHED_SITE_MESSAGE } from "@/lib/marketing/unpublishedSiteHost";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://wmyc.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
  getUser.mockClear();
});

const viaForwardedHost = (path: string, host: string, method = "GET") =>
  new NextRequest(`http://localhost:3000${path}`, { method, headers: { "x-forwarded-host": host } });

const viaHostHeader = (path: string, host: string) =>
  new NextRequest(`http://localhost:3000${path}`, { headers: { host } });

const SITE_HOSTS = [
  "334theobroma-4b5ad1a6.zaviagent.com",
  "334theobroma-4b5ad1a6-dev.zaviagent.com",
  "laptop-rental-shop-4b5ad1a6-97e7ea.zaviagent.com",
  "laptop-rental-shop-4b5ad1a6-97e7ea-dev.zaviagent.com",
  "company-0a1b2c3d-ffffff.zaviagent.com",
  "Laptop-Rental-Shop-4B5AD1A6-97E7EA.ZaviAgent.com:443",
];

describe("an unpublished site hostname gets the not-published page, never Zavi", () => {
  it.each(SITE_HOSTS.flatMap((h) => ["/", "/login", "/workspace", "/pricing", "/api/health"].map((p) => [h, p])))(
    "%s%s answers 404 with the not-published page",
    async (host, path) => {
      const res = await middleware(viaForwardedHost(path, host));
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
      expect(res.headers.get("x-middleware-next")).toBeNull();
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("set-cookie")).toBeNull();
      const body = await res.text();
      expect(body).toContain(UNPUBLISHED_SITE_MESSAGE);
      expect(body).not.toMatch(/grow your business|Get started|Sign in/i);
      expect(getUser).not.toHaveBeenCalled();
    },
  );

  it("answers HEAD with the same status and headers", async () => {
    const res = await middleware(viaForwardedHost("/", "334theobroma-4b5ad1a6.zaviagent.com", "HEAD"));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("reads the Host header when there is no forwarded host", async () => {
    const res = await middleware(viaHostHeader("/", "334theobroma-4b5ad1a6.zaviagent.com"));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain(UNPUBLISHED_SITE_MESSAGE);
  });

  it("uses the first forwarded host when a proxy chain lists several", async () => {
    const res = await middleware(viaForwardedHost("/", "334theobroma-4b5ad1a6.zaviagent.com, www.zaviagent.com"));
    expect(res.status).toBe(404);
  });
});

const WILDCARD_DNS_TTL_S = 300;

function scheduledReload(html: string): { seconds: number; target: string | null } | null {
  const tag = html.match(/<meta\s+http-equiv=["']?refresh["']?\s+content=["']([^"']*)["'][^>]*>/i);
  if (!tag) return null;
  const m = tag[1].match(/^\s*(\d+)\s*(?:[;,]\s*url\s*=\s*(.+))?$/i);
  if (!m) return null;
  return { seconds: Number(m[1]), target: m[2]?.trim() ?? null };
}

describe("a visitor whose resolver still sends a just-published site to the wildcard", () => {
  it.each(["/", "/book", "/menu/specials"])(
    "%s: the page reloads the same address on its own, so the visitor lands on the site once DNS moves",
    async (path) => {
      const res = await middleware(viaForwardedHost(path, "paws-suds-7a1c0b8e-4946f1.zaviagent.com"));
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const reload = scheduledReload(await res.text());
      expect(reload, "the not-published page must reload itself").not.toBeNull();
      expect(reload!.target).toBeNull();
      expect(reload!.seconds).toBeGreaterThan(0);
      expect(reload!.seconds).toBeLessThan(WILDCARD_DNS_TTL_S);
    },
  );

  it("HEAD still has no body", async () => {
    const res = await middleware(viaForwardedHost("/", "paws-suds-7a1c0b8e-4946f1.zaviagent.com", "HEAD"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });
});

describe("any host that is not shaped like a site reaches the app", () => {
  it.each([
    "www.zaviagent.com",
    "zaviagent.com",
    "latest.zaviagent.com",
    "newthing.zaviagent.com",
    "admin.zaviagent.com",
    "api-staging.zaviagent.com",
    "bakery.zaviagent.com",
    "localhost:3000",
    "main.d1abc23xyz.amplifyapp.com",
  ])("%s reaches the app", async (host) => {
    for (const path of ["/", "/login", "/workspace"]) {
      const res = await middleware(viaForwardedHost(path, host));
      if (isUnknownSiteHost(host)) expect(res.status).toBe(404);
      else expect(res.status).not.toBe(404);
      if (!isUnknownSiteHost(host)) expect(res.headers.get("x-robots-tag")).toBeNull();
      expect(await res.text()).not.toContain(UNPUBLISHED_SITE_MESSAGE);
    }
  });

  it.each([
    ["seven hex chars", "shop-4b5ad1a.zaviagent.com"],
    ["nine hex chars", "shop-4b5ad1a60.zaviagent.com"],
    ["non-hex in the tenant hash", "shop-4b5ad1g6.zaviagent.com"],
    ["no name before the hash", "4b5ad1a6.zaviagent.com"],
    ["seven hex site id plus suffix", "shop-4b5ad1a6-97e7eaf-dev.zaviagent.com"],
    ["env suffix longer than ten", "shop-4b5ad1a6-abcdefghijk.zaviagent.com"],
    ["double hyphen", "shop--4b5ad1a6.zaviagent.com"],
    ["two labels", "a.shop-4b5ad1a6.zaviagent.com"],
    ["another domain", "shop-4b5ad1a6.zaviagent.com.evil.example"],
    ["the bare apex", "zaviagent.com"],
    ["a label longer than 63", `${"a".repeat(55)}-4b5ad1a6.zaviagent.com`],
  ])("near-miss (%s) %s does not get the page", async (_why, host) => {
    const res = await middleware(viaForwardedHost("/", host));
    expect(await res.text()).not.toContain(UNPUBLISHED_SITE_MESSAGE);
  });

  it("retired segment hosts still 301 to www", async () => {
    const res = await middleware(viaForwardedHost("/pricing", "growth.zaviagent.com"));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://www.zaviagent.com/pricing");
  });
});
