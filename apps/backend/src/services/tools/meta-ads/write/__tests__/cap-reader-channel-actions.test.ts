
import { describe, it, expect, vi, beforeEach } from "vitest";

type Filters = Array<[string, unknown, unknown?]>;
const state = {
  tables: [] as string[],
  filters: {} as Record<string, Filters>,
  actionRows: [] as Array<Record<string, unknown>>,
  decisionRows: [] as Array<Record<string, unknown>>,
  actionError: null as null | { message: string },
  decisionError: null as null | { message: string },
  capRow: null as unknown,
};

function builder(table: string) {
  const push = (k: string, v: unknown): void => {
    (state.filters[table] ??= []).push([k, v]);
  };
  const self = {
    select: () => self,
    eq: (col: string, val: unknown) => {
      push(`eq:${col}`, val);
      return self;
    },
    in: (col: string, val: unknown) => {
      push(`in:${col}`, val);
      return self;
    },
    gte: (col: string, val: unknown) => {
      push(`gte:${col}`, val);
      return self;
    },
    or: (val: unknown) => {
      push("or", val);
      return self;
    },
    neq: (col: string, val: unknown) => {
      push(`neq:${col}`, val);
      return self;
    },
    maybeSingle: async () => ({ data: state.capRow, error: null }),
    then: undefined as unknown,
  };
  (self as unknown as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
    if (table === "channel_actions") {
      return resolve({ data: state.actionRows, error: state.actionError });
    }
    if (table === "decisions") {
      return resolve({ data: state.decisionRows, error: state.decisionError });
    }
    return resolve({ data: null, error: null });
  };
  return self;
}

vi.mock("../../_client", () => ({ getAdAccountCurrency: async () => "USD" }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      state.tables.push(table);
      return builder(table);
    },
  }),
}));

import { BUDGET_DECISION_CLASSES, RESUME_CLASSES, readTenantCapAndToday } from "../cap-reader";
import { evaluateBudgetCap } from "../_cap-evaluator";

const TENANT = "22222222-2222-4222-8222-222222222222";
const CLS = "meta_ads.update_ad_set_budget";

const action = (
  run_id: string,
  from: number,
  to: number,
  ad_set_id = "1",
): Record<string, unknown> => ({
  run_id,
  exec_class: CLS,
  exec_payload: { ad_set_id, daily_budget_usd: to, expected_current_daily_budget_usd: from },
});

const decision = (
  agent_run_id: string,
  from: number,
  to: number,
  ad_set_id = "1",
): Record<string, unknown> => ({
  agent_run_id,
  decision_class: CLS,
  body: { ad_set_id, daily_budget_usd: to, expected_current_daily_budget_usd: from },
});

beforeEach(() => {
  state.tables = [];
  state.filters = {};
  state.actionRows = [];
  state.decisionRows = [];
  state.actionError = null;
  state.decisionError = null;
  state.capRow = {
    enabled: true,
    max_daily_budget_usd: 1000,
    max_pct_change_per_run: null,
    max_daily_total_change_usd: null,
  };
});

describe("today's aggregate now also comes from channel_actions", () => {
  it("two executed +$50 raises make the cap-reader return 100", async () => {
    state.actionRows = [action("run-a", 100, 150), action("run-b", 200, 250, "2")];
    const { today_total_change_usd } = await readTenantCapAndToday(TENANT);
    expect(today_total_change_usd).toBe(100);
  });

  it("a DECREASE adds nothing to today's total, on either rail (the budget brake: a cut is not a change the cap limits)", async () => {
    state.actionRows = [action("run-a", 100, 60), action("run-b", 50, 80, "2")];
    state.decisionRows = [decision("run-c", 200, 20, "3")];
    const { today_total_change_usd } = await readTenantCapAndToday(TENANT);
    expect(today_total_change_usd).toBe(30);
  });

  it("reads channel_actions, scoped to this tenant, counted classes, executed or being executed, today", async () => {
    await readTenantCapAndToday(TENANT);
    expect(state.tables).toContain("channel_actions");
    const f = Object.fromEntries(state.filters.channel_actions!.map(([k, v]) => [k, v]));
    expect(f["eq:tenant_id"]).toBe(TENANT);
    expect(f["in:exec_status"]).toEqual(["executed", "dispatching", "failed"]);
    expect(f["in:exec_class"]).toEqual([...BUDGET_DECISION_CLASSES, ...RESUME_CLASSES]);
    expect(String(f["or"])).toMatch(/^executed_at\.gte\..*T00:00:00\.000Z,exec_claimed_at\.gte\..*T00:00:00\.000Z$/);
    expect(f["in:exec_class"]).toEqual(expect.arrayContaining(["meta_ads.create_ad_set", "meta_ads.launch_campaign", "meta_ads.set_status"]));
  });

  it("a queued or failed row is NOT counted: only money that actually moved", async () => {
    state.actionRows = [];
    const { today_total_change_usd } = await readTenantCapAndToday(TENANT);
    expect(today_total_change_usd).toBe(0);
  });
});

