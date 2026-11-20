
import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
vi.mock("../_client", () => ({ searchAnalyticsQuery: (...a: unknown[]) => queryMock(...a) }));

import { gscOpportunitiesTool } from "../opportunities";

const ctx = { tenant_id: "t-1" } as any;
const row = (key: string, clicks: number, impressions: number, position: number) => ({
  keys: [key],
  clicks,
  impressions,
  ctr: impressions > 0 ? clicks / impressions : 0,
  position,
});

beforeEach(() => queryMock.mockReset());

describe("gscOpportunitiesTool", () => {
  it("keeps only rows in the striking-distance band, ranked by impressions", async () => {
    queryMock.mockResolvedValue({
      rows: [
        row("won", 500, 5000, 1.4),
        row("close-big", 20, 3000, 8.1),
        row("close-small", 5, 900, 12.0),
        row("far", 1, 4000, 47.0),
      ],
    });
    const out = (await gscOpportunitiesTool.execute(ctx, {})) as any;
    expect(out.striking_distance.rows.map((r: any) => r.key)).toEqual(["close-big", "close-small"]);
  });

  it("drops rows under the impressions noise floor", async () => {
    queryMock.mockResolvedValue({ rows: [row("noise", 0, 3, 9.0), row("real", 2, 400, 9.0)] });
    const out = (await gscOpportunitiesTool.execute(ctx, { min_impressions: 50 })) as any;
    expect(out.rows_scanned).toBe(2);
    expect(out.rows_eligible).toBe(1);
    expect(out.striking_distance.rows.map((r: any) => r.key)).toEqual(["real"]);
  });

  it("benchmarks CTR against the property's OWN median in the same position bucket", async () => {
    queryMock.mockResolvedValue({
      rows: [
        row("a", 50, 1000, 5.1),
        row("b", 50, 1000, 5.2),
        row("c", 50, 1000, 4.9),
        row("d", 50, 1000, 5.0),
        row("e", 50, 1000, 5.3),
        row("underclicked", 5, 1000, 5.0),
      ],
    });
    const out = (await gscOpportunitiesTool.execute(ctx, {})) as any;
    const flagged = out.low_ctr_for_position.rows;
    expect(flagged).toHaveLength(1);
    expect(flagged[0].key).toBe("underclicked");
    expect(flagged[0].benchmark_ctr).toBeCloseTo(0.05, 5);
    expect(flagged[0].benchmark_sample_size).toBe(6);
    expect(flagged[0].ctr_vs_benchmark).toBeCloseTo(0.1, 5);
  });

  it("refuses to flag low CTR when the bucket is too thin to be a benchmark", async () => {
    queryMock.mockResolvedValue({ rows: [row("a", 50, 1000, 5.0), row("b", 1, 1000, 5.0)] });
    const out = (await gscOpportunitiesTool.execute(ctx, {})) as any;
    expect(out.low_ctr_for_position.rows).toEqual([]);
  });

  it("surfaces impressions with zero clicks separately", async () => {
    queryMock.mockResolvedValue({ rows: [row("ghost", 0, 2000, 14.0), row("fine", 10, 500, 6.0)] });
    const out = (await gscOpportunitiesTool.execute(ctx, {})) as any;
    expect(out.high_impressions_no_clicks.rows.map((r: any) => r.key)).toEqual(["ghost"]);
  });

  it("flags API truncation so the agent cannot generalise to the whole site", async () => {
    queryMock.mockResolvedValue({ rows: Array.from({ length: 1000 }, (_, i) => row(`q${i}`, 1, 100, 9)) });
    const out = (await gscOpportunitiesTool.execute(ctx, {})) as any;
    expect(out.truncated_at_api_limit).toBe(true);
    expect(queryMock.mock.calls[0][1].rowLimit).toBe(1000);
  });

  it("does not truncate-flag a site that fits under the cap", async () => {
    queryMock.mockResolvedValue({ rows: [row("a", 1, 100, 9)] });
    const out = (await gscOpportunitiesTool.execute(ctx, {})) as any;
    expect(out.truncated_at_api_limit).toBe(false);
  });

  it("respects the limit on every list", async () => {
    queryMock.mockResolvedValue({ rows: Array.from({ length: 40 }, (_, i) => row(`q${i}`, 0, 500 + i, 9)) });
    const out = (await gscOpportunitiesTool.execute(ctx, { limit: 5 })) as any;
    expect(out.striking_distance.rows).toHaveLength(5);
    expect(out.high_impressions_no_clicks.rows).toHaveLength(5);
  });
});
