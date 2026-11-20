import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const runReportMock = vi.fn();
vi.mock("../_client", () => ({
  runReport: (...args: unknown[]) => runReportMock(...args),
}));

import { gaRunReportTool } from "../run_report";

const ctx = { tenant_id: "t-1" } as any;

beforeEach(() => {
  runReportMock.mockReset();
});

describe("gaRunReportTool", () => {
  it("maps GA4 dimension/metric values → typed attribution rows", async () => {
    runReportMock.mockResolvedValue({
      rowCount: 2,
      rows: [
        {
          dimensionValues: [{ value: "google" }, { value: "cpc" }, { value: "brand" }],
          metricValues: [{ value: "1200" }, { value: "900" }, { value: "42" }, { value: "3150.5" }],
        },
        {
          dimensionValues: [{ value: "(direct)" }, { value: "(none)" }, { value: "(not set)" }],
          metricValues: [{ value: "800" }, { value: "700" }, { value: "20" }, { value: "0" }],
        },
      ],
    });

    const out = (await gaRunReportTool.execute(ctx, { date_range: "LAST_28_DAYS" })) as {
      row_count: number;
      rows: Array<{ source: string; medium: string; campaign: string; sessions: number; conversions: number; revenue: number }>;
    };

    expect(out.row_count).toBe(2);
    expect(out.rows[0]).toEqual({
      source: "google",
      medium: "cpc",
      campaign: "brand",
      sessions: 1200,
      users: 900,
      conversions: 42,
      revenue: 3150.5,
    });
    expect(out.rows[1].revenue).toBe(0);
  });

  it("returns an empty row set (not a crash) when GA4 has no rows", async () => {
    runReportMock.mockResolvedValue({ rowCount: 0 });
    const out = (await gaRunReportTool.execute(ctx, {})) as { row_count: number; rows: unknown[] };
    expect(out.row_count).toBe(0);
    expect(out.rows).toEqual([]);
  });

  it("propagates google_analytics_not_connected from the client (no fabricated data)", async () => {
    runReportMock.mockRejectedValue(
      new ExpectedToolError("google_analytics_not_connected", "not connected"),
    );
    await expect(gaRunReportTool.execute(ctx, {})).rejects.toMatchObject({
      code: "google_analytics_not_connected",
    });
  });

  it("asks GA4 for a large page, the TOTAL row and key events (B6)", async () => {
    runReportMock.mockResolvedValue({ rowCount: 0 });
    await gaRunReportTool.execute(ctx, {});
    const body = runReportMock.mock.calls[0][1];
    expect(Number(body.limit)).toBeGreaterThanOrEqual(10000);
    expect(body.metricAggregations).toEqual(["TOTAL"]);
    expect(body.metrics.map((m: { name: string }) => m.name)).toContain("keyEvents");
    expect(body.metrics.map((m: { name: string }) => m.name)).not.toContain("conversions");
  });

  it("returns GA4's totals and flags truncation when rowCount exceeds the rows returned (B6)", async () => {
    runReportMock.mockResolvedValue({
      rowCount: 12000,
      rows: [
        {
          dimensionValues: [{ value: "google" }, { value: "cpc" }, { value: "brand" }],
          metricValues: [{ value: "10" }, { value: "9" }, { value: "1" }, { value: "5" }],
        },
      ],
      totals: [{ metricValues: [{ value: "50000" }, { value: "31000" }, { value: "900" }, { value: "12345.5" }] }],
    });
    const out = (await gaRunReportTool.execute(ctx, {})) as {
      truncated: boolean;
      rows_returned: number;
      totals: Record<string, number> | null;
    };
    expect(out.truncated).toBe(true);
    expect(out.rows_returned).toBe(1);
    expect(out.totals).toEqual({ sessions: 50000, users: 31000, conversions: 900, revenue: 12345.5 });
  });

  it("is not truncated when every row came back", async () => {
    runReportMock.mockResolvedValue({ rowCount: 0 });
    const out = (await gaRunReportTool.execute(ctx, {})) as { truncated: boolean; totals: unknown };
    expect(out.truncated).toBe(false);
    expect(out.totals).toBeNull();
  });

  it("passes a custom_range through as explicit start/end dates", async () => {
    runReportMock.mockResolvedValue({ rowCount: 0 });
    await gaRunReportTool.execute(ctx, { custom_range: { since: "2026-06-01", until: "2026-06-30" } });
    const body = runReportMock.mock.calls[0][1];
    expect(body.dateRanges[0]).toEqual({ startDate: "2026-06-01", endDate: "2026-06-30" });
  });
});
