
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = { status: string; decision_class: string; agent_run_id: string; body: Record<string, unknown> };

type ActionRow = { run_id: string; exec_class: string; exec_payload: Record<string, unknown> };
const state = { rows: [] as Row[], actionRows: [] as ActionRow[], capRow: null as unknown };

function builder(table: string) {
  let classes: string[] | null = null;
  const self = {
    select: () => self,
    eq: () => self,
    in: (col: string, vals: string[]) => {
      if (col === "decision_class") classes = vals;
      return self;
    },
    gte: () => self,
    or: () => self,
    neq: () => self,
    maybeSingle: async () => ({ data: state.capRow, error: null }),
    then: undefined as unknown,
  };
  (self as unknown as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
    if (table === "channel_actions") return resolve({ data: state.actionRows, error: null });
    if (table !== "decisions") return resolve({ data: null, error: null });
    const rows = classes === null ? state.rows : state.rows.filter((r) => classes!.includes(r.decision_class));
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
  state.actionRows = [];
  state.capRow = { enabled: true, max_daily_budget_usd: 100, max_pct_change_per_run: null, max_daily_total_change_usd: 40 };
});

describe("new daily budgets count toward today's Meta total", () => {
  it("an earlier $30 one-card launch makes a second $30 launch break a $40 ceiling", async () => {
    state.rows = [{ status: "acted", decision_class: "meta_ads.launch_campaign", agent_run_id: "r1", body: { campaign: { daily_budget_usd: 30 } } }];
    const out = await readTenantCapAndToday(TENANT);
    expect(out.today_total_change_usd).toBe(30);
    const second = evaluateBudgetCap({ proposed_daily_budget_usd: 30, current_daily_budget_usd: 0, today_total_change_usd: out.today_total_change_usd, cap: out.cap });
    expect(second.within).toBe(false);
  });

  it.each(["meta_ads.create_campaign", "meta_ads.create_ad_set", "meta_ads.duplicate_campaign", "meta_ads.duplicate_ad_set"])(
    "%s counts its whole daily budget",
    async (cls) => {
      state.rows = [{ status: "acted", decision_class: cls, agent_run_id: "r1", body: { daily_budget_usd: 25 } }];
      expect((await readTenantCapAndToday(TENANT)).today_total_change_usd).toBe(25);
    },
  );

  it("two same-run copies of different ad sets at the same amount count twice", async () => {
    state.rows = [
      { status: "acted", decision_class: "meta_ads.duplicate_ad_set", agent_run_id: "r1", body: { source_ad_set_id: "111", daily_budget_usd: 20 } },
      { status: "acted", decision_class: "meta_ads.duplicate_ad_set", agent_run_id: "r1", body: { source_ad_set_id: "222", daily_budget_usd: 20 } },
    ];
    expect((await readTenantCapAndToday(TENANT)).today_total_change_usd).toBe(40);
  });

  it("two same-run launches at the same amount count twice", async () => {
    state.rows = [
      { status: "acted", decision_class: "meta_ads.launch_campaign", agent_run_id: "r1", body: { campaign: { name: "A", daily_budget_usd: 30 } } },
      { status: "acted", decision_class: "meta_ads.launch_campaign", agent_run_id: "r1", body: { campaign: { name: "B", daily_budget_usd: 30 } } },
    ];
    expect((await readTenantCapAndToday(TENANT)).today_total_change_usd).toBe(60);
  });

  it("two same-run ad sets created under one campaign at the same amount count twice", async () => {
    state.rows = [
      { status: "acted", decision_class: "meta_ads.create_ad_set", agent_run_id: "r1", body: { campaign_id: "c1", name: "East", daily_budget_usd: 25 } },
      { status: "acted", decision_class: "meta_ads.create_ad_set", agent_run_id: "r1", body: { campaign_id: "c1", name: "West", daily_budget_usd: 25 } },
    ];
    expect((await readTenantCapAndToday(TENANT)).today_total_change_usd).toBe(50);
  });

  it("two same-run copies of ONE source ad set (different names) count twice", async () => {
    state.rows = [
      { status: "acted", decision_class: "meta_ads.duplicate_ad_set", agent_run_id: "r1", body: { source_ad_set_id: "111", name: "East", daily_budget_usd: 40 } },
      { status: "acted", decision_class: "meta_ads.duplicate_ad_set", agent_run_id: "r1", body: { source_ad_set_id: "111", name: "West", daily_budget_usd: 40 } },
    ];
    expect((await readTenantCapAndToday(TENANT)).today_total_change_usd).toBe(80);
  });

  it("two same-run launches that reuse one campaign name count twice", async () => {
    state.rows = [
      { status: "acted", decision_class: "meta_ads.launch_campaign", agent_run_id: "r1", body: { campaign: { name: "Spring", daily_budget_usd: 30 } } },
      { status: "acted", decision_class: "meta_ads.launch_campaign", agent_run_id: "r1", body: { campaign: { name: "Spring", daily_budget_usd: 30 } } },
    ];
    expect((await readTenantCapAndToday(TENANT)).today_total_change_usd).toBe(60);
  });

  it("one budget change found in BOTH tables counts once, even when only one copy carries a display name", async () => {
    const body = { ad_set_id: "111", daily_budget_usd: 20, expected_current_daily_budget_usd: 10 };
    state.actionRows = [{ run_id: "r1", exec_class: "meta_ads.update_ad_set_budget", exec_payload: { ...body, name: "Prospecting" } }];
    state.rows = [{ status: "acted", decision_class: "meta_ads.update_ad_set_budget", agent_run_id: "r1", body }];
    expect((await readTenantCapAndToday(TENANT)).today_total_change_usd).toBe(10);
  });

  it("one launch found in both tables counts once", async () => {
    const body = { campaign: { name: "Spring", daily_budget_usd: 30 } };
    state.actionRows = [{ run_id: "r1", exec_class: "meta_ads.launch_campaign", exec_payload: body }];
    state.rows = [{ status: "acted", decision_class: "meta_ads.launch_campaign", agent_run_id: "r1", body }];
    expect((await readTenantCapAndToday(TENANT)).today_total_change_usd).toBe(30);
  });

  it("a create with no budget (one under a campaign budget) adds nothing", async () => {
    state.rows = [{ status: "acted", decision_class: "meta_ads.create_ad_set", agent_run_id: "r1", body: {} }];
    expect((await readTenantCapAndToday(TENANT)).today_total_change_usd).toBe(0);
  });
});
