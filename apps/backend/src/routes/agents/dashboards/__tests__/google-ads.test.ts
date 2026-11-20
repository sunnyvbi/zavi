
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ list: vi.fn(), daily: vi.fn(), creds: vi.fn(), search: vi.fn() }));
vi.mock("@/services/tools/google-ads/list_campaigns", () => ({ listCampaignsTool: { execute: m.list } }));
vi.mock("@/services/tools/google-ads/daily_series", () => ({ fetchGoogleDailySeries: m.daily }));
vi.mock("@/services/tools/google-ads/_client", () => ({
  googleAdsCreds: m.creds,
  createGoogleAdsReadSession: () => m.search,
}));

const ch = vi.hoisted(() => ({ actions: [] as unknown[] }));
vi.mock("@/services/channels/channel-actions", async () => {
  const actual = await vi.importActual<typeof import("@/services/channels/channel-actions")>(
    "@/services/channels/channel-actions",
  );
  return {
    ...actual,
    listChannelActions: async () => ({ actions: ch.actions, more: 0, store: "channel_actions" as const }),
  };
});

import { buildExecCardBody } from "@/services/tools/google-ads/write/_exec-action";
import {
  build,
  buildKpis,
  cappedCampaigns,
  computePacing,
  conversionSplit,
  sumDailyBudgets,
  toAction,
  windowLabel,
  type GadsAction,
  type GadsKpi,
} from "../google-ads";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const OTHER = "11111111-1111-1111-1111-111111111111";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function fakeSb(tables: Tables) {
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      select: self,
      order: self,
      limit: self,
      eq: (k: string, v: unknown) => ((rows = rows.filter((r) => r[k] === v)), chain),
      in: (k: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(r[k]))), chain),
      like: (k: string, pat: string) => ((rows = rows.filter((r) => String(r[k]).startsWith(pat.replace(/%$/, "")))), chain),
      is: (k: string, v: unknown) => ((rows = rows.filter((r) => (r[k] ?? null) === v)), chain),
      gte: (k: string, v: string) => ((rows = rows.filter((r) => typeof r[k] === "string" && (r[k] as string) >= v)), chain),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (res: (v: { data: Row[]; error: null }) => void) => res({ data: rows, error: null }),
    });
    return chain;
  };
  return { from } as never;
}

const ctx = (tables: Tables, rangeDays: number | null = 30) => ({
  tenantId: TENANT,
  accessToken: "t",
  ctx: { tenant_id: TENANT, log: vi.fn() } as never,
  sb: fakeSb(tables),
  refresh: false,
  meteredRefresh: false,
  rangeDays,
});

const campaign = (id: string, name: string, spend: number, conv: number, value: number, status = "ENABLED", channelType = "SEARCH") => ({
  campaign_id: id,
  campaign_name: name,
  status,
  channel_type: channelType,
  spend_usd: spend,
  conversions: conv,
  conversions_value_usd: value,
});

