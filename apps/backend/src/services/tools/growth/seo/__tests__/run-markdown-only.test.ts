
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (x: string) => x, tenantClient: () => ({}) }));
vi.mock("@/services/brand/resolve-brand-kit", () => ({ marketingUrlOf: () => null }));

const fetched = vi.hoisted(() => ({ pages: [] as unknown[] }));
vi.mock("../fetch", () => ({
  DEFAULT_PATHS: ["/"],
  fetchForSeoAudit: async () => ({
    pages: fetched.pages,
    robots: { fetched: true, disallowsAll: false, sitemaps: [] },
    robotsBody: "User-agent: *\nAllow: /\n",
    sitemapReachable: false,
    llmsTxt: true,
    ssrf_blocked: 0,
    truncated: false,
    pages_planned: fetched.pages.length,
    graph: {
      sitemap_paths: [],
      sitemap_query_only_paths: [],
      sitemap_as_written: [],
      sitemap_complete: true,
      llms_txt_paths: ["/docs.md"],
      linked_paths: [],
    },
  }),
}));

import { runAuditForUrl } from "../run";

const md = (url: string) => ({
  url,
  status: 200,
  headers: { "content-type": "text/markdown" },
  html: "# Docs\n\nHow to use it.\n",
});

describe("runAuditForUrl on a crawl that reached only Markdown", () => {
  it("returns the report instead of calling the site unreachable", async () => {
    fetched.pages = [md("https://example.com/llms.txt"), md("https://example.com/docs.md")];
    const r = await runAuditForUrl("https://example.com");
    expect(r.seo.pages_analyzed).toBe(2);
    expect(r.seo.pages).toEqual([]);
    expect(r.seo.non_html_urls).toEqual(["https://example.com/llms.txt", "https://example.com/docs.md"]);
  });

  it("still calls it unreachable when nothing answered", async () => {
    fetched.pages = [{ url: "https://example.com/", status: 0, headers: {}, html: "" }];
    await expect(runAuditForUrl("https://example.com")).rejects.toMatchObject({ code: "seo_site_unreachable" });
  });
});
