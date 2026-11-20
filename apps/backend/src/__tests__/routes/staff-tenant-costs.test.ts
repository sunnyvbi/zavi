
import { describe, it, expect } from "vitest";
import {
  aggregateTenantCosts,
  estimateInfraMonthly,
  prorateToWindow,
  RENDER_STARTER_USD_MO,
  NEON_USD_MO,
  type TenantCostRunInput,
  type InfraCounts,
} from "@/routes/admin/tenant-costs";

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const labels = new Map([
  [A, { slug: "alpha", display_name: "Alpha Co" }],
  [B, { slug: "beta", display_name: "Beta Co" }],
]);

describe("estimateInfraMonthly", () => {
  it("prices render starters + neon dbs", () => {
    expect(estimateInfraMonthly({ render: 2, neon: 3 })).toBe(
      2 * RENDER_STARTER_USD_MO + 3 * NEON_USD_MO,
    );
  });
  it("is zero with no infra", () => {
    expect(estimateInfraMonthly({ render: 0, neon: 0 })).toBe(0);
  });
});

describe("prorateToWindow", () => {
  it("30d window ≈ one month", () => {
    expect(prorateToWindow(30, 30)).toBe(30);
  });
  it("7d window is ~quarter-ish of monthly", () => {
    expect(prorateToWindow(30, 7)).toBeCloseTo(7, 5);
  });
});

describe("aggregateTenantCosts", () => {
  const runs: TenantCostRunInput[] = [
    { tenant_id: A, agent_slug: "engineer", cost_tokens: 100, cost_usd: 1.0 },
    { tenant_id: A, agent_slug: "engineer", cost_tokens: 50, cost_usd: 0.5 },
    { tenant_id: A, agent_slug: "operator", cost_tokens: 200, cost_usd: 2.0 },
    { tenant_id: B, agent_slug: "pm", cost_tokens: 10, cost_usd: 0.1 },
  ];
  const infra = new Map<string, InfraCounts>([
    [A, { render: 1, neon: 1 }],
  ]);

  it("groups runs per tenant, nests per agent, sorts agents by usd desc", () => {
    const { rows } = aggregateTenantCosts(runs, infra, labels, 30);
    const a = rows.find((r) => r.tenant_id === A)!;
    expect(a.runs).toBe(3);
    expect(a.tokens).toBe(350);
    expect(a.llm_usd).toBeCloseTo(3.5, 6);
    expect(a.byAgent.map((x) => x.agent_slug)).toEqual(["operator", "engineer"]);
    expect(a.byAgent[0].usd).toBeCloseTo(2.0, 6);
    expect(a.byAgent[1].runs).toBe(2);
  });

  it("folds infra into total (window=30d ⇒ full monthly)", () => {
    const { rows } = aggregateTenantCosts(runs, infra, labels, 30);
    const a = rows.find((r) => r.tenant_id === A)!;
    expect(a.infra_monthly_usd).toBe(RENDER_STARTER_USD_MO);
    expect(a.infra_window_usd).toBeCloseTo(RENDER_STARTER_USD_MO, 6);
    expect(a.total_window_usd).toBeCloseTo(3.5 + RENDER_STARTER_USD_MO, 6);
  });

  it("prorates infra to a 7d window", () => {
    const { rows } = aggregateTenantCosts(runs, infra, labels, 7);
    const a = rows.find((r) => r.tenant_id === A)!;
    expect(a.infra_window_usd).toBeCloseTo(RENDER_STARTER_USD_MO * (7 / 30), 6);
  });

  it("ranks tenants by total_window_usd desc", () => {
    const { rows } = aggregateTenantCosts(runs, infra, labels, 30);
    expect(rows[0].tenant_id).toBe(A);
    expect(rows[1].tenant_id).toBe(B);
  });

  it("includes a tenant with infra but zero in-window runs", () => {
    const infraOnly = new Map<string, InfraCounts>([
      [B, { render: 2, neon: 0 }],
    ]);
    const { rows } = aggregateTenantCosts([], infraOnly, labels, 30);
    const b = rows.find((r) => r.tenant_id === B)!;
    expect(b.runs).toBe(0);
    expect(b.byAgent).toEqual([]);
    expect(b.total_window_usd).toBeCloseTo(2 * RENDER_STARTER_USD_MO, 6);
  });

  it("coerces null cost columns to 0 and labels fall back to id slice", () => {
    const nullRuns: TenantCostRunInput[] = [
      { tenant_id: A, agent_slug: "x", cost_tokens: null, cost_usd: null },
    ];
    const { rows, totals } = aggregateTenantCosts(nullRuns, new Map(), new Map(), 30);
    expect(rows[0].llm_usd).toBe(0);
    expect(rows[0].tokens).toBe(0);
    expect(rows[0].display_name).toBe(A.slice(0, 8));
    expect(totals.tenants).toBe(1);
  });

  it("grand totals sum across tenants", () => {
    const { totals } = aggregateTenantCosts(runs, infra, labels, 30);
    expect(totals.tenants).toBe(2);
    expect(totals.runs).toBe(4);
    expect(totals.llm_usd).toBeCloseTo(3.6, 6);
    expect(totals.total_window_usd).toBeCloseTo(3.6 + RENDER_STARTER_USD_MO, 6);
  });
});
