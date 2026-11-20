
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  }),
}));

import { middleware, config, HOST_CHECK_ONLY_PATH } from "@/middleware";
import { NextRequest } from "next/server";
import { isUnknownSiteHost, normalizeHost } from "@/lib/siteHosts";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://wmyc.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

const req = (url: string, forwardedHost: string, method = "GET") =>
  new NextRequest(url, { method, headers: { "x-forwarded-host": forwardedHost } });

describe("unknown site hosts answer 404", () => {
  it.each(["nosuchsite-xyz123.zaviagent.com", "deleted-shop-1a2b.zaviagent.com", "a.b.zaviagent.com", "app.zaviagent.com"])(
    "%s gets the site-not-found page",
    async (host) => {
      const res = await middleware(req("http://localhost:3000/", host));
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("location")).toBeNull();
      const body = await res.text();
      expect(body).toContain("Site not found");
      expect(body).toContain('name="robots" content="noindex, nofollow"');
    },
  );

  it("every path and method on an unknown host is 404, HEAD has no body", async () => {
    const res = await middleware(req("http://localhost:3000/workspace?x=1", "typo-site.zaviagent.com"));
    expect(res.status).toBe(404);
    const head = await middleware(req("http://localhost:3000/", "typo-site.zaviagent.com", "HEAD"));
    expect(head.status).toBe(404);
    expect(await head.text()).toBe("");
  });

  it("does not set the region cookie on a 404", async () => {
    const r = new NextRequest("http://localhost:3000/", {
      headers: { "x-forwarded-host": "typo-site.zaviagent.com", "cloudfront-viewer-country": "DE" },
    });
    const res = await middleware(r);
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("host casing, port, trailing dot and a forwarded list are normalised", async () => {
    for (const host of ["TYPO.ZaviAgent.com", "typo.zaviagent.com:443", "typo.zaviagent.com.", "typo.zaviagent.com, www.zaviagent.com"]) {
      const res = await middleware(req("http://localhost:3000/", host));
      expect(res.status, host).toBe(404);
    }
  });
});

describe("hosts the web app serves keep working", () => {
  it.each(["www.zaviagent.com", "latest.zaviagent.com", "staging.zaviagent.com", "WWW.zaviagent.com."])(
    "%s renders normally",
    async (host) => {
      const res = await middleware(req("http://localhost:3000/", host));
      expect(res.status).toBe(200);
    },
  );

  it("apex is not a site host", () => {
    expect(isUnknownSiteHost("zaviagent.com")).toBe(false);
  });

  it.each(["marketplaces", "solo", "growth", "saas", "startup"])(
    "retired segment %s still 301s to www",
    async (sub) => {
      const res = await middleware(req("http://localhost:3000/pricing", `${sub}.zaviagent.com`));
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("https://www.zaviagent.com/pricing");
    },
  );

  it.each(["api.zaviagent.com", "admin.zaviagent.com"])("%s is never answered with site-not-found", (host) => {
    expect(isUnknownSiteHost(host)).toBe(false);
  });

  it.each([
    "localhost:3000",
    "127.0.0.1",
    "[::1]:3000",
    "main.d1abc.amplifyapp.com",
    "abcdefghijklmnopqrstuvwxyz.zavi-preview.dev",
    "zaviagent.com.evil.com",
    "evilzaviagent.com",
  ])("%s (outside the zone) is untouched", async (host) => {
    expect(isUnknownSiteHost(host)).toBe(false);
    const res = await middleware(req("http://localhost:3000/", host));
    expect(res.status).toBe(200);
  });

  it("a request with no host header is untouched", async () => {
    const res = await middleware(new NextRequest("http://localhost:3000/"));
    expect(res.status).toBe(200);
  });

  it("the configured NEXT_PUBLIC_SITE_URL host is served", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://preview-web.zaviagent.com";
    expect(isUnknownSiteHost("preview-web.zaviagent.com")).toBe(false);
    expect(isUnknownSiteHost("other.zaviagent.com")).toBe(true);
  });
});

describe("normalizeHost", () => {
  it("takes the first forwarded entry, lowercases, drops port and trailing dots", () => {
    expect(normalizeHost(" Foo.ZaviAgent.com.:8443 , x")).toBe("foo.zaviagent.com");
    expect(normalizeHost(null)).toBe("");
    expect(normalizeHost("[::1]:3000")).toBe("[::1]:3000");
  });
});

describe("public files the main matcher skips", () => {
  const files = [
    "/robots.txt",
    "/sitemap.xml",
    "/llms.txt",
    "/pricing.md",
    "/manifest.webmanifest",
    "/icon.svg",
    "/favicon.ico",
    "/apple-app-site-association",
    "/.well-known/assetlinks.json",
    "/opengraph-image",
    "/zavi-editor-runtime.js",
    "/mascots/video/wave.mp4",
  ];

  it.each(files)("%s is 404 on an unknown host", async (path) => {
    const res = await middleware(req(`http://localhost:3000${path}`, "deleted-site.zaviagent.com"));
    expect(res.status).toBe(404);
  });

  it.each(files)("%s passes straight through on www (no auth redirect, no cookie)", async (path) => {
    const res = await middleware(req(`http://localhost:3000${path}`, "www.zaviagent.com"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("the host-check matcher entry covers exactly HOST_CHECK_ONLY_PATH", () => {
    const entry = config.matcher[0]!;
    const re = new RegExp(`^${entry}$`);
    for (const p of files) {
      expect(re.test(p), p).toBe(true);
      expect(HOST_CHECK_ONLY_PATH.test(p), p).toBe(true);
    }
    for (const p of ["/", "/pricing", "/login", "/workspace", "/robots.txt.bak"]) {
      expect(HOST_CHECK_ONLY_PATH.test(p), p).toBe(false);
      expect(re.test(p), p).toBe(false);
    }
  });

  it("a trailing-dot retired host still 301s to www", async () => {
    const res = await middleware(req("http://localhost:3000/pricing", "growth.zaviagent.com."));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://www.zaviagent.com/pricing");
  });
});
