
import { describe, it, expect } from "vitest";
import {
  aggregateCosts,
  classifyCapStatus,
  type CostRunInput,
} from "../costs";

describe("aggregateCosts", () => {
  it("empty input → empty rollup, zero totals", () => {
    expect(aggregateCosts([])).toEqual({
      rollup: [],
      totals: { runs: 0, tokens: 0, usd: 0 },
    });
  });

  it("groups by (tenant, agent) and sums runs/tokens/usd", () => {
    const rows: CostRunInput[] = [
      { tenant_id: "t1", agent_slug: "cto", cost_tokens: 100, cost_usd: 0.5, status: "success" },
      { tenant_id: "t1", agent_slug: "cto", cost_tokens: 200, cost_usd: 1.0, status: "failed" },
      { tenant_id: "t1", agent_slug: "ads", cost_tokens: 50, cost_usd: 0.25, status: "success" },
    ];
    const { rollup, totals } = aggregateCosts(rows);
    const cto = rollup.find((r) => r.agent_slug === "cto")!;
    const ads = rollup.find((r) => r.agent_slug === "ads")!;
    expect(cto).toEqual({ tenant_id: "t1", agent_slug: "cto", runs: 2, tokens: 300, usd: 1.5 });
    expect(ads).toEqual({ tenant_id: "t1", agent_slug: "ads", runs: 1, tokens: 50, usd: 0.25 });
    expect(totals).toEqual({ runs: 3, tokens: 350, usd: 1.75 });
  });

  it("same agent slug across different tenants are separate buckets", () => {
    const rows: CostRunInput[] = [
      { tenant_id: "t1", agent_slug: "cto", cost_tokens: 10, cost_usd: 1, status: "success" },
      { tenant_id: "t2", agent_slug: "cto", cost_tokens: 20, cost_usd: 2, status: "success" },
    ];
    const { rollup, totals } = aggregateCosts(rows);
    expect(rollup).toHaveLength(2);
    expect(totals).toEqual({ runs: 2, tokens: 30, usd: 3 });
  });

  it("rollup is sorted by usd descending", () => {
    const rows: CostRunInput[] = [
      { tenant_id: "t1", agent_slug: "cheap", cost_tokens: 1, cost_usd: 0.1, status: "success" },
      { tenant_id: "t1", agent_slug: "pricey", cost_tokens: 1, cost_usd: 5.0, status: "success" },
      { tenant_id: "t1", agent_slug: "mid", cost_tokens: 1, cost_usd: 1.0, status: "success" },
    ];
    const { rollup } = aggregateCosts(rows);
    expect(rollup.map((r) => r.agent_slug)).toEqual(["pricey", "mid", "cheap"]);
  });

  it("null cost columns coerce to 0 (still counts the run)", () => {
    const rows: CostRunInput[] = [
      { tenant_id: "t1", agent_slug: "cto", cost_tokens: null, cost_usd: null, status: "failed" },
      { tenant_id: "t1", agent_slug: "cto", cost_tokens: 100, cost_usd: 0.5, status: "success" },
    ];
    const { rollup, totals } = aggregateCosts(rows);
    expect(rollup[0]).toEqual({ tenant_id: "t1", agent_slug: "cto", runs: 2, tokens: 100, usd: 0.5 });
    expect(totals).toEqual({ runs: 2, tokens: 100, usd: 0.5 });
  });
});

describe("classifyCapStatus", () => {
  it("uncapped (cap ≤ 0) → ok, pct 0", () => {
    expect(classifyCapStatus("t1", 0, 999)).toEqual({
      tenant_id: "t1",
      daily_cap_usd: 0,
      today_usd: 999,
      pct: 0,
      flag: "ok",
    });
  });

  it("below 80% → ok", () => {
    const s = classifyCapStatus("t1", 100, 79.99);
    expect(s.flag).toBe("ok");
    expect(s.pct).toBeCloseTo(0.7999, 4);
  });

  it("exactly 80% → amber", () => {
    expect(classifyCapStatus("t1", 100, 80).flag).toBe("amber");
  });

  it("between 80% and 100% → amber", () => {
    expect(classifyCapStatus("t1", 100, 95).flag).toBe("amber");
  });

  it("exactly 100% → red", () => {
    expect(classifyCapStatus("t1", 100, 100).flag).toBe("red");
  });

  it("over 100% → red", () => {
    const s = classifyCapStatus("t1", 100, 140);
    expect(s.flag).toBe("red");
    expect(s.pct).toBeCloseTo(1.4, 4);
  });
});
