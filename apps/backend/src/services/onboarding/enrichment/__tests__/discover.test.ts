
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  return { ...actual, promises: { ...actual.promises, lookup: vi.fn() } };
});
import { promises as dns } from "node:dns";
const mockLookup = dns.lookup as unknown as ReturnType<typeof vi.fn>;

import {
  parseSitemap,
  extractNavLinks,
  classifyPageTopic,
  parseRobots,
  safeFetchText,
  discoverUrls,
  gunzipCapped,
  isGzip,
  MAX_SITEMAP_ENTRIES,
} from "../discover";
import { gzipSync } from "node:zlib";

const PUBLIC_IP = [{ address: "93.184.216.34", family: 4 }];
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});
beforeEach(() => mockLookup.mockResolvedValue(PUBLIC_IP));

describe("parseSitemap (XXE-safe, bounded)", () => {
  it("extracts <loc> urls", () => {
    const xml = `<urlset><url><loc>https://acme.com/sell</loc></url><url><loc>https://acme.com/customers</loc></url></urlset>`;
    expect(parseSitemap(xml)).toEqual(["https://acme.com/sell", "https://acme.com/customers"]);
  });
  it("strips DOCTYPE / ENTITY (no XXE entity resolution)", () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><urlset><url><loc>https://acme.com/x</loc></url></urlset>`;
    const out = parseSitemap(xml);
    expect(out).toEqual(["https://acme.com/x"]);
    expect(JSON.stringify(out)).not.toContain("passwd");
  });
  it("decodes only the 5 predefined entities", () => {
    expect(parseSitemap(`<urlset><url><loc>https://acme.com/a?b=1&amp;c=2</loc></url></urlset>`)).toEqual([
      "https://acme.com/a?b=1&c=2",
    ]);
  });
  it("caps at MAX_SITEMAP_ENTRIES", () => {
    const many = Array.from({ length: MAX_SITEMAP_ENTRIES + 50 }, (_, i) => `<url><loc>https://acme.com/p${i}</loc></url>`).join("");
    expect(parseSitemap(`<urlset>${many}</urlset>`).length).toBe(MAX_SITEMAP_ENTRIES);
  });
  it("empty / garbage → []", () => {
    expect(parseSitemap("")).toEqual([]);
    expect(parseSitemap("not xml")).toEqual([]);
  });
});

describe("classifyPageTopic (strict, negative-guarded)", () => {
  it("path match → topic, but not strong without text signal", () => {
    expect(classifyPageTopic("https://acme.com/sell", "", "")).toEqual({ topic: "SUPPLY", strong: false });
    expect(classifyPageTopic("https://acme.com/customers", "", "")).toEqual({ topic: "ICP", strong: false });
  });
  it("text/anchor signal → strong", () => {
    expect(classifyPageTopic("https://acme.com/hosts", "Become a host", "")).toEqual({ topic: "SUPPLY", strong: true });
    expect(classifyPageTopic("https://acme.com/x", "", "Read our case study with BigCo")).toEqual({ topic: "CLIENTS", strong: true });
  });
  it("NEGATIVE: /sell-your-privacy must NOT classify as SUPPLY", () => {
    expect(classifyPageTopic("https://acme.com/sell-your-privacy", "", "")).toBeNull();
    expect(classifyPageTopic("https://acme.com/privacy", "", "")).toBeNull();
    expect(classifyPageTopic("https://acme.com/products/privacy-policy", "", "")).toBeNull();
  });
  it("no signal anywhere → null", () => {
    expect(classifyPageTopic("https://acme.com/blog/random", "Read more", "lorem ipsum")).toBeNull();
  });
});

describe("extractNavLinks", () => {
  it("pulls href + anchor, resolves relative", () => {
    const html = `<nav><a href="/sell">Become a host</a><a href="https://acme.com/customers">Customers</a></nav>`;
    const links = extractNavLinks(html, "https://acme.com/");
    expect(links).toContainEqual({ url: "https://acme.com/sell", anchor: "Become a host" });
    expect(links).toContainEqual({ url: "https://acme.com/customers", anchor: "Customers" });
  });
});

describe("parseRobots", () => {
  it("extracts Sitemap: lines, caps at 10", () => {
    expect(parseRobots("User-agent: *\nSitemap: https://acme.com/sitemap.xml\nDisallow: /admin").sitemaps).toEqual([
      "https://acme.com/sitemap.xml",
    ]);
  });
});

