import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
const credsMock = vi.fn();
vi.mock("../_client", () => ({
  searchAnalyticsQuery: (...a: unknown[]) => queryMock(...a),
  googleSearchConsoleCreds: (...a: unknown[]) => credsMock(...a),
}));

import { gscComparePeriodsTool } from "../compare_periods";

const ctx = { tenant_id: "t-1" } as any;
const row = (key: string, clicks: number, impressions: number, position: number) => ({
  keys: [key],
  clicks,
  impressions,
  ctr: impressions > 0 ? clicks / impressions : 0,
  position,
});

beforeEach(() => {
  queryMock.mockReset();
  credsMock.mockReset().mockResolvedValue({ site_url: "https://example.com/", access_token: "tok" });
});

describe("gscComparePeriodsTool", () => {
  it("compares against the adjacent equal-length window, not an arbitrary one", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const out = (await gscComparePeriodsTool.execute(ctx, {
      custom_range: { since: "2026-08-05", until: "2026-09-01" },
    })) as any;
    expect(out.current_range).toBe("2026-08-05..2026-09-01");
    expect(out.previous_range).toBe("2026-07-08..2026-08-04");
    expect(out.window_days).toBe(28);
    expect(queryMock.mock.calls[1][1]).toMatchObject({ startDate: "2026-07-08", endDate: "2026-08-04" });
  });

  it("classifies declined / improved / lost / gained", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [row("/a", 50, 1000, 6), row("/b", 100, 900, 3), row("/new", 10, 200, 12)] })
      .mockResolvedValueOnce({ rows: [row("/a", 200, 1500, 4), row("/b", 60, 800, 5), row("/gone", 80, 700, 6)] });

    const out = (await gscComparePeriodsTool.execute(ctx, {})) as any;
    expect(out.declined.map((r: any) => r.key)).toEqual(["/a"]);
    expect(out.improved.map((r: any) => r.key)).toEqual(["/b"]);
    expect(out.lost.map((r: any) => r.key)).toEqual(["/gone"]);
    expect(out.gained.map((r: any) => r.key)).toEqual(["/new"]);
    expect(out.declined[0].clicks_delta).toBe(-150);
  });

  it("signs position_delta so NEGATIVE means the rank improved", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [row("/a", 10, 100, 3)] })
      .mockResolvedValueOnce({ rows: [row("/a", 10, 100, 9)] });
    const out = (await gscComparePeriodsTool.execute(ctx, {})) as any;
    expect(out.improved[0].position_delta).toBe(-6);
  });

  it("weights total position by impressions, as Search Console does", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [row("/a", 0, 900, 10), row("/b", 0, 100, 20)] })
      .mockResolvedValueOnce({ rows: [] });
    const out = (await gscComparePeriodsTool.execute(ctx, {})) as any;
    expect(out.totals.current.position).toBeCloseTo(11, 5);
  });

  it("returns a null pct delta instead of dividing by a zero baseline", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row("/a", 10, 100, 5)] }).mockResolvedValueOnce({ rows: [] });
    const out = (await gscComparePeriodsTool.execute(ctx, {})) as any;
    expect(out.totals.clicks_delta_pct).toBeNull();
    expect(out.totals.clicks_delta).toBe(10);
  });

  it("resolves credentials once for both window queries", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await gscComparePeriodsTool.execute(ctx, {});
    expect(credsMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a collapsed row: the noise floor sums BOTH windows", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row("/collapsed", 90, 900, 4)] });
    const out = (await gscComparePeriodsTool.execute(ctx, { min_impressions: 100 })) as any;
    expect(out.lost.map((r: any) => r.key)).toEqual(["/collapsed"]);
  });

  it("flags truncation when either window hits the API row cap", async () => {
    queryMock
      .mockResolvedValueOnce({ rows: Array.from({ length: 1000 }, (_, i) => row(`/p${i}`, 1, 50, 9)) })
      .mockResolvedValueOnce({ rows: [] });
    const out = (await gscComparePeriodsTool.execute(ctx, { min_impressions: 0 })) as any;
    expect(out.truncated_at_api_limit).toBe(true);
  });
});