function mockGoogle() {
  m.search.mockImplementation(async (q: string) => {
    if (q.includes("FROM customer LIMIT 1")) return [{ customer: { id: "1234567890", descriptiveName: "Emergency plumbing account", timeZone: "America/Los_Angeles", currencyCode: "EUR" } }];
    if (q.includes("campaign_budget.amount_micros")) {
      return [
        { campaign: { id: "1", status: "ENABLED", campaignBudget: "customers/1/campaignBudgets/A" }, campaignBudget: { amountMicros: "100000000" } },
        { campaign: { id: "2", status: "ENABLED", campaignBudget: "customers/1/campaignBudgets/A" }, campaignBudget: { amountMicros: "100000000" } },
        { campaign: { id: "3", status: "ENABLED", campaignBudget: "customers/1/campaignBudgets/B" }, campaignBudget: { amountMicros: "50000000" } },
      ];
    }
    if (q.includes("primary_status_reasons")) return [{ campaign: { id: "1", primaryStatus: "LIMITED", primaryStatusReasons: ["BUDGET_CONSTRAINED"] } }];
    if (q.includes("segments.conversion_action_category")) {
      return [
        { segments: { conversionAction: "ca/1", conversionActionCategory: "PHONE_CALL_LEAD" }, metrics: { conversions: 20, conversionsValue: 0 } },
        { segments: { conversionAction: "ca/2", conversionActionCategory: "SUBMIT_LEAD_FORM" }, metrics: { conversions: 10, conversionsValue: 900 } },
      ];
    }
    if (q.includes("FROM conversion_action")) return [{ conversionAction: { resourceName: "ca/1", type: "AD_CALL" } }];
    if (q.includes("DURING THIS_MONTH")) return [{ metrics: { costMicros: "900000000" } }];
    return [];
  });
  m.list.mockImplementation(async (_ctx: unknown, input: { custom_range: { since: string } }) => {
    const isPrev = m.list.mock.calls.length > 1 && input.custom_range.since < (m.list.mock.calls[0][1] as { custom_range: { since: string } }).custom_range.since;
    return isPrev
      ? { campaigns: [campaign("1", "Emergency Plumbing", 800, 10, 400)] }
      : { campaigns: [campaign("1", "Emergency Plumbing", 1000, 30, 900), campaign("2", "Drain", 0, 0, 0, "ENABLED", "VIDEO"), campaign("9", "Old", 0, 0, 0, "PAUSED")] };
  });
  m.daily.mockResolvedValue({ rows: [] });
  m.creds.mockResolvedValue({ customer_id: "1234567890" });
}

const now = new Date().toISOString();
const budgetBody = {
  campaign_id: "1",
  daily_budget_usd: 250,
  expected_current_daily_budget_usd: 180,
  rationale: "hits its cap",
  over_cap: true,
  name: "Emergency Plumbing",
  decision_evidence: {
    reason_text: "Hit its cap 26 of 30 days.",
    stats: [{ value: "26 of 30", caption: "days the campaign hit its daily cap" }],
    window: { from: "2026-08-17", to: "2026-09-15" },
    estimate: [{ value: "≈ 39", caption: "more jobs a month" }],
  },
};

function action(over: Row): Row {
  return {
    id: "a",
    channel_slug: "google_ads",
    run_id: "r1",
    position: 1,
    run_of: 1,
    blocking: false,
    action_type: "update_ad",
    title: "t",
    body: {},
    status: "pending",
    note: null,
    snoozed_until: null,
    impact: null,
    impact_reason: null,
    score: 50,
    score_inputs: {},
    proposed_at: now,
    repeat_of: null,
    redo_of: null,
    executable: false,
    exec_status: null,
    edited_body: null,
    source: "channel_action",
    ...over,
  };
}

function channelActions(): Row[] {
  return [
    action({
      id: "d-budget",
      executable: true,
      proposed_at: now,
      body: buildExecCardBody("google_ads.update_campaign_budget_review", budgetBody).card,
    }),
    action({
      id: "d-step",
      action_type: "fix",
      proposed_at: "2026-09-01T00:00:00Z",
      body: { step: { title: "Send booked job value back to Google Ads", body: "Import call value nightly. Calls carry no value today, so ROAS reads low.", effort: "hours", blocking: false, evidence: ["x"] } },
    }),
  ];
}

function tables(): Tables {
  return {
    decisions: [
      { id: "d-auto", tenant_id: TENANT, status: "dispatched", decision_class: "google_ads.set_status", body: { campaign_id: "1", status: "PAUSED", over_cap: false, name: "Brand" }, emitted_at: now, agent_run_id: "r1", autonomy_at_emit: "auto", dispatched_at: now, dispatch_error: null },
      { id: "d-auto-other", tenant_id: OTHER, status: "dispatched", decision_class: "google_ads.set_status", body: { campaign_id: "1", status: "PAUSED", over_cap: false }, emitted_at: now, agent_run_id: "rx", autonomy_at_emit: "auto", dispatched_at: now, dispatch_error: null },
    ],
    agent_runs: [
      { id: "r1", tenant_id: TENANT, agent_slug: "google_ads" },
      { id: "r-x", tenant_id: TENANT, agent_slug: "x_organic" },
    ],
    tenant_channels: [],
  };
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  ch.actions = channelActions();
  mockGoogle();
});

