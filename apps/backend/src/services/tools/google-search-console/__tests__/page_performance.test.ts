import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
const credsMock = vi.fn();
vi.mock("../_client", () => ({
  searchAnalyticsQuery: (...a: unknown[]) => queryMock(...a),
  googleSearchConsoleCreds: (...a: unknown[]) => credsMock(...a),
}));

import { gscPagePerformanceTool } from "../page_performance";

const ctx = { tenant_id: "t-1" } as any;
const rows = (r: unknown[]) => ({ rows: r });

beforeEach(() => {
  queryMock.mockReset();
  credsMock.mockReset().mockResolvedValue({ site_url: "sc-domain:example.com", access_token: "tok" });
});

describe("gscPagePerformanceTool", () => {
  it("filters server-side on the page dimension so deep pages are reachable", async () => {
    queryMock.mockResolvedValue(rows([]));
    await gscPagePerformanceTool.execute(ctx, { page_url: "https://example.com/pricing" });

    for (const call of queryMock.mock.calls) {
      expect(call[1].dimensionFilterGroups).toEqual([
        {
          groupType: "and",
          filters: [{ dimension: "page", operator: "equals", expression: "https://example.com/pricing" }],
        },
      ]);
    }
  });

  it("switches to `contains` for a section roll-up", async () => {
    queryMock.mockResolvedValue(rows([]));
    await gscPagePerformanceTool.execute(ctx, { page_url: "https://example.com/blog", match: "contains" });
    expect(queryMock.mock.calls[0][1].dimensionFilterGroups[0].filters[0].operator).toBe("contains");
  });

  it("resolves credentials ONCE across the parallel queries", async () => {
    queryMock.mockResolvedValue(rows([]));
    await gscPagePerformanceTool.execute(ctx, { page_url: "https://example.com/x" });
    expect(credsMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it("reports has_data:false rather than fabricating zeroes as a measurement", async () => {
    queryMock.mockResolvedValue(rows([]));
    const out = (await gscPagePerformanceTool.execute(ctx, { page_url: "https://example.com/ghost" })) as any;
    expect(out.has_data).toBe(false);
    expect(out.totals).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: 0 });
  });

  it("returns totals, top queries and the device split", async () => {
    queryMock
      .mockResolvedValueOnce(rows([{ clicks: 300, impressions: 9000, ctr: 0.033, position: 6.1 }]))
      .mockResolvedValueOnce(rows([{ keys: ["pricing"], clicks: 200, impressions: 5000, ctr: 0.04, position: 5.2 }]))
      .mockResolvedValueOnce(rows([{ keys: ["MOBILE"], clicks: 100, impressions: 4000, ctr: 0.025, position: 7.4 }]));

    const out = (await gscPagePerformanceTool.execute(ctx, { page_url: "https://example.com/pricing" })) as any;
    expect(out.has_data).toBe(true);
    expect(out.totals.clicks).toBe(300);
    expect(out.top_queries[0]).toMatchObject({ key: "pricing", clicks: 200 });
    expect(out.by_device[0]).toMatchObject({ key: "MOBILE", clicks: 100 });
    expect(out.site_url).toBe("sc-domain:example.com");
  });

  it("flags truncation when the query list fills the requested limit", async () => {
    const many = Array.from({ length: 2 }, (_, i) => ({ keys: [`q${i}`], clicks: 1, impressions: 10 }));
    queryMock
      .mockResolvedValueOnce(rows([{ clicks: 2, impressions: 20 }]))
      .mockResolvedValueOnce(rows(many))
      .mockResolvedValueOnce(rows([]));
    const out = (await gscPagePerformanceTool.execute(ctx, {
      page_url: "https://example.com/p",
      query_limit: 2,
    })) as any;
    expect(out.queries_truncated).toBe(true);
  });

  it("rejects a non-URL page_url", async () => {
    await expect(gscPagePerformanceTool.execute(ctx, { page_url: "/pricing" })).rejects.toThrow();
    expect(queryMock).not.toHaveBeenCalled();
  });
});
