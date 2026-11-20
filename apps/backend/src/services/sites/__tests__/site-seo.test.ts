import { describe, expect, it } from "vitest";
import { TEMPLATE_FILES as DEDICATED } from "@/services/provisioning/templates/vite-react-supabase/template-files.generated";
import { TEMPLATE_FILES as POOLED } from "@/services/provisioning/templates/vite-react-zavi/template-files.generated";
import {
  isPrivatePath,
  pagePathOf,
  robotsTxt,
  siteOrigin,
  sitemapXml,
  withCanonicalLink,
  zaviSeo,
} from "@/services/provisioning/templates/vite-react-zavi/files/vite-zavi-seo";
import robotsParser from "robots-parser";
import { analyzeGeo } from "@/services/tools/growth/geo/analyze";
import { personalizeSiteStarter } from "../site-head";

const HOME =
  '<!doctype html><html><head><title>Home</title>\n  </head><body><div id="root"></div></body></html>';

type Emitted = { type: "asset"; fileName: string; source: string };

async function build(plugin: ReturnType<typeof zaviSeo>, bundle: Record<string, { type: string; source?: unknown }>) {
  const emitted: Emitted[] = [];
  plugin.configResolved({ publicDir: "" });
  await plugin.generateBundle.call({ emitFile: (f: Emitted) => (emitted.push(f), f.fileName) }, {}, bundle);
  return Object.fromEntries(emitted.map((f) => [f.fileName, f.source]));
}