describe("google_ads dashboard builder", () => {
  it("not connected: no Google numbers, a not_connected code, no throw", async () => {
    m.search.mockRejectedValue(Object.assign(new Error("no"), { code: "google_ads_not_connected" }));
    const d = await build(ctx(tables()));
    expect(d).toMatchObject({ connected: false, error_code: "not_connected", kpis: [], campaigns: [], actions: [] });
  });

  it("token revoked: a reconnect code, and the cards still come from our table", async () => {
    m.search.mockRejectedValue(Object.assign(new Error("revoked"), { code: "google_ads_token_revoked" }));
    const d = await build(ctx(tables()));
    expect(d).toMatchObject({ connected: true, error_code: "google_ads_token_revoked", kpis: [] });
    expect((d.actions as GadsAction[]).map((a) => a.decision_id)).toContain("d-budget");
  });

  it("an executable ad change whose body would not dispatch shows no change table", async () => {
    ch.actions = [
      action({
        id: "d-bad",
        executable: true,
        body: buildExecCardBody("google_ads.update_campaign_budget_review", { campaign_id: "1" }).card,
      }),
    ];
    const d = await build(ctx(tables()));
    const bad = (d.actions as GadsAction[]).find((a) => a.decision_id === "d-bad");
    expect(bad?.exact_change).toBeNull();
    expect(bad?.change_sentence).toBeNull();
  });

  it("builds the six KPIs in order, the campaign table and the three card buckets", async () => {
    const d = await build(ctx(tables()));
    expect(d.currency).toBe("EUR");
    expect(d.account).toEqual({ name: "Emergency plumbing account", customer_id: "1234567890", campaign_count: 2 });
    const kpis = d.kpis as GadsKpi[];
    expect(kpis.map((k) => k.key)).toEqual(["spend", "conversions", "cpa", "conv_value", "roas", "pacing"]);
    expect(kpis[0]).toMatchObject({ value: 1000, prev: 800, delta_pct: 25, delta_good: null });
    expect(kpis[1]).toMatchObject({ value: 30, conversions: { calls: 20, forms: 10, other: 0 } });
    expect(kpis[2]).toMatchObject({ value: 33.33, prev: 80, delta_good: true });
    expect(kpis[3]).toMatchObject({ value: 900, partial: true });
    expect(kpis[4]).toMatchObject({ value: 0.9, floor: true });
    const pacing = kpis[5].pacing!;
    expect(pacing.plan_basis).toBe("auto");
    expect(pacing.plan).toBe(150 * pacing.days_in_month);
    expect(pacing.spend).toBe(900);

    const campaigns = d.campaigns as Array<{ id: string; channel_type: string | null; limited_by_budget: boolean; cpa: number | null }>;
    expect(campaigns.map((c) => c.id)).toEqual(["1", "2"]);
    expect(campaigns[0].limited_by_budget).toBe(true);
    expect(campaigns[1].channel_type).toBe("VIDEO");
    expect(campaigns[1].cpa).toBeNull();
    expect(d.paused_campaigns).toEqual([expect.objectContaining({ id: "9", channel_type: "SEARCH" })]);
    expect(d.totals).toMatchObject({ campaigns: 2, spend: 1000, conversions: 30, roas: 0.9 });

    const actions = d.actions as GadsAction[];
    const ids = actions.map((a) => a.decision_id);
    expect(ids).toEqual(["d-budget", "d-step", "d-auto"]);
    expect(ids).not.toContain("d-auto-other");
    expect(d.counts).toEqual({ all: 3, needs_you: 2, autonomous: 1 });

    const budget = actions[0];
    expect(budget).toMatchObject({
      bucket: "needs_approval",
      is_new: true,
      exact_change: { rows: [{ item: "“Emergency Plumbing” (campaign 1) daily budget", before: "$180/day", after: "$250/day" }] },
      estimate: { tiles: [{ value: "≈ 39", caption: "more jobs a month" }] },
      link: null,
    });
    expect(budget.evidence).toEqual({
      window_label: "Aug 17 – Sep 15, 2026 · 30 days",
      tiles: [{ value: "26 of 30", caption: "days the campaign hit its daily cap" }],
      reasoning: "Hit its cap 26 of 30 days.",
    });
    expect(actions[1]).toMatchObject({ bucket: "needs_you", exact_change: null, effort_label: "about an hour", is_new: false });
    expect(actions[2]).toMatchObject({ bucket: "autonomous", applied_at: now });
  });

  it("the founder's monthly plan wins over the derived one", async () => {
    const t = tables();
    t.tenant_channels = [{ tenant_id: TENANT, channel_slug: "google_ads", monthly_budget_usd: 5000 }];
    const d = await build(ctx(t));
    const pacing = (d.kpis as GadsKpi[])[5].pacing!;
    expect(pacing).toMatchObject({ plan: 5000, plan_basis: "founder" });
  });

  it("asks Google for equal-length current and previous windows", async () => {
    await build(ctx(tables(), 7));
    const ranges = m.list.mock.calls.map((c) => (c[1] as { custom_range: { since: string; until: string } }).custom_range);
    const len = (r: { since: string; until: string }) => (Date.parse(r.until) - Date.parse(r.since)) / 86_400_000 + 1;
    expect(ranges).toHaveLength(2);
    expect(len(ranges[0])).toBe(7);
    expect(len(ranges[1])).toBe(7);
  });
});