describe("safeFetchText (SSRF guard)", () => {
  it("blocks a private-IP host (assertSafeUrl) → null", async () => {
    mockLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    globalThis.fetch = vi.fn(async () => new Response("secret", { status: 200 })) as never;
    const r = await safeFetchText("https://internal.acme.com/x", "acme.com", Date.now() + 5000, 1024);
    expect(r).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("rejects a redirect that leaves the apex/www", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "https://evil.com/x" } }),
    ) as never;
    const r = await safeFetchText("https://acme.com/sitemap.xml", "acme.com", Date.now() + 5000, 1024);
    expect(r).toBeNull();
  });
  it("follows a redirect to another host only when the caller's rule allows it, still guarding every hop", async () => {
    const hop = () =>
      vi.fn(async (url: string) =>
        url.startsWith("https://acme.com/")
          ? new Response(null, { status: 301, headers: { location: "https://shop.acme.com/p" } })
          : new Response("landed", { status: 200 }),
      ) as never;
    globalThis.fetch = hop();
    expect(await safeFetchText("https://acme.com/p", "acme.com", Date.now() + 5000, 1024)).toBeNull();
    globalThis.fetch = hop();
    const allow = (h: string) => h === "acme.com" || h.endsWith(".acme.com");
    expect(await safeFetchText("https://acme.com/p", "acme.com", Date.now() + 5000, 1024, allow)).toBe("landed");
    mockLookup.mockImplementation(async (host: string) => (host === "shop.acme.com" ? [{ address: "10.0.0.5", family: 4 }] : PUBLIC_IP));
    globalThis.fetch = hop();
    expect(await safeFetchText("https://acme.com/p", "acme.com", Date.now() + 5000, 1024, allow)).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
  it("returns body text on a clean 200", async () => {
    globalThis.fetch = vi.fn(async () => new Response("hello", { status: 200 })) as never;
    const r = await safeFetchText("https://acme.com/robots.txt", "acme.com", Date.now() + 5000, 1024);
    expect(r).toBe("hello");
  });
});

describe("gzipped sitemaps (.xml.gz)", () => {
  const urlset = (n: number) =>
    `<?xml version="1.0"?><urlset>${Array.from({ length: n }, (_, i) => `<url><loc>https://acme.com/p/${i}</loc></url>`).join("")}</urlset>`;

  it("safeFetchText inflates a .gz body served without Content-Encoding", async () => {
    const gz = gzipSync(Buffer.from(urlset(3)));
    globalThis.fetch = vi.fn(async () => new Response(gz, { status: 200, headers: { "content-type": "application/x-gzip" } })) as never;
    const r = await safeFetchText("https://acme.com/sitemap.xml.gz", "acme.com", Date.now() + 5000, 512 * 1024);
    expect(parseSitemap(r ?? "")).toEqual(["https://acme.com/p/0", "https://acme.com/p/1", "https://acme.com/p/2"]);
  });

  it("recognises gzip by its magic bytes, not the URL", () => {
    expect(isGzip(gzipSync(Buffer.from("x")))).toBe(true);
    expect(isGzip(Buffer.from("<urlset>"))).toBe(false);
  });

  it("holds a gzip bomb to the output cap", async () => {
    const bomb = gzipSync(Buffer.alloc(20 * 1024 * 1024, 0x61));
    const out = await gunzipCapped(bomb, 1024);
    expect(out).toHaveLength(1024);
  });

  it("keeps every URL that inflated from a TRUNCATED .gz (the read cap cut the download)", async () => {
    const gz = gzipSync(Buffer.from(urlset(5000)));
    const half = gz.subarray(0, Math.floor(gz.length / 2));
    const locs = parseSitemap((await gunzipCapped(half, 10 * 1024 * 1024)) ?? "");
    expect(locs.length).toBeGreaterThan(100);
    expect(locs[0]).toBe("https://acme.com/p/0");
  });

  it("returns null for bytes that only look like gzip", async () => {
    expect(await gunzipCapped(Buffer.from([0x1f, 0x8b, 0, 0, 0]), 1024)).toBeNull();
  });
});

describe("discoverUrls (apex-only, classified, capped)", () => {
  it("rejects off-apex sitemap <loc> + keeps only topic-classified apex pages", async () => {
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (u.endsWith("/sitemap.xml")) {
        return new Response(
          `<urlset>
             <url><loc>https://acme.com/sell</loc></url>
             <url><loc>https://blog.acme.com/post</loc></url>
             <url><loc>https://evil.com/sell</loc></url>
             <url><loc>https://acme.com/privacy</loc></url>
           </urlset>`,
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    }) as never;
    const picked = await discoverUrls("acme.com", Date.now());
    const urls = picked.map((p) => p.url);
    expect(urls).toContain("https://acme.com/sell");
    expect(urls).not.toContain("https://blog.acme.com/post");
    expect(urls).not.toContain("https://evil.com/sell");
    expect(urls.some((u) => u.includes("privacy"))).toBe(false);
    expect(picked.length).toBeLessThanOrEqual(4);
  });
});
