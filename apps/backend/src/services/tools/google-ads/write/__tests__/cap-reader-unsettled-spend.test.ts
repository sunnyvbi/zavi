
import { describe, it, expect, vi, beforeEach } from "vitest";

type DecisionRow = { status: string; agent_run_id: string | null; decision_class: string; body: Record<string, number> };

const state = {
  decisions: [] as DecisionRow[],
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
    if (table === "channel_actions") return resolve({ data: [], error: null });
    if (table !== "decisions") return resolve({ data: null, error: null });
    const rows =
      statuses === null ? state.decisions : state.decisions.filter((r) => statuses!.includes(r.status));
    return resolve({ data: rows, error: null });
  };
  return self;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: (table: string) => builder(table) }),
}));

import { readTenantGoogleCapAndToday } from "../cap-reader";

const TENANT = "11111111-1111-4111-8111-111111111111";

function row(status: string, from: number, to: number): DecisionRow {
  return {
    status,
    agent_run_id: "run-1",
    decision_class: "google_ads.update_campaign_budget",
    body: { daily_budget_usd: to, expected_current_daily_budget_usd: from },
  };
}

beforeEach(() => {
  state.decisions = [];
  state.capRow = {
    enabled: true,
    max_daily_budget_usd: 1000,
    max_pct_change_per_run: null,
    max_daily_total_change_usd: 100,
  };
});

describe("the Google daily total counts legacy spend whose settlement never landed", () => {
  it("a 'dispatching' legacy budget change counts toward today's total", async () => {
    state.decisions = [row("dispatching", 100, 190)];
    const out = await readTenantGoogleCapAndToday(TENANT);
    expect(out.today_total_change_usd).toBe(90);
  });

  it("a row released back to 'proposed' is NOT counted", async () => {
    state.decisions = [row("proposed", 100, 190)];
    const out = await readTenantGoogleCapAndToday(TENANT);
    expect(out.today_total_change_usd).toBe(0);
  });

  it("settled 'acted' rows still count, unchanged", async () => {
    state.decisions = [row("acted", 100, 150)];
    const out = await readTenantGoogleCapAndToday(TENANT);
    expect(out.today_total_change_usd).toBe(50);
  });
});