describe("pure pieces", () => {
  it("CPA is null at 0 conversions and ROAS is null at $0 spend", () => {
    const pacing = computePacing({ today: "2026-09-15", mtdSpend: null, founderPlan: null, dailyBudgetSum: null, capped: null });
    const k = buildKpis({ cur: { spend: 0, conversions: 0, conv_value: 0 }, prev: null, split: null, pacing });
    expect(k[2].value).toBeNull();
    expect(k[4].value).toBeNull();
    expect(k[0].delta_pct).toBeNull();
    expect(k[5].value).toBeNull();
  });

  it("pacing: spend to date against plan × elapsed ÷ days in month", () => {
    const p = computePacing({ today: "2026-09-15", mtdSpend: 9400, founderPlan: 20000, dailyBudgetSum: null, capped: { capped: 3, campaigns: 7 } });
    expect(p).toMatchObject({ plan: 20000, plan_basis: "founder", days_in_month: 30, days_elapsed: 15, pct: 94, capped_campaigns: 3, campaigns: 7 });
  });

  it("a shared budget is counted once, paused campaigns not at all", () => {
    expect(
      sumDailyBudgets([
        { campaign_id: "1", status: "ENABLED", budget_resource: "A", daily_budget: 100, limited_by_budget: false },
        { campaign_id: "2", status: "ENABLED", budget_resource: "A", daily_budget: 100, limited_by_budget: false },
        { campaign_id: "3", status: "PAUSED", budget_resource: "B", daily_budget: 70, limited_by_budget: false },
      ]),
    ).toBe(100);
  });

  it("hit-their-cap counts campaigns at ≥95% of budget on at least half their spend days", () => {
    const b = [{ campaign_id: "1", status: "ENABLED", budget_resource: "A", daily_budget: 100, limited_by_budget: false }];
    const day = (d: string, spend: number) => ({ date: d, campaign_id: "1", campaign_name: "x", spend_usd: spend, impressions: 0, clicks: 0, conversions: 0, conversions_value_usd: 0 });
    expect(cappedCampaigns([day("a", 99), day("b", 40)], b)).toEqual({ capped: 1, campaigns: 1 });
    expect(cappedCampaigns([day("a", 99), day("b", 40), day("c", 40)], b)).toEqual({ capped: 0, campaigns: 1 });
  });

  it("conversion split: call type under another category still counts as a call", () => {
    const s = conversionSplit(
      [
        { action: "ca/9", category: "CONTACT", conversions: 5, value: 10 },
        { action: "ca/8", category: "PURCHASE", conversions: 2, value: 50 },
      ],
      new Map([["ca/9", "WEBSITE_CALL"]]),
    );
    expect(s).toMatchObject({ calls: 5, forms: 0, other: 2, partial: false });
  });

  it("a legacy proposal with no evidence renders title and rows only", () => {
    const a = toAction(
      { id: "d", decision_class: "google_ads.set_status_review", body: { campaign_id: "1", status: "PAUSED", over_cap: false }, emitted_at: null, agent_run_id: null },
      "needs_approval",
      null,
      Date.now(),
    );
    expect(a).toMatchObject({ title: "Pause campaign 1", evidence: null, estimate: null, link: null });
    expect(a!.exact_change!.rows).toHaveLength(1);
  });

  it("a status card is titled by the server, never by the agent's headline (bug #12)", () => {
    const body = {
      campaign_id: "1",
      status: "PAUSED",
      over_cap: false,
      name: "Gig Rentals",
      decision_evidence: { reason_text: "r", headline: "Pause the ad group that never booked" },
    };
    const a = toAction(
      { id: "d", decision_class: "google_ads.set_status_review", body, emitted_at: null, agent_run_id: null },
      "needs_approval",
      null,
      Date.now(),
    );
    expect(a!.title).toBe("Pause “Gig Rentals” (campaign 1)");
    const budget = toAction(
      {
        id: "b",
        decision_class: "google_ads.update_campaign_budget_review",
        body: { campaign_id: "2", name: "Search A", verified_name: "Search A", daily_budget_usd: 120, expected_current_daily_budget_usd: 110, rationale: "r", over_cap: true, decision_evidence: { reason_text: "r", headline: "Let the campaign that books spend the extra $10 a day" } },
        emitted_at: null,
        agent_run_id: null,
      },
      "needs_approval",
      null,
      Date.now(),
    );
    expect(budget!.title).toBe("Raise “Search A” from $110 to $120 a day");
  });

  it("a keyword card keeps the agent's headline as the title and the server-built change line", () => {
    const body = {
      campaign_id: "1",
      name: "Gig Rentals",
      level: "campaign",
      negative: true,
      keywords: [{ text: "rival brand", match_type: "PHRASE" }],
      rationale: "r",
      over_cap: false,
      decision_evidence: { reason_text: "r", headline: "Block searches for a rival brand" },
    };
    const a = toAction({ id: "k", decision_class: "google_ads.add_keywords", body, emitted_at: null, agent_run_id: null }, "needs_approval", null, Date.now());
    expect(a!.title).toBe("Block searches for a rival brand");
    const plain = toAction({ id: "k", decision_class: "google_ads.add_keywords", body: { ...body, decision_evidence: { reason_text: "r" } }, emitted_at: null, agent_run_id: null }, "needs_approval", null, Date.now());
    expect(a!.change_sentence).toBe(plain!.change_sentence);
  });

  it("window label", () => {
    expect(windowLabel({ from: "2026-07-17", to: "2026-09-15" })).toBe("Jul 17 – Sep 15, 2026 · 61 days");
    expect(windowLabel(null)).toBeNull();
  });
});

describe("conversionSplit labels by category (2026-09-18)", () => {
  it("names purchases instead of lumping them into other", () => {
    const s = conversionSplit(
      [{ action: "a/1", category: "PURCHASE", conversions: 5, value: 771.58 }],
      new Map(),
    );
    expect(s.by_kind).toEqual([{ label: "purchases", count: 5 }]);
    expect(s.partial).toBe(false);
  });
});
