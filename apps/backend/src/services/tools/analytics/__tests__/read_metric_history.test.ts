
import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/analytics/record-metric-snapshot", () => ({
  readMetricHistory: async () => [],
  recordMetricSnapshot: async () => ({ ok: true }),
}));

import { readMetricHistoryTool } from "../read_metric_history";

const parse = (input: unknown) => readMetricHistoryTool.input_schema.safeParse(input);

describe("read_metric_history — input validation", () => {
  it("accepts a minimal valid input (defaults applied)", () => {
    const r = parse({ metric_key: "weekly_signups" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as { limit: number }).limit).toBe(30);
    }
  });

  it("rejects an unknown metric_key (hard enum over METRIC_REGISTRY)", () => {
    expect(parse({ metric_key: "revenue_total" }).success).toBe(false);
    expect(parse({}).success).toBe(false);
  });

  it("caps limit at 90 and floors at 1", () => {
    expect(parse({ metric_key: "stripe_mrr", limit: 90 }).success).toBe(true);
    expect(parse({ metric_key: "stripe_mrr", limit: 91 }).success).toBe(false);
    expect(parse({ metric_key: "stripe_mrr", limit: 0 }).success).toBe(false);
    expect(parse({ metric_key: "stripe_mrr", limit: 2.5 }).success).toBe(false);
  });

  it("registers with an Anthropic-safe growth-prefixed name (facade strips it)", () => {
    expect(readMetricHistoryTool.name).toBe("growth_read_metric_history");
    expect(/^[a-zA-Z0-9_-]+$/.test(readMetricHistoryTool.name)).toBe(true);
  });

  it("description warns the data is observational, not causal", () => {
    expect(readMetricHistoryTool.description.toLowerCase()).toContain("not causal");
  });
});

describe("read_metric_history — execute (reader mocked to empty)", () => {
  const ctx = { tenant_id: "tenant-1", log: () => undefined };

  it("returns has_data:false + a never-fabricate note when no snapshots exist", async () => {
    const out = (await readMetricHistoryTool.execute(ctx, {
      metric_key: "weekly_signups",
      limit: 5,
    })) as { has_data: boolean; rows: unknown[]; metric: { key: string }; note: string };
    expect(out.has_data).toBe(false);
    expect(out.rows).toEqual([]);
    expect(out.metric.key).toBe("weekly_signups");
    expect(out.note).toContain("never fabricate");
  });

  it("echoes the registry definition so the agent knows direction/unit/window", async () => {
    const out = (await readMetricHistoryTool.execute(ctx, {
      metric_key: "ads_cpa_7d",
    })) as { metric: { key: string; direction: string; unit: string; window_kind: string } };
    expect(out.metric.direction).toBe("down");
    expect(out.metric.unit).toBe("usd");
    expect(out.metric.window_kind).toBe("rolling_7d");
  });
});
