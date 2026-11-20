
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const state = { decisions: [] as Row[], actions: [] as Row[], capRow: null as unknown };

function builder(table: string) {
  let classes: string[] | null = null;
  let statuses: string[] | null = null;
  let execStatuses: string[] | null = null;
  const self = {
    select: () => self,
    eq: () => self,
    in: (col: string, vals: string[]) => {
      if (col === "decision_class" || col === "exec_class") classes = vals;
      if (col === "status") statuses = vals;
      if (col === "exec_status") execStatuses = vals;
      return self;
    },
    gte: () => self,
    or: () => self,
    neq: () => self,
    maybeSingle: async () => ({ data: state.capRow, error: null }),
    then: undefined as unknown,
  };
  (self as unknown as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
    const keep = (r: Row, cls: unknown) => classes === null || classes.includes(String(cls));
    if (table === "channel_actions") {
      return resolve({ data: state.actions.filter((r) => keep(r, r.exec_class) && (execStatuses === null || execStatuses.includes(String(r.exec_status)))), error: null });
    }
    if (table === "decisions") {
      return resolve({ data: state.decisions.filter((r) => keep(r, r.decision_class) && (statuses === null || statuses.includes(String(r.status)))), error: null });
    }
    return resolve({ data: null, error: null });
  };
  return self;
}

vi.mock("@/services/tools/meta-ads/_client", () => ({ getAdAccountCurrency: async () => "USD" }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: (t: string) => builder(t) }) }));

import { readTenantGoogleCapAndToday } from "../cap-reader";
import { readTenantCapAndToday } from "@/services/tools/meta-ads/write/cap-reader";
import { evaluateBudgetCap } from "@/services/tools/meta-ads/write/_cap-evaluator";
import { DAILY_AGGREGATE_UNREADABLE } from "@/services/tools/meta-ads/write/_simulate";

const TENANT = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  state.decisions = [];
  state.actions = [];
  state.capRow = { enabled: true, max_daily_budget_usd: 1000, max_pct_change_per_run: null, max_daily_total_change_usd: 100 };
});

describe("Google: creates count from zero", () => {
  it("an earlier $60 create makes a second $60 create break a $100 ceiling (the incident shape)", async () => {
    state.decisions = [{ status: "acted", decision_class: "google_ads.create_campaign", agent_run_id: "r1", body: { daily_budget_usd: 60, name: "A" } }];
    const out = await readTenantGoogleCapAndToday(TENANT);
    expect(out.today_total_change_usd).toBe(60);
    expect(evaluateBudgetCap({ proposed_daily_budget_usd: 60, current_daily_budget_usd: 0, today_total_change_usd: out.today_total_change_usd, cap: out.cap }).within).toBe(false);
  });

  it("two same-run creates at one budget are two creates", async () => {
    state.actions = [
      { exec_status: "executed", exec_class: "google_ads.create_campaign", run_id: "r1", exec_payload: { daily_budget_usd: 30, name: "A" } },
      { exec_status: "executed", exec_class: "google_ads.create_campaign", run_id: "r1", exec_payload: { daily_budget_usd: 30, name: "B" } },
    ];
    expect((await readTenantGoogleCapAndToday(TENANT)).today_total_change_usd).toBe(60);
  });

  it("a create being executed right now counts too (two overlapping dispatches see each other)", async () => {
    state.actions = [{ exec_status: "dispatching", exec_class: "google_ads.create_campaign", run_id: "r1", exec_payload: { daily_budget_usd: 60 } }];
    expect((await readTenantGoogleCapAndToday(TENANT)).today_total_change_usd).toBe(60);
  });
});

describe("Google: an enable counts the amount dispatch recorded", () => {
  it("counts an executed enable by its recorded amount, on either rail", async () => {
    state.actions = [{ exec_status: "executed", exec_class: "google_ads.set_status", run_id: "r1", exec_payload: { campaign_id: "1", level: "campaign", status: "ENABLED" }, cap_counted: { daily: 45, currency: "USD" } }];
    state.decisions = [{ status: "acted", decision_class: "google_ads.set_status_review", agent_run_id: "r2", body: { campaign_id: "2", level: "campaign", status: "ENABLED" }, cap_counted: { daily: 15, currency: "USD" } }];
    expect((await readTenantGoogleCapAndToday(TENANT)).today_total_change_usd).toBe(60);
  });

  it("an enable with no recorded amount makes the day unreadable, never zero", async () => {
    state.decisions = [{ status: "acted", decision_class: "google_ads.set_status", agent_run_id: "r1", body: { campaign_id: "1", level: "campaign", status: "ENABLED" } }];
    expect((await readTenantGoogleCapAndToday(TENANT)).today_total_change_usd).toBe(DAILY_AGGREGATE_UNREADABLE);
  });

  it("a pause counts nothing and needs no recorded amount", async () => {
    state.decisions = [{ status: "acted", decision_class: "google_ads.set_status", agent_run_id: "r1", body: { campaign_id: "1", level: "campaign", status: "PAUSED" } }];
    expect((await readTenantGoogleCapAndToday(TENANT)).today_total_change_usd).toBe(0);
  });
});

