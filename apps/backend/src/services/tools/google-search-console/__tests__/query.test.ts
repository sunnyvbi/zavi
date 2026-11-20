import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
vi.mock("../_client", () => ({
  searchAnalyticsQuery: (...args: unknown[]) => queryMock(...args),
}));

import { gscQueryTool } from "../query";

const ctx = { tenant_id: "t-1" } as any;

beforeEach(() => {
  queryMock.mockReset();
});

describe("gscQueryTool", () => {
  it("maps GSC rows → typed rows and passes the requested dimensions", async () => {
    queryMock.mockResolvedValue({
      rows: [
        { keys: ["best widgets"], clicks: 120, impressions: 4000, ctr: 0.03, position: 4.2 },
        { keys: ["cheap widgets"], clicks: 30, impressions: 900, ctr: 0.033, position: 8.7 },
      ],
    });

    const out = (await gscQueryTool.execute(ctx, { dimensions: ["query"], row_limit: 50 })) as {
      row_count: number;
      dimensions: string[];
      rows: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }>;
    };

    expect(queryMock).toHaveBeenCalledWith(
      "t-1",
      expect.objectContaining({ dimensions: ["query"], rowLimit: 50 }),
    );
    expect(out.row_count).toBe(2);
    expect(out.rows[0]).toEqual({ keys: ["best widgets"], clicks: 120, impressions: 4000, ctr: 0.03, position: 4.2 });
  });

  it("uses a custom range verbatim when provided", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const out = (await gscQueryTool.execute(ctx, {
      custom_range: { since: "2026-08-01", until: "2026-08-28" },
    })) as { date_range: string };
    expect(queryMock).toHaveBeenCalledWith(
      "t-1",
      expect.objectContaining({ startDate: "2026-08-01", endDate: "2026-08-28" }),
    );
    expect(out.date_range).toBe("2026-08-01..2026-08-28");
  });

  it("defaults missing metric fields to 0", async () => {
    queryMock.mockResolvedValue({ rows: [{ keys: ["/pricing"] }] });
    const out = (await gscQueryTool.execute(ctx, { dimensions: ["page"] })) as {
      rows: Array<{ clicks: number; impressions: number; ctr: number; position: number }>;
    };
    expect(out.rows[0]).toEqual({ keys: ["/pricing"], clicks: 0, impressions: 0, ctr: 0, position: 0 });
  });

  it("rejects an invalid dimension", async () => {
    await expect(gscQueryTool.execute(ctx, { dimensions: ["drop table"] })).rejects.toThrow();
    expect(queryMock).not.toHaveBeenCalled();
  });
});
