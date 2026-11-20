
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = {
  rows: [] as Array<Record<string, unknown>>,
  error: null as null | { message: string },
  capRow: null as unknown,
};

function builder(table: string) {
  const self = {
    select: () => self,
    eq: () => self,
    in: () => self,
    gte: () => self,
    or: () => self,
    neq: () => self,
    maybeSingle: async () => ({ data: state.capRow, error: null }),
    then: undefined as unknown,
  };
  (self as unknown as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    resolve(table === "decisions" ? { data: state.rows, error: state.error } : { data: null, error: null });
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
  state.error = null;
  state.capRow = {
    enabled: true,
    max_daily_budget_usd: 1000,
    max_pct_change_per_run: null,
    max_daily_total_change_usd: 100,
  };
});

describe("the Meta daily cap fails CLOSED on an unreadable day", () => {
  it("a clean read still returns the real total", async () => {
    state.rows = [{ body: { daily_budget_usd: 150, expected_current_daily_budget_usd: 100 } }];
    const out = await readTenantCapAndToday(TENANT);
    expect(out.today_total_change_usd).toBe(50);
    expect(out.cap).not.toBeNull();
  });

  it("a FAILED read poisons the daily-total axis instead of reporting zero", async () => {
    state.error = { message: "decisions unavailable" };
    const out = await readTenantCapAndToday(TENANT);
    expect(out.today_total_change_usd).toBe(Number.MAX_SAFE_INTEGER);
    expect(out.cap).not.toBeNull();
  });

  it("the $90-of-$100 case now refuses instead of approving", async () => {
    state.error = { message: "decisions unavailable" };
    const { cap, today_total_change_usd } = await readTenantCapAndToday(TENANT);
    expect(
      evaluateBudgetCap({
        proposed_daily_budget_usd: 120,
        current_daily_budget_usd: 100,
        today_total_change_usd,
        cap,
      }),
    ).toEqual({ within: false, reason: "over_daily_aggregate" });
  });

  it("the ABSOLUTE ceiling still bites on an unreadable day", async () => {
    state.error = { message: "decisions unavailable" };
    const { cap, today_total_change_usd } = await readTenantCapAndToday(TENANT);
    expect(
      evaluateBudgetCap({
        proposed_daily_budget_usd: 5000,
        current_daily_budget_usd: 100,
        today_total_change_usd,
        cap,
      }),
    ).toEqual({ within: false, reason: "over_absolute_ceiling" });
  });

  it("an axis the operator never configured is NOT invented", async () => {
    state.capRow = {
      enabled: true,
      max_daily_budget_usd: 1000,
      max_pct_change_per_run: null,
      max_daily_total_change_usd: null,
    };
    state.error = { message: "decisions unavailable" };
    const { cap, today_total_change_usd } = await readTenantCapAndToday(TENANT);
    expect(
      evaluateBudgetCap({
        proposed_daily_budget_usd: 110,
        current_daily_budget_usd: 100,
        today_total_change_usd,
        cap,
      }),
    ).toEqual({ within: true });
  });
});
