
import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));

const rows: Record<string, unknown[]> = {};

vi.mock("@/services/tenant-client", () => {
  const chain = (table: string): Record<string, unknown> => {
    const self: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "gte", "order", "limit", "is", "neq"]) {
      self[m] = () => self;
    }
    self.maybeSingle = async () => ({ data: (rows[table] ?? [])[0] ?? null, error: null });
    self.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve);
    return self;
  };
  return {
    asTenantId: (t: string) => t,
    tenantClient: () => ({ from: (table: string) => chain(table) }),
    tenantRpc: vi.fn(async () => ({ data: null, error: null })),
  };
});

import { listChannelActions, toActionView } from "../channel-actions";

vi.mock("@/services/growth/preview-plan", () => ({
  planIncludesChannel: vi.fn(async () => true),
}));
vi.mock("@/services/channels/preview-run-starts", () => ({
  previewRunStarts: vi.fn(async () => new Map()),
}));
import { previewRunStarts } from "@/services/channels/preview-run-starts";

const BUDGET = (from: number, to: number) => ({
  campaign_id: "123",
  daily_budget_usd: to,
  expected_current_daily_budget_usd: from,
  rationale: "r",
  over_cap: false,
});

const PAUSE = {
  campaign_id: "123",
  level: "campaign",
  status: "PAUSED",
  rationale: "0 conversions in 30 days",
  over_cap: false,
};

const pauseCard = (daily: number) => ({
  step: { title: "pause" },
  money_at_stake: {
    daily_budget_usd: daily,
    scope: "campaign",
    campaign_id: "123",
    source: "google_ads.campaign_budget",
  },
});

function execRow(id: string, exec_class: string, exec_payload: unknown, body?: unknown) {
  return {
    id,
    channel_slug: "google_ads",
    run_id: "run-1",
    position: 900,
    run_of: 900,
    blocking: false,
    action_type: "update_ad",
    title: id,
    title_key: id,
    body: body ?? { step: { title: id } },
    status: "pending",
    note: null,
    snoozed_until: null,
    impact: null,
    impact_reason: null,
    score: 0,
    score_inputs: {},
    proposed_at: "2026-09-19T10:00:00Z",
    repeat_of: null,
    redo_of: null,
    exec_class,
    exec_payload,
    exec_status: null,
    edited_body: null,
  };
}