describe("both starters ship the SEO plugin", () => {
  it.each([["vite-react-supabase", DEDICATED], ["vite-react-zavi", POOLED]] as const)("%s", (_name, files) => {
    expect(files["vite-zavi-seo.ts"]).toBe(POOLED["vite-zavi-seo.ts"]);
    expect(files["vite.config.ts"]).toContain('import { zaviSeo } from "./vite-zavi-seo";');
    expect(files["vite.config.ts"]).toMatch(/zaviHead\(ZAVI_HEAD[^)]*\), zaviSeo\(ZAVI_HEAD\)/);
    expect(files["vite-zavi-seo.ts"]).not.toMatch(/from\s+["']node:/);
  });
});

describe("pure parts", () => {
  it("takes the origin from the public address, and none from an empty or odd one", () => {
    expect(siteOrigin({ url: "https://acme-1a2b3c4d.zaviagent.com/" })).toBe("https://acme-1a2b3c4d.zaviagent.com");
    expect(siteOrigin({ url: "" })).toBe("");
    expect(siteOrigin({})).toBe("");
    expect(siteOrigin({ url: "javascript:alert(1)" })).toBe("");
  });

  it("maps dist HTML files to addresses", () => {
    expect(pagePathOf("index.html")).toBe("/");
    expect(pagePathOf("menu/index.html")).toBe("/menu");
    expect(pagePathOf("about/team/index.html")).toBe("/about/team");
    expect(pagePathOf("pricing.html")).toBe("/pricing");
    expect(pagePathOf("404.html")).toBeNull();
    expect(pagePathOf("assets/index-abc.js")).toBeNull();
    expect(pagePathOf("../x.html")).toBeNull();
  });

  it("keeps the sign-in and admin pages private, but not pages that only start with the same letters", () => {
    expect(isPrivatePath("/admin")).toBe(true);
    expect(isPrivatePath("/auth/confirm")).toBe(true);
    expect(isPrivatePath("/administration")).toBe(false);
    expect(isPrivatePath("/accounting")).toBe(false);
    const robots = robotsTxt("https://x.zaviagent.com");
    expect(robots).toContain("User-agent: *\nAllow: /\n");
    expect(robots).toContain("Disallow: /admin$\nDisallow: /admin?\nDisallow: /admin/\n");
    expect(robots).toContain("Sitemap: https://x.zaviagent.com/sitemap.xml\n");
    expect(robotsTxt("")).not.toContain("Sitemap");
  });

  it("lists home first, once, escaped, without private pages", () => {
    const out = sitemapXml("https://x.zaviagent.com", ["/menu", "/", "/admin", "/q&a"], "2026-10-07");
    const locs = [...out.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(["https://x.zaviagent.com/", "https://x.zaviagent.com/menu", "https://x.zaviagent.com/q&amp;a"]);
    expect(out).toContain("<lastmod>2026-10-07</lastmod>");
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it("adds a canonical only where the page has none", () => {
    const withLink = withCanonicalLink(HOME, "https://x.zaviagent.com", "/menu");
    expect(withLink).toContain('<link rel="canonical" href="https://x.zaviagent.com/menu" />');
    expect(withCanonicalLink(withLink, "https://x.zaviagent.com", "/other")).toBe(withLink);
    expect(withCanonicalLink(HOME, "", "/menu")).toBe(HOME);
  });
});

describe("robots.txt as a real crawler reads it", () => {
  const body = robotsTxt("https://x.zaviagent.com");
  const robots = robotsParser("https://x.zaviagent.com/robots.txt", body);
  it.each([
    ["/", true],
    ["/menu", true],
    ["/administration-services", true],
    ["/accounting", true],
    ["/admin", false],
    ["/admin/orders", false],
    ["/login?next=/admin", false],
    ["/account?welcome=1", false],
    ["/auth/confirm", false],
  ])("%s allowed: %s", (path, allowed) => {
    expect(robots.isAllowed(`https://x.zaviagent.com${path}`, "GPTBot")).toBe(allowed);
    expect(robots.isAllowed(`https://x.zaviagent.com${path}`, "Googlebot")).toBe(allowed);
  });

  it("raises no AI-crawler finding: only private pages are closed", () => {
    const geo = analyzeGeo({ pages: [], robotsBody: body, robotsFetched: true, llmsTxt: null });
    expect(geo.findings.filter((f) => f.code.startsWith("ai_crawler"))).toEqual([]);
  });
});

describe("the plugin at build", () => {
  it.each([
    ["a restaurant", "Golden Fork", "golden-fork-1a2b3c4d.zaviagent.com", ["menu", "reservations"]],
    ["a law practice", "Hale & Ortiz", "hale-ortiz-9f8e7d6c.zaviagent.com", ["practice-areas", "contact"]],
    ["a software product", "Shipfast", "shipfast-0a1b2c3d.zaviagent.com", ["pricing", "docs/getting-started"]],
  ])("writes robots, a sitemap of every page and fixed canonicals for %s", async (_shape, name, hostname, pages) => {
    const files = personalizeSiteStarter(POOLED, { label: hostname.split(".")[0], name, hostname, webBase: "https://www.zaviagent.com" });
    const decl = /const ZAVI_HEAD = (\{[^}\n]*\});/.exec(files["vite.config.ts"])?.[1];
    const head = JSON.parse(decl!) as { url: string };
    expect(head.url).toBe(`https://${hostname}/`);

    const plugin = zaviSeo(head);
    const bundle: Record<string, { type: string; source?: unknown }> = {
      "index.html": { type: "asset", source: HOME },
      "assets/index.js": { type: "chunk" },
      "404.html": { type: "asset", source: HOME },
    };
    for (const p of pages) bundle[`${p}/index.html`] = { type: "asset", source: HOME };
    const out = await build(plugin, bundle);

    expect(out["robots.txt"]).toContain(`Sitemap: https://${hostname}/sitemap.xml`);
    const locs = [...out["sitemap.xml"].matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual([`https://${hostname}/`, ...pages.map((p) => `https://${hostname}/${p}`).sort()]);
    for (const p of pages) {
      expect(String(bundle[`${p}/index.html`].source)).toContain(`<link rel="canonical" href="https://${hostname}/${p}" />`);
    }
    expect(String(bundle["index.html"].source)).toBe(HOME);
    expect(String(bundle["404.html"].source)).not.toContain('rel="canonical" href');
  });

  it("keeps a robots.txt or sitemap the build already has, and writes no sitemap without an address", async () => {
    const own = await build(zaviSeo({ url: "https://x.zaviagent.com/" }), {
      "robots.txt": { type: "asset", source: "User-agent: *\nDisallow: /\n" },
      "sitemap.xml": { type: "asset", source: "<urlset/>" },
    });
    expect(own).toEqual({});
    const none = await build(zaviSeo({ url: "" }), { "index.html": { type: "asset", source: HOME } });
    expect(Object.keys(none)).toEqual(["robots.txt"]);
    expect(none["robots.txt"]).not.toContain("Sitemap");
  });
});