describe("the day's total counts BOTH rails", () => {
  it("one executed channel_action of +$50 and one dispatched chat decision of +$50 make 100", async () => {
    state.actionRows = [action("run-channel", 100, 150)];
    state.decisionRows = [decision("run-chat", 300, 350, "9")];
    const { today_total_change_usd } = await readTenantCapAndToday(TENANT);
    expect(today_total_change_usd).toBe(100);
  });

  it("a change that appears in BOTH shapes is counted ONCE", async () => {
    state.actionRows = [action("run-x", 100, 150)];
    state.decisionRows = [decision("run-x", 100, 150)];
    const { today_total_change_usd } = await readTenantCapAndToday(TENANT);
    expect(today_total_change_usd).toBe(50);
  });

  it("two DIFFERENT ad sets in the same run are two changes, not a duplicate", async () => {
    state.actionRows = [action("run-x", 100, 150, "1"), action("run-x", 100, 150, "2")];
    const { today_total_change_usd } = await readTenantCapAndToday(TENANT);
    expect(today_total_change_usd).toBe(100);
  });

  it("bounds both reads with the SAME instant, so a change cannot fall between them", async () => {
    await readTenantCapAndToday(TENANT);
    const d = Object.fromEntries(state.filters.decisions!.map(([k, v]) => [k, v]));
    const a = Object.fromEntries(state.filters.channel_actions!.map(([k, v]) => [k, v]));
    expect(d["in:status"]).toEqual(["dispatching", "acted", "dispatch_failed"]);
    expect(String(a["or"])).toBe(`executed_at.gte.${d["gte:dispatched_at"]},exec_claimed_at.gte.${d["gte:dispatched_at"]}`);
  });
});

describe("an unreadable day poisons the daily-total axis and nothing else", () => {
  it("poisons it when the NEW rail fails, and keeps the cap row", async () => {
    state.actionError = { message: "channel_actions unavailable" };
    state.decisionRows = [decision("run-chat", 300, 350, "9")];
    const out = await readTenantCapAndToday(TENANT);
    expect(out.cap).not.toBeNull();
    expect(out.today_total_change_usd).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("does the same when the LEGACY rail is the one that fails", async () => {
    state.decisionError = { message: "decisions unavailable" };
    state.actionRows = [action("run-a", 100, 150)];
    const out = await readTenantCapAndToday(TENANT);
    expect(out.cap).not.toBeNull();
    expect(out.today_total_change_usd).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("a failed rail still refuses an over-ceiling raise, and still refuses the unreadable day", async () => {
    state.actionError = { message: "channel_actions unavailable" };
    const { cap, today_total_change_usd } = await readTenantCapAndToday(TENANT);
    expect(
      evaluateBudgetCap({
        proposed_daily_budget_usd: 5000,
        current_daily_budget_usd: 100,
        today_total_change_usd,
        cap,
      }),
    ).toEqual({ within: false, reason: "over_absolute_ceiling" });

    expect(
      evaluateBudgetCap({
        proposed_daily_budget_usd: 110,
        current_daily_budget_usd: 100,
        today_total_change_usd,
        cap: { ...cap!, max_daily_total_change_usd: 50 },
      }),
    ).toEqual({ within: false, reason: "over_daily_aggregate" });
  });

  it("does not refuse on a daily-total axis the operator never set", async () => {
    state.actionError = { message: "channel_actions unavailable" };
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