describe("listChannelActions ranks executable ad actions by money at stake", () => {
  it("grounds the recommendation in the current projected ranking rather than the stored zero score", () => {
    const row = { ...execRow("ad", "google_ads.create_ad", {}), action_type: "create_ad" as const, impact: 4 };
    expect(row.score).toBe(0);
    expect(toActionView(row, 80, { goal_fit: 1 }).ad_recommendation?.reason).toContain("80/100");
    expect(toActionView(row, 80, {}).ad_recommendation).toBeUndefined();
  });
  it("pages managed customer overflow and returns it when Show more requests all", async () => {
    rows.channel_actions = [
      ...Array.from({ length: 7 }, (_, i) => execRow(`customer-${i}`, "", null, { step: { responsibility: "client" } })),
      execRow("operator", "", null, { step: { responsibility: "zavi" } }),
      execRow("legacy", "", null),
    ];
    const first = await listChannelActions("t-1", "chatgpt_ads");
    expect(first.actions.filter(a => a.id.startsWith("customer"))).toHaveLength(5);
    expect(first.more).toBe(2);
    const expanded = await listChannelActions("t-1", "chatgpt_ads", { all: true });
    expect(expanded.actions.filter(a => a.id.startsWith("customer"))).toHaveLength(7);
    expect(expanded.more).toBe(0);
    expect(expanded.actions.map(a => a.id)).toEqual(expect.arrayContaining(["operator", "legacy"]));
  });

  it("returns a customer card even when five higher ranked legacy cards precede it", async () => {
    rows.channel_actions = [
      ...Array.from({ length: 5 }, (_, i) => ({ ...execRow(`legacy-${i}`, "", null), position: 1, run_of: 1 })),
      execRow("operator", "", null, { step: { responsibility: "zavi" } }),
      execRow("customer", "", null, { step: { responsibility: "client" } }),
    ];
    const out = await listChannelActions("t-1", "chatgpt_ads");
    expect(out.actions.map(a => a.id)).toContain("customer");
    expect(out.actions.map(a => a.id)).toContain("operator");
    expect(out.actions.filter(a => a.id.startsWith("legacy"))).toHaveLength(5);
    expect(out.more).toBe(0);
  });

  it("a $740/month pause outranks a $50/month raise, and an unpriced row stays last", async () => {
    rows.channel_actions = [
      execRow("small-raise", "google_ads.update_campaign_budget", BUDGET(10, 11.64)),
      execRow("unpriced-pause", "google_ads.set_status", { ...PAUSE, campaign_id: "456" }),
      execRow("pause", "google_ads.set_status", PAUSE, pauseCard(24.35)),
    ];
    rows.tenant_channels = [];
    rows.autopilot_goals = [];

    const out = await listChannelActions("t-1", "google_ads", { all: true });
    expect(out.store).toBe("channel_actions");
    expect(out.actions.map((a) => a.id)).toEqual(["pause", "small-raise", "unpriced-pause"]);

    const inputs = out.actions.map((a) => a.score_inputs as Record<string, unknown>);
    expect(inputs[0].rank_n).toBe(1);
    expect(inputs[0].money_at_stake_usd).toBeCloseTo(740, 0);
    expect(inputs[1].money_at_stake_usd).toBeCloseTo(50, 0);
    expect(inputs[1].rank_n).toBeCloseTo(50 / 740, 2);
    expect(inputs[2].rank_n).toBe(0);
    expect(inputs[2].money_at_stake_usd).toBeNull();
  });

  it("the budget it read never reaches the client", async () => {
    rows.channel_actions = [execRow("pause", "google_ads.set_status", PAUSE, pauseCard(24.35))];
    rows.tenant_channels = [];
    rows.autopilot_goals = [];

    const out = await listChannelActions("t-1", "google_ads", { all: true });
    expect((out.actions[0].score_inputs as Record<string, unknown>).money_at_stake_usd).toBeCloseTo(740, 0);
    expect(JSON.stringify(out.actions[0].body)).not.toContain("money_at_stake");
    expect(JSON.stringify(out.actions[0].body)).not.toContain("24.35");
    expect(out.actions[0].body).toEqual({ step: { title: "Pause campaign 123" }, action_label: "Apply change", intent: "improve", owner: "zavi" });
    expect(out.actions[0].title).toBe("Pause campaign 123");
  });

  it("marks only the actions whose run was the signup preview run, with when it ran", async () => {
    rows.channel_actions = [
      { ...execRow("from-signup", "google_ads.update_campaign_budget", BUDGET(10, 60)), run_id: "run-preview" },
      { ...execRow("later", "google_ads.update_campaign_budget", BUDGET(10, 20)), run_id: "run-later" },
    ];
    rows.tenant_channels = [];
    rows.autopilot_goals = [];
    vi.mocked(previewRunStarts).mockResolvedValueOnce(new Map([["run-preview", "2026-08-01T00:00:00Z"]]));

    const out = await listChannelActions("t-1", "google_ads", { all: true });
    const byId = new Map(out.actions.map((a) => [a.id, a]));
    expect(byId.get("from-signup")?.from_signup_preview_at).toBe("2026-08-01T00:00:00Z");
    expect(Object.keys(byId.get("later") ?? {})).not.toContain("from_signup_preview_at");
    expect(vi.mocked(previewRunStarts)).toHaveBeenCalledWith("t-1", expect.arrayContaining(["run-preview", "run-later"]));
  });

  it("a failed preview read leaves the list intact, with no labels", async () => {
    rows.channel_actions = [execRow("a", "google_ads.update_campaign_budget", BUDGET(10, 60))];
    rows.tenant_channels = [];
    rows.autopilot_goals = [];
    vi.mocked(previewRunStarts).mockRejectedValueOnce(new Error("down"));
    const out = await listChannelActions("t-1", "google_ads", { all: true });
    expect(out.actions.map((a) => a.id)).toEqual(["a"]);
    expect(out.actions[0].from_signup_preview_at).toBeUndefined();
  });

  it("never serves exec_payload, and still says the row is executable", async () => {
    rows.channel_actions = [execRow("a", "google_ads.update_campaign_budget", BUDGET(10, 60))];
    rows.tenant_channels = [];
    rows.autopilot_goals = [];

    const out = await listChannelActions("t-1", "google_ads", { all: true });
    expect(out.actions[0].executable).toBe(true);
    expect(JSON.stringify(out.actions[0])).not.toContain("expected_current_daily_budget_usd");
    expect(Object.keys(out.actions[0])).not.toContain("exec_payload");
    expect(Object.keys(out.actions[0])).not.toContain("exec_class");
  });
});