describe("Meta: a switch-on counts the amount dispatch recorded", () => {
  it("counts an executed switch-on with the budget changes of the day", async () => {
    state.actions = [{ exec_status: "executed", exec_class: "meta_ads.set_status", run_id: "r1", exec_payload: { object_id: "9", level: "adset", status: "ACTIVE" }, cap_counted: { daily: 40, currency: "USD" } }];
    state.decisions = [{ status: "acted", decision_class: "meta_ads.update_ad_set_budget", agent_run_id: "r2", body: { ad_set_id: "8", daily_budget_usd: 30, expected_current_daily_budget_usd: 10 } }];
    expect((await readTenantCapAndToday(TENANT)).today_total_change_usd).toBe(60);
  });

  it("a switch-on with no recorded amount makes the day unreadable", async () => {
    state.actions = [{ exec_status: "executed", exec_class: "meta_ads.set_status_review", run_id: "r1", exec_payload: { object_id: "9", level: "adset", status: "ACTIVE" } }];
    expect((await readTenantCapAndToday(TENANT)).today_total_change_usd).toBe(DAILY_AGGREGATE_UNREADABLE);
  });

  it("a pause counts nothing", async () => {
    state.actions = [{ exec_status: "executed", exec_class: "meta_ads.set_status", run_id: "r1", exec_payload: { object_id: "9", level: "adset", status: "PAUSED" } }];
    expect((await readTenantCapAndToday(TENANT)).today_total_change_usd).toBe(0);
  });
});

describe("a failed attempt counts only when it reached the platform call", () => {
  it("a failed enable that recorded its amount counts (its outcome is not known); one that did not, does not", async () => {
    state.decisions = [
      { status: "dispatch_failed", decision_class: "google_ads.set_status", agent_run_id: "r1", body: { campaign_id: "1", level: "campaign", status: "ENABLED" }, cap_counted: { daily: 40, currency: "USD" } },
      { status: "dispatch_failed", decision_class: "google_ads.set_status", agent_run_id: "r2", body: { campaign_id: "2", level: "campaign", status: "ENABLED" } },
    ];
    expect((await readTenantGoogleCapAndToday(TENANT)).today_total_change_usd).toBe(40);
  });

  it("a failed Meta switch-on that recorded its amount counts", async () => {
    state.actions = [{ exec_status: "failed", exec_class: "meta_ads.set_status", run_id: "r1", exec_payload: { object_id: "9", level: "adset", status: "ACTIVE" }, cap_counted: { daily: 25, currency: "USD" } }];
    expect((await readTenantCapAndToday(TENANT)).today_total_change_usd).toBe(25);
  });

  it("must-not-touch: a failed budget change or create still counts nothing", async () => {
    state.decisions = [
      { status: "dispatch_failed", decision_class: "google_ads.update_campaign_budget", agent_run_id: "r1", body: { campaign_id: "1", daily_budget_usd: 90, expected_current_daily_budget_usd: 10 } },
      { status: "dispatch_failed", decision_class: "google_ads.create_campaign", agent_run_id: "r2", body: { daily_budget_usd: 50 } },
    ];
    expect((await readTenantGoogleCapAndToday(TENANT)).today_total_change_usd).toBe(0);
  });
});

describe("an amount dispatch could not read", () => {
  it("makes the day unreadable on either reader, executed or failed", async () => {
    state.actions = [{ exec_status: "failed", exec_class: "google_ads.set_status", run_id: "r1", exec_payload: { campaign_id: "1", level: "campaign", status: "ENABLED" }, cap_counted: { daily: null, unknown: true, currency: "USD" } }];
    expect((await readTenantGoogleCapAndToday(TENANT)).today_total_change_usd).toBe(DAILY_AGGREGATE_UNREADABLE);
    state.actions = [{ exec_status: "executed", exec_class: "meta_ads.set_status", run_id: "r1", exec_payload: { object_id: "9", level: "adset", status: "ACTIVE" }, cap_counted: { daily: null, unknown: true, currency: "USD" } }];
    expect((await readTenantCapAndToday(TENANT)).today_total_change_usd).toBe(DAILY_AGGREGATE_UNREADABLE);
  });
});
