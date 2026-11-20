import { describe, it, expect, vi, beforeEach } from "vitest";

const listMock = vi.fn();
vi.mock("../_client", () => ({ listSitemaps: (...a: unknown[]) => listMock(...a) }));

import { gscListSitemapsTool } from "../list_sitemaps";

const ctx = { tenant_id: "t-1" } as any;

beforeEach(() => listMock.mockReset());

describe("gscListSitemapsTool", () => {
  it("coerces Google's int64-as-string counters to numbers", async () => {
    listMock.mockResolvedValue({
      site_url: "https://example.com/",
      sitemaps: [
        {
          path: "https://example.com/sitemap.xml",
          errors: "3",
          warnings: "12",
          contents: [{ type: "web", submitted: "480" }],
        },
      ],
    });
    const out = (await gscListSitemapsTool.execute(ctx, {})) as any;
    expect(out.sitemaps[0].errors).toBe(3);
    expect(out.sitemaps[0].warnings).toBe(12);
    expect(out.sitemaps[0].contents[0].submitted).toBe(480);
    expect(out.total_errors).toBe(3);
    expect(out.total_warnings).toBe(12);
  });

  it("DROPS the deprecated indexed count — it always returns 0 and would read as a real finding", async () => {
    listMock.mockResolvedValue({
      site_url: "https://example.com/",
      sitemaps: [{ path: "/s.xml", contents: [{ type: "web", submitted: "500", indexed: "0" }] }],
    });
    const out = (await gscListSitemapsTool.execute(ctx, {})) as any;
    expect(out.sitemaps[0].contents[0]).toEqual({ type: "web", submitted: 500 });
    expect(JSON.stringify(out)).not.toContain("indexed");
  });

  it("treats no sitemaps as a finding, not an error", async () => {
    listMock.mockResolvedValue({ site_url: "https://example.com/", sitemaps: [] });
    const out = (await gscListSitemapsTool.execute(ctx, {})) as any;
    expect(out.none_submitted).toBe(true);
    expect(out.sitemap_count).toBe(0);
  });

  it("keeps a submitted-but-never-downloaded sitemap visible as null", async () => {
    listMock.mockResolvedValue({
      site_url: "https://example.com/",
      sitemaps: [{ path: "/s.xml", lastSubmitted: "2026-01-02T00:00:00Z", isPending: true }],
    });
    const out = (await gscListSitemapsTool.execute(ctx, {})) as any;
    expect(out.sitemaps[0]).toMatchObject({ last_downloaded: null, is_pending: true, errors: 0 });
    expect(out.none_submitted).toBe(false);
  });
});
