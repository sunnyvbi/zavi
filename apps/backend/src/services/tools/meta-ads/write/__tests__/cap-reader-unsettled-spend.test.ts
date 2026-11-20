
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = { status: string; body: Record<string, number> };

const state = {
  rows: [] as Row[],
  capRow: null as unknown,
};

function builder(table: string) {
  let statuses: string[] | null = null;
  const self = {
    select: () => self,
    eq: (col: string, val: string) => {
      if (col === "status") statuses = [val];
      return self;
    },
    in: (col: string, vals: string[]) => {
      if (col === "status") statuses = vals;
      return self;
    },
    gte: () => self,
    or: () => self,
    neq: () => self,
    maybeSingle: async () => ({ data: state.capRow, error: null }),
    then: undefined as unknown,
  };
  (self as unknown as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
    if (table !== "decisions") return resolve({ data: null, error: null });
    const rows = statuses === null ? state.rows : state.rows.filter((r) => statuses!.includes(r.status));
    return resolve({ data: rows, error: null });
  };
  return self;
}

vi.mock("../../_client", () => ({ getAdAccountCurrency: async () => "USD" }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: (table: string) => builder(table) }),
}));

import { readTenantCapAndToday } from "../cap-reader";
import { evaluateBudgetCap } from "../_cap-evaluator";

const TENANT = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  state.rows = [];
  state.capRow = {
    enabled: true,
    max_daily_budget_usd: 1000,
    max_pct_change_per_run: null,
    max_daily_total_change_usd: 100,
  };
});

describe("the Meta daily total counts spend whose settlement never landed", () => {
  it("a 'dispatching' budget change counts toward today's total", async () => {
    state.rows = [
      { status: "dispatching", body: { daily_budget_usd: 190, expected_current_daily_budget_usd: 100 } },
    ];
    const out = await readTenantCapAndToday(TENANT);
    expect(out.today_total_change_usd).toBe(90);
  });

  it("the $90-stuck-then-$20 case refuses instead of taking the day to $110", async () => {
    state.rows = [
      { status: "dispatching", body: { daily_budget_usd: 190, expected_current_daily_budget_usd: 100 } },
    ];
    const { cap, today_total_change_usd } = await readTenantCapAndToday(TENANT);
    expect(
      evaluateBudgetCap({
        proposed_daily_budget_usd: 210,
        current_daily_budget_usd: 190,
        today_total_change_usd,
        cap,
      }),
    ).toEqual({ within: false, reason: "over_daily_aggregate" });
  });

  it("a row released back to 'proposed' is NOT counted — it never reached the account", async () => {
    state.rows = [
      { status: "proposed", body: { daily_budget_usd: 190, expected_current_daily_budget_usd: 100 } },
    ];
    const out = await readTenantCapAndToday(TENANT);
    expect(out.today_total_change_usd).toBe(0);
  });

  it("settled 'acted' rows still count, unchanged", async () => {
    state.rows = [
      { status: "acted", body: { daily_budget_usd: 150, expected_current_daily_budget_usd: 100 } },
    ];
    const out = await readTenantCapAndToday(TENANT);
    expect(out.today_total_change_usd).toBe(50);
  });
});
