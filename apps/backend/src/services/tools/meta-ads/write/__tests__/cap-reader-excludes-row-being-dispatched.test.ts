
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = {
  id: string;
  agent_run_id: string;
  decision_class: string;
  status: string;
  body: Record<string, number>;
};
type ExecRow = { id?: string; run_id: string; exec_class: string; exec_payload: Record<string, number> };

const state = {
  decisions: [] as Row[],
  channelActions: [] as ExecRow[],
  capRow: null as unknown,
};

function builder(table: string) {
  let statuses: string[] | null = null;
  let excludedId: string | null = null;
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
    neq: (col: string, val: string) => {
      if (col === "id") excludedId = val;
      return self;
    },
    gte: () => self,
    or: () => self,
    maybeSingle: async () => ({ data: state.capRow, error: null }),
    then: undefined as unknown,
  };
  (self as unknown as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
    if (table === "channel_actions") return resolve({ data: state.channelActions.filter((r) => excludedId === null || r.id !== excludedId), error: null });
    if (table !== "decisions") return resolve({ data: null, error: null });
    const rows = state.decisions
      .filter((r) => statuses === null || statuses.includes(r.status))
      .filter((r) => excludedId === null || r.id !== excludedId);
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
import { readTenantGoogleCapAndToday } from "@/services/tools/google-ads/write/cap-reader";

const TENANT = "11111111-1111-4111-8111-111111111111";

const SELF = {
  id: "self-1",
  agent_run_id: "run-self",
  decision_class: "google_ads.update_campaign_budget",
  status: "dispatching",
  body: { daily_budget_usd: 140, expected_current_daily_budget_usd: 100 },
};
const EARLIER = {
  id: "earlier-1",
  agent_run_id: "run-earlier",
  decision_class: "google_ads.update_campaign_budget",
  status: "acted",
  body: { daily_budget_usd: 140, expected_current_daily_budget_usd: 100 },
};

beforeEach(() => {
  state.decisions = [];
  state.channelActions = [];
  state.capRow = {
    enabled: true,
    max_daily_budget_usd: 1000,
    max_pct_change_per_run: null,
    max_daily_total_change_usd: 100,
  };
});

describe("Meta: today's total excludes the decision being dispatched", () => {
  beforeEach(() => {
    state.decisions = [
      { ...EARLIER, body: { ...EARLIER.body } },
      { ...SELF, body: { ...SELF.body } },
    ];
  });

  it("counts the other rows and not this one", async () => {
    const out = await readTenantCapAndToday(TENANT, "self-1");
    expect(out.today_total_change_usd).toBe(40);
  });

  it("lets a valid raise through instead of reading its own delta twice", async () => {
    const { cap, today_total_change_usd } = await readTenantCapAndToday(TENANT, "self-1");
    expect(
      evaluateBudgetCap({
        proposed_daily_budget_usd: 140,
        current_daily_budget_usd: 100,
        today_total_change_usd,
        cap,
      }),
    ).toEqual({ within: true });
  });

  it("still counts every OTHER stuck 'dispatching' row", async () => {
    state.decisions.push({
      id: "stuck-1",
      agent_run_id: "run-stuck",
      decision_class: "google_ads.update_campaign_budget",
      status: "dispatching",
      body: { daily_budget_usd: 130, expected_current_daily_budget_usd: 100 },
    });
    const out = await readTenantCapAndToday(TENANT, "self-1");
    expect(out.today_total_change_usd).toBe(70);
  });

  it("excludes nothing when no id is passed, which is the propose-time read", async () => {
    const out = await readTenantCapAndToday(TENANT);
    expect(out.today_total_change_usd).toBe(80);
  });
});

describe("Google: today's total excludes the decision being dispatched", () => {
  beforeEach(() => {
    state.decisions = [
      { ...EARLIER, body: { ...EARLIER.body } },
      { ...SELF, body: { ...SELF.body } },
    ];
  });

  it("counts the other rows and not this one", async () => {
    const out = await readTenantGoogleCapAndToday(TENANT, "self-1");
    expect(out.today_total_change_usd).toBe(40);
  });

  it("excludes nothing when no id is passed", async () => {
    const out = await readTenantGoogleCapAndToday(TENANT);
    expect(out.today_total_change_usd).toBe(80);
  });

  it("excludes the card being dispatched on the channel_actions half too, and counts the others", async () => {
    state.channelActions = [
      { id: "self-1", run_id: "run-1", exec_class: "google_ads.update_campaign_budget", exec_payload: { daily_budget_usd: 160, expected_current_daily_budget_usd: 100 } },
      { id: "other", run_id: "run-2", exec_class: "google_ads.update_campaign_budget", exec_payload: { daily_budget_usd: 130, expected_current_daily_budget_usd: 100 } },
    ];
    const out = await readTenantGoogleCapAndToday(TENANT, "self-1");
    expect(out.today_total_change_usd).toBe(70);
  });
});
