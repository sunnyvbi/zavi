import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));
const testEndMock = vi.hoisted(() => ({ end: null as null | { decision_id: string; channel: string | null; ends_on: string } }));
vi.mock("@/services/growth/cgo-test-end", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/cgo-test-end")>()),
  cgoTestEndForRun: vi.fn(async () => testEndMock.end),
}));
import { overProjectionGate } from "@/services/decisions/ad-budget";

const mocks = vi.hoisted(() => ({
  getBudgetMock: vi.fn(),
  getCampaignMock: vi.fn(),
  getAdGroupMock: vi.fn(),
  getAdMock: vi.fn(),
  setCampaignStatusMock: vi.fn(),
  setAdGroupStatusMock: vi.fn(),
  setAdStatusMock: vi.fn(),
  createCampaignMock: vi.fn(),
  updateCampaignMock: vi.fn(),
  createAdGroupMock: vi.fn(),
  updateAdGroupMock: vi.fn(),
  updateBudgetMock: vi.fn(),
  createAdMock: vi.fn(),
  addKeywordsMock: vi.fn(),
  removeMock: vi.fn(),
  capReaderMock: vi.fn(),
  guardFactsMock: vi.fn(),
  pausedMock: vi.fn(),
}));

import { makeAdBudgetFake } from "./_ad-budget-fake";
let fake = makeAdBudgetFake(null);
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ rpc: (n: string, a: Record<string, unknown>) => fake.rpc(n, a) }),
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));
vi.mock("@/services/growth/unattended-policy", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/unattended-policy")>()),
  authorizeUnattended: vi.fn(async () => ({ verdict: "allow", reasons: [] })),
}));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: async () => true }));
vi.mock("@/services/decisions/auto-fire-rate-cap", () => ({ checkAutoFireRateCap: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(), LOG_META_KEYS: [] }));
vi.mock("@/services/decisions/atomic-claim", () => ({ claimDecision: vi.fn(), markDispatched: vi.fn(), releaseClaim: vi.fn() }));
vi.mock("@/services/decisions/waiver-resolve", () => ({ resolveWaiverState: vi.fn(async () => ({ state: "none" })) }));
vi.mock("@/services/agents/log-decision-not-taken", () => ({ logDecisionNotTaken: vi.fn(async () => {}) }));
vi.mock("@/services/memory/stamp-outcome", () => ({ stampOutcomeForDecisionId: vi.fn(async () => {}) }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: vi.fn() }));
vi.mock("@/agents/engineer/output-schema", () => ({ prProposalSchema: { safeParse: () => ({ success: false, error: { issues: [] } }) } }));
vi.mock("@/services/agents/registry", () => ({ loadAgentDefinition: vi.fn() }));
vi.mock("@/services/mcp/internal/jira", () => ({ jiraCreateIssue: vi.fn(), jiraAddComment: vi.fn() }));
vi.mock("@/services/mcp/internal/linear", () => ({ linearCreateIssue: vi.fn(), linearAddComment: vi.fn() }));
vi.mock("../digest-post-handler", () => ({ digestPostHandler: vi.fn() }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: vi.fn(async () => false) }));
vi.mock("../dispatch-notice", () => ({
  buildDispatchNotice: vi.fn(),
  buildOpenPrNotice: vi.fn(),
  extractChatThreadId: vi.fn(),
  HANDLER_LABELS: {},
}));

vi.mock("@/services/tools/google-ads/_client", () => ({
  gadsGetCampaignBudget: mocks.getBudgetMock,
  gadsGetCampaign: mocks.getCampaignMock,
  gadsGetAdGroup: mocks.getAdGroupMock,
  gadsGetAd: mocks.getAdMock,
  gadsGetBudgetGuardFacts: mocks.guardFactsMock,
  gadsSearch: vi.fn(),
  gadsMutate: vi.fn(),
  gadsMutateOperations: vi.fn(),
}));
vi.mock("@/services/tools/google-ads/write/set_status", () => ({
  googleSetCampaignStatus: mocks.setCampaignStatusMock,
  googleSetAdGroupStatus: mocks.setAdGroupStatusMock,
  googleSetAdStatus: mocks.setAdStatusMock,
}));
vi.mock("@/services/tools/google-ads/write/create_campaign", () => ({ googleCreateCampaign: mocks.createCampaignMock }));
vi.mock("@/services/tools/google-ads/write/update_campaign", () => ({ googleUpdateCampaign: mocks.updateCampaignMock }));
vi.mock("@/services/tools/google-ads/write/create_ad_group", () => ({ googleCreateAdGroup: mocks.createAdGroupMock }));
vi.mock("@/services/tools/google-ads/write/update_ad_group", () => ({ googleUpdateAdGroup: mocks.updateAdGroupMock }));
vi.mock("@/services/tools/google-ads/write/create_ad", () => ({ googleCreateAd: mocks.createAdMock }));
vi.mock("@/services/tools/google-ads/write/add_keywords", () => ({ googleAddKeywords: mocks.addKeywordsMock }));
vi.mock("@/services/tools/google-ads/write/remove_resource", () => ({ googleRemoveResource: mocks.removeMock }));
vi.mock("@/services/tools/google-ads/write/update_campaign_budget", () => ({ googleUpdateCampaignBudget: mocks.updateBudgetMock }));
vi.mock("@/services/tools/google-ads/write/cap-reader", () => ({ readTenantGoogleCapAndToday: mocks.capReaderMock }));
vi.mock("@/services/tools/google-ads/write/_paused-postcondition", () => ({ checkCreatedPaused: mocks.pausedMock }));

import { __testOnly_handlers as HANDLERS, NEVER_AUTO_DECISION_CLASSES } from "../dispatch-decision";
import { ExpectedToolError } from "@/services/tools/types";

const GENEROUS_CAP = { enabled: true, max_daily_budget_usd: 100_000, max_pct_change_per_run: null, max_daily_total_change_usd: null };

function row(decision_class: string, body: Record<string, unknown>, approved_by: string | null = null) {
  return { id: "dec", tenant_id: "tenant-1", agent_run_id: "run-1", decision_class, status: "approved", handler: null, body, approved_by };
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => (m as ReturnType<typeof vi.fn>).mockReset());
  fake = makeAdBudgetFake(null);
  mocks.guardFactsMock.mockResolvedValue({ currency_code: "USD", budget_period: "DAILY" });
  mocks.getBudgetMock.mockResolvedValue({
    campaign_resource: "customers/9/campaigns/111",
    campaign_status: "ENABLED",
    budget_resource: "customers/9/campaignBudgets/222",
    amount_micros: 50_000_000,
  });
  mocks.getCampaignMock.mockResolvedValue({
    campaign_resource: "customers/9/campaigns/111",
    campaign_id: "111",
    name: "Brand",
    status: "ENABLED",
    channel_type: "SEARCH",
    bidding_strategy_type: "MAXIMIZE_CONVERSIONS",
    budget_resource: "customers/9/campaignBudgets/222",
    amount_micros: 50_000_000,
  });
  mocks.getAdGroupMock.mockResolvedValue({
    ad_group_resource: "customers/9/adGroups/333",
    ad_group_id: "333",
    name: "Core",
    status: "ENABLED",
    type: "SEARCH_STANDARD",
    campaign_id: "111",
    campaign_resource: "customers/9/campaigns/111",
  });
  mocks.getAdMock.mockResolvedValue({
    ad_group_ad_resource: "customers/9/adGroupAds/333~444",
    ad_id: "444",
    ad_group_id: "333",
    campaign_id: "111",
    status: "ENABLED",
    type: "RESPONSIVE_SEARCH_AD",
  });
  mocks.capReaderMock.mockResolvedValue({ cap: GENEROUS_CAP, today_total_change_usd: 0 });
  mocks.pausedMock.mockResolvedValue({ paused: true, status: "PAUSED" });
  mocks.createCampaignMock.mockResolvedValue({ campaign_id: "555", campaign_resource: "customers/9/campaigns/555", budget_resource: "b", ad_group_id: "556", ad_group_resource: "a", created_resources: 4 });
  mocks.updateCampaignMock.mockResolvedValue({ resource_name: "customers/9/campaigns/111", updated_fields: ["name"] });
  mocks.updateAdGroupMock.mockResolvedValue({ resource_name: "customers/9/adGroups/333", updated_fields: ["cpc_bid_micros"] });
  mocks.updateBudgetMock.mockResolvedValue(undefined);
  mocks.createAdGroupMock.mockResolvedValue({ ad_group_id: "777", ad_group_resource: "customers/9/adGroups/777", created_resources: 1 });
  mocks.createAdMock.mockResolvedValue({ ad_id: "888", ad_group_ad_resource: "customers/9/adGroupAds/333~888", created_resources: 1 });
  mocks.addKeywordsMock.mockResolvedValue({ created: 2, parent_resource: "customers/9/adGroups/333" });
  mocks.removeMock.mockResolvedValue({ removed_resource: "customers/9/campaigns/111", label: 'campaign "Brand"' });
});

describe("google_ads.set_status — ad group and ad levels", () => {
  it("pauses an ad group inside its campaign", async () => {
    const r = await HANDLERS["google_ads.set_status"](
      row("google_ads.set_status", { campaign_id: "111", level: "ad_group", ad_group_id: "333", status: "PAUSED", rationale: "", over_cap: false }),
    );
    expect(r.ok).toBe(true);
    expect(mocks.setAdGroupStatusMock).toHaveBeenCalledWith("tenant-1", { ad_group_resource: "customers/9/adGroups/333", status: "PAUSED" });
    expect(mocks.setCampaignStatusMock).not.toHaveBeenCalled();
  });

  it("refuses an ad group that belongs to a different campaign", async () => {
    mocks.getAdGroupMock.mockResolvedValue({ ad_group_resource: "x", ad_group_id: "333", name: "", status: "", type: "", campaign_id: "999", campaign_resource: "y" });
    const r = await HANDLERS["google_ads.set_status"](
      row("google_ads.set_status", { campaign_id: "111", level: "ad_group", ad_group_id: "333", status: "PAUSED", rationale: "", over_cap: false }),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("google_ads_target_mismatch");
    expect(mocks.setAdGroupStatusMock).not.toHaveBeenCalled();
  });

  it("ENABLED on an ad rechecks the cap against the campaign budget when unattended", async () => {
    mocks.capReaderMock.mockResolvedValue({ cap: { ...GENEROUS_CAP, max_daily_budget_usd: 10 }, today_total_change_usd: 0 });
    const r = await HANDLERS["google_ads.set_status"](
      row("google_ads.set_status_review", { campaign_id: "111", level: "ad", ad_group_id: "333", ad_id: "444", status: "ENABLED", rationale: "", over_cap: true }),
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("cap_refuse");
    expect(mocks.setAdStatusMock).not.toHaveBeenCalled();
  });

  it("ENABLED on an ad with a human approval executes", async () => {
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0 });
    const r = await HANDLERS["google_ads.set_status"](
      row("google_ads.set_status_review", { campaign_id: "111", level: "ad", ad_group_id: "333", ad_id: "444", status: "ENABLED", rationale: "", over_cap: true }, "user-1"),
    );
    expect(r.ok).toBe(true);
    expect(mocks.setAdStatusMock).toHaveBeenCalledWith("tenant-1", { ad_group_ad_resource: "customers/9/adGroupAds/333~444", status: "ENABLED" });
  });
});

describe("google_ads.create_campaign", () => {
  const body = { name: "Brand", channel_type: "SEARCH", daily_budget_usd: 20, bidding: { strategy: "MANUAL_CPC" }, rationale: "" };

  it("unattended with no cap → refuses, no write", async () => {
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0 });
    const r = await HANDLERS["google_ads.create_campaign"](row("google_ads.create_campaign", body));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("no_cap_configured");
    expect(mocks.createCampaignMock).not.toHaveBeenCalled();
  });

  it("human-approved → creates through the executor with the parsed body", async () => {
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0 });
    const r = await HANDLERS["google_ads.create_campaign"](row("google_ads.create_campaign", body, "user-1"));
    expect(r.ok).toBe(true);
    expect(mocks.createCampaignMock).toHaveBeenCalledTimes(1);
    expect(mocks.createCampaignMock.mock.calls[0][1]).toMatchObject({ name: "Brand", channel_type: "SEARCH", location_ids: [] });
    expect(r.notice).toContain("PAUSED");
  });

  it("invalid body → refuses before any lookup", async () => {
    const r = await HANDLERS["google_ads.create_campaign"](row("google_ads.create_campaign", { name: "x" }));
    expect(r.ok).toBe(false);
    expect(mocks.capReaderMock).not.toHaveBeenCalled();
  });
});

describe("google_ads.create_campaign: Demand Gen, approved by cgo under an ad budget", () => {
  const T = "11111111-1111-4111-8111-111111111111";
  const SHA = "e".repeat(64);
  const dgBody = (tenant = T) => ({
    name: "YT launch",
    channel_type: "DEMAND_GEN",
    daily_budget_usd: 30,
    bidding: { strategy: "MAXIMIZE_CONVERSIONS" },
    demand_gen_ad_group: {
      name: "YT launch – video",
      ad: {
        final_urls: ["https://example.com"],
        youtube_video_ids: ["dQw4w9WgXcQ"],
        headlines: ["Book a car"],
        long_headlines: ["Book a car near you"],
        descriptions: ["Cars from local hosts"],
        business_name: "Upcar",
        logo: { storage_path: `${tenant}/logos/${SHA}.png`, sha256: SHA, mime: "image/png", width: 256, height: 256 },
      },
    },
    rationale: "r",
  });
  const cgoRow = (body: Record<string, unknown>) => ({
    id: "act-dg",
    tenant_id: T,
    agent_run_id: "run-1",
    decision_class: "google_ads.create_campaign",
    status: "dispatching",
    handler: "google_ads.create_campaign",
    body,
    approved_by: "owner-1",
    approved_by_source: "cgo",
    exec_source: "channel_actions" as const,
  });

  beforeEach(() => {
    fake = makeAdBudgetFake({ cap: 1000, days: 10, margin: 1.25 });
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, cap_row_absent: true });
  });

  it("reserves the daily budget before the create, commits on success, prefixes the name, checks PAUSED", async () => {
    mocks.createCampaignMock.mockImplementation(async () => {
      expect(fake.namesCalled()).toEqual(["reserve_ad_spend"]);
      return { campaign_id: "555", campaign_resource: "customers/9/campaigns/555", budget_resource: "b", ad_group_id: "556", ad_group_resource: "a", created_resources: 6 };
    });
    const r = await HANDLERS["google_ads.create_campaign"](cgoRow(dgBody()));
    expect(r).toMatchObject({ ok: true });
    const reserve = fake.calls.find((c) => c.name === "reserve_ad_spend")!;
    expect(reserve.args).toMatchObject({ p_platform: "google", p_op: "create", p_object_id: null, p_daily_delta_usd: 30 });
    const settle = fake.calls.find((c) => c.name === "settle_ad_spend")!;
    expect(settle.args).toMatchObject({ p_outcome: "committed", p_object_id: "555" });
    expect(fake.heldDaily("google", "555")).toBe(30);
    const sent = mocks.createCampaignMock.mock.calls[0][1];
    expect(sent.name).toMatch(/YT launch$/);
    expect(sent.name).not.toBe("YT launch");
    expect(sent.demand_gen_ad_group.ad.logo.storage_path).toBe(`${T}/logos/${SHA}.png`);
    expect(mocks.pausedMock).toHaveBeenCalledWith({ tenant_id: T, action_id: "act-dg", campaign_id: "555" });
    expect(r.notice).toMatch(/Demand Gen video campaign .* PAUSED, \$30\/day/);
  });

  it("a mutate that Google rejects releases the hold", async () => {
    mocks.createCampaignMock.mockRejectedValue(new ExpectedToolError("google_ads_mutate_failed", "Google Ads googleAds:mutate failed: 400 {}"));
    const r = await HANDLERS["google_ads.create_campaign"](cgoRow(dgBody()));
    expect(r.ok).toBe(false);
    expect(fake.calls.find((c) => c.name === "settle_ad_spend")!.args).toMatchObject({ p_outcome: "released" });
    expect(fake.budget!.held).toBe(0);
    expect(mocks.pausedMock).not.toHaveBeenCalled();
  });

  it("a stored logo that changed releases the hold and carries the blocked code", async () => {
    mocks.createCampaignMock.mockRejectedValue(new ExpectedToolError("google_ads_demand_gen_logo_mismatch", "its bytes changed"));
    const r = await HANDLERS["google_ads.create_campaign"](cgoRow(dgBody()));
    expect(r).toMatchObject({ ok: false, code: "google_ads_demand_gen_logo_mismatch" });
    expect(fake.budget!.held).toBe(0);
  });

  it("tenant isolation: another tenant's logo path is refused before any cap read or hold", async () => {
    const r = await HANDLERS["google_ads.create_campaign"](cgoRow(dgBody("22222222-2222-4222-8222-222222222222")));
    expect(r).toMatchObject({ ok: false, code: "google_ads_demand_gen_logo_mismatch" });
    expect(mocks.capReaderMock).not.toHaveBeenCalled();
    expect(fake.namesCalled()).toEqual([]);
    expect(mocks.createCampaignMock).not.toHaveBeenCalled();
  });

  it("not PAUSED after create: the notice says so; nothing else is changed", async () => {
    mocks.pausedMock.mockResolvedValue({ paused: false, status: "ENABLED" });
    const r = await HANDLERS["google_ads.create_campaign"](cgoRow(dgBody()));
    expect(r.ok).toBe(true);
    expect(r.notice).toMatch(/Google reports it as ENABLED\. Zavi changed nothing and has alerted the team/);
    expect(mocks.setCampaignStatusMock).not.toHaveBeenCalled();
    expect(fake.heldDaily("google", "555")).toBe(30);
  });

  it("an unverifiable readback says it could not confirm PAUSED", async () => {
    mocks.pausedMock.mockResolvedValue({ paused: null, status: null });
    const r = await HANDLERS["google_ads.create_campaign"](cgoRow(dgBody()));
    expect(r.notice).toMatch(/could not read it back to confirm it is paused/);
  });

  it("cgo with the budget stopped is refused: no spend without an active budget", async () => {
    fake.stop();
    const r = await HANDLERS["google_ads.create_campaign"](cgoRow(dgBody()));
    expect(r.ok).toBe(false);
    expect(mocks.createCampaignMock).not.toHaveBeenCalled();
  });

  it("a non-USD account is refused before any hold, budget or not", async () => {
    mocks.guardFactsMock.mockResolvedValue({ currency_code: "EUR", budget_period: "DAILY" });
    const r = await HANDLERS["google_ads.create_campaign"](cgoRow(dgBody()));
    expect(r).toMatchObject({ ok: false, code: "google_ads_non_usd_account" });
    expect(fake.namesCalled()).toEqual([]);
    expect(mocks.createCampaignMock).not.toHaveBeenCalled();
    fake = makeAdBudgetFake(null);
    const human = await HANDLERS["google_ads.create_campaign"](row("google_ads.create_campaign", { name: "S", channel_type: "SEARCH", daily_budget_usd: 5, bidding: { strategy: "MANUAL_CPC" }, rationale: "" }, "user-1"));
    expect(human).toMatchObject({ ok: false, code: "google_ads_non_usd_account" });
  });

  it("an unreadable account currency refuses (fail closed)", async () => {
    mocks.guardFactsMock.mockRejectedValue(new Error("google down"));
    const r = await HANDLERS["google_ads.create_campaign"](cgoRow(dgBody()));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/google_ads_currency_unverified/);
    expect(mocks.createCampaignMock).not.toHaveBeenCalled();
  });

  it("the success notice says one enable of the campaign starts it (Demand Gen only)", async () => {
    const r = await HANDLERS["google_ads.create_campaign"](cgoRow(dgBody()));
    expect(r.notice).toMatch(/one approved enable of the campaign makes it eligible to serve/);
    expect(r.notice).not.toMatch(/its ad group and its ad/);
    fake = makeAdBudgetFake(null);
    const search = await HANDLERS["google_ads.create_campaign"](row("google_ads.create_campaign", { name: "S", channel_type: "SEARCH", daily_budget_usd: 5, bidding: { strategy: "MANUAL_CPC" }, ad_group: { name: "g", type: "SEARCH_STANDARD" }, rationale: "" }, "user-1"));
    expect(search.notice).toMatch(/Approve a separate ENABLED change to start spend/);
  });

  it("a Demand Gen body without its group is refused as invalid before any read", async () => {
    const { demand_gen_ad_group: _g, ...bare } = dgBody();
    const r = await HANDLERS["google_ads.create_campaign"](cgoRow(bare));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/needs its demand_gen_ad_group/);
    expect(mocks.capReaderMock).not.toHaveBeenCalled();
  });
});

describe("create_ad_group: a USD bid needs a USD account", () => {
  it("refuses a bid on a non-USD account; a bid-less ad group does not read the currency", async () => {
    mocks.guardFactsMock.mockResolvedValue({ currency_code: "GBP", budget_period: "DAILY" });
    const withBid = await HANDLERS["google_ads.create_ad_group"](row("google_ads.create_ad_group", { campaign_id: "111", name: "New", type: "SEARCH_STANDARD", cpc_bid_usd: 2, rationale: "" }));
    expect(withBid).toMatchObject({ ok: false, code: "google_ads_non_usd_account" });
    expect(mocks.createAdGroupMock).not.toHaveBeenCalled();
    mocks.guardFactsMock.mockClear();
    const noBid = await HANDLERS["google_ads.create_ad_group"](row("google_ads.create_ad_group", { campaign_id: "111", name: "New", type: "SEARCH_STANDARD", rationale: "" }));
    expect(noBid.ok).toBe(true);
    expect(mocks.guardFactsMock).not.toHaveBeenCalled();
  });
});

describe("structural handlers resolve live resources then execute", () => {
  it("update_campaign passes the live campaign to the executor", async () => {
    const r = await HANDLERS["google_ads.update_campaign"](row("google_ads.update_campaign", { campaign_id: "111", new_name: "Renamed", rationale: "" }));
    expect(r.ok).toBe(true);
    expect(mocks.updateCampaignMock.mock.calls[0][1]).toMatchObject({ campaign_id: "111", bidding_strategy_type: "MAXIMIZE_CONVERSIONS" });
  });

  it("create_ad_group resolves the campaign first", async () => {
    const r = await HANDLERS["google_ads.create_ad_group"](row("google_ads.create_ad_group", { campaign_id: "111", name: "New", type: "SEARCH_STANDARD", rationale: "" }));
    expect(r.ok).toBe(true);
    expect(mocks.getCampaignMock).toHaveBeenCalledWith("tenant-1", "111");
    expect(mocks.createAdGroupMock).toHaveBeenCalledTimes(1);
    expect((r as { created?: unknown }).created).toEqual({ platform: "google", object_type: "ad_group", id: "777", status: "PAUSED" });
  });

  it("create_ad resolves the ad group first", async () => {
    const r = await HANDLERS["google_ads.create_ad"](
      row("google_ads.create_ad", {
        ad_group_id: "333",
        ad: { kind: "responsive_search", final_urls: ["https://x.com"], headlines: ["a", "b", "c"], descriptions: ["d", "e"] },
        rationale: "",
      }),
    );
    expect(r.ok).toBe(true);
    expect(mocks.getAdGroupMock).toHaveBeenCalledWith("tenant-1", "333");
    expect(mocks.createAdMock).toHaveBeenCalledTimes(1);
    expect((r as { created?: unknown }).created).toEqual({ platform: "google", object_type: "ad", id: "888", status: "PAUSED" });
  });

  it("add_keywords and remove_resource delegate to their executors", async () => {
    const k = await HANDLERS["google_ads.add_keywords"](
      row("google_ads.add_keywords", { level: "ad_group", ad_group_id: "333", negative: true, keywords: [{ text: "free", match_type: "PHRASE" }], rationale: "" }),
    );
    expect(k.ok).toBe(true);
    expect(k.notice).toContain("negative");
    const rm = await HANDLERS["google_ads.remove_resource"](row("google_ads.remove_resource", { level: "campaign", campaign_id: "111", rationale: "" }));
    expect(rm.ok).toBe(true);
    expect(mocks.removeMock).toHaveBeenCalledTimes(1);
  });

  it("executor failure surfaces as a rejected dispatch, never a false acted", async () => {
    mocks.removeMock.mockRejectedValue(new Error("Google Ads googleAds:mutate failed: 400"));
    const rm = await HANDLERS["google_ads.remove_resource"](row("google_ads.remove_resource", { level: "campaign", campaign_id: "111", rationale: "" }));
    expect(rm.ok).toBe(false);
    expect(String(rm.error)).toContain("mutate failed");
  });
});

describe("writes into a VIDEO campaign are refused before the executor", () => {
  const REFUSAL = { ok: false, code: "google_ads_video_mutate_unsupported" };
  const videoAdGroup = { ad_group_resource: "x", ad_group_id: "333", name: "", status: "", type: "VIDEO_BUMPER", campaign_id: "999", campaign_resource: "y" };

  it("create_ad, update_ad_group and add_keywords into a VIDEO_* ad group", async () => {
    mocks.getAdGroupMock.mockResolvedValue(videoAdGroup);
    const rsa = { kind: "responsive_search", final_urls: ["https://example.com"], headlines: ["a", "b", "c"], descriptions: ["d", "e"] };
    const ad = await HANDLERS["google_ads.create_ad"](row("google_ads.create_ad", { ad_group_id: "333", ad: rsa, rationale: "" }));
    expect(ad).toMatchObject(REFUSAL);
    const old = await HANDLERS["google_ads.create_ad"](row("google_ads.create_ad", { ad_group_id: "333", ad: { kind: "video_bumper", youtube_video_id: "dQw4w9WgXcQ" }, rationale: "" }));
    expect(old).toMatchObject({ ok: false, error: expect.stringContaining("body invalid") });
    expect(mocks.createAdMock).not.toHaveBeenCalled();
    const kw = await HANDLERS["google_ads.add_keywords"](row("google_ads.add_keywords", { level: "ad_group", ad_group_id: "333", negative: true, keywords: [{ text: "free", match_type: "PHRASE" }], rationale: "" }));
    expect(kw).toMatchObject(REFUSAL);
    expect(mocks.addKeywordsMock).not.toHaveBeenCalled();
  });

  it("campaign-level negatives and a campaign removal on a VIDEO campaign", async () => {
    mocks.getBudgetMock.mockResolvedValue({ campaign_resource: "c", campaign_status: "ENABLED", channel_type: "VIDEO", budget_resource: "b", amount_micros: 1 });
    const kw = await HANDLERS["google_ads.add_keywords"](row("google_ads.add_keywords", { level: "campaign", campaign_id: "111", negative: true, keywords: [{ text: "free", match_type: "PHRASE" }], rationale: "" }));
    expect(kw).toMatchObject(REFUSAL);
    const rm = await HANDLERS["google_ads.remove_resource"](row("google_ads.remove_resource", { level: "campaign", campaign_id: "111", rationale: "" }));
    expect(rm).toMatchObject(REFUSAL);
    expect(mocks.removeMock).not.toHaveBeenCalled();
  });
});

describe("ad budget: bid, target, ad group, ad and keyword writes are not held (an ad group ENABLE is: see google-ads.test)", () => {
  it("while a budget is active, none of them reserves", async () => {
    fake = makeAdBudgetFake({ cap: 1000 });
    const writes: Array<[string, Record<string, unknown>]> = [
      ["google_ads.update_campaign", { campaign_id: "111", target_cpa_usd: 30, rationale: "" }],
      ["google_ads.create_ad_group", { campaign_id: "111", name: "New", type: "SEARCH_STANDARD", rationale: "" }],
      [
        "google_ads.create_ad",
        {
          ad_group_id: "333",
          ad: { kind: "responsive_search", final_urls: ["https://x.com"], headlines: ["a", "b", "c"], descriptions: ["d", "e"] },
          rationale: "",
        },
      ],
      ["google_ads.add_keywords", { level: "ad_group", ad_group_id: "333", negative: false, keywords: [{ text: "suv", match_type: "PHRASE" }], rationale: "" }],
    ];
    for (const [cls, body] of writes) {
      const r = await HANDLERS[cls](row(cls, body));
      expect(r.ok, cls).toBe(true);
    }
    expect(fake.namesCalled()).not.toContain("reserve_ad_spend");
    expect(fake.budget!.held).toBe(0);
  });

  it("T13: create_campaign with no budget keeps its name and gets no end date", async () => {
    const body = { name: "Brand", channel_type: "SEARCH", daily_budget_usd: 20, bidding: { strategy: "MANUAL_CPC" }, rationale: "" };
    const r = await HANDLERS["google_ads.create_campaign"](row("google_ads.create_campaign", body, "user-1"));
    expect(r.ok).toBe(true);
    expect(mocks.createCampaignMock.mock.calls[0][1].name).toBe("Brand");
    expect(mocks.createCampaignMock.mock.calls[0]).toHaveLength(2);
    expect(mocks.guardFactsMock).toHaveBeenCalledTimes(1);
    expect(mocks.guardFactsMock).toHaveBeenCalledWith("tenant-1", null);
    expect(fake.namesCalled()).toEqual(["reserve_ad_spend"]);
  });
});

describe("never-auto mirror covers the irreversible Google classes", () => {
  it.each([
    "google_ads.create_campaign",
    "google_ads.remove_resource",
    "google_ads.set_status_review",
    "google_ads.update_campaign_budget_review",
  ])("%s", (cls) => {
    expect(NEVER_AUTO_DECISION_CLASSES.has(cls)).toBe(true);
  });
});

describe("USD guard on every Google money write", () => {
  type Case = { name: string; cls: string; body: Record<string, unknown>; write: () => ReturnType<typeof vi.fn> };
  const cases: Case[] = [
    { name: "budget change", cls: "google_ads.update_campaign_budget", body: { campaign_id: "111", daily_budget_usd: 55, expected_current_daily_budget_usd: 50, rationale: "", over_cap: false }, write: () => mocks.updateBudgetMock },
    { name: "budget change (review)", cls: "google_ads.update_campaign_budget_review", body: { campaign_id: "111", daily_budget_usd: 45, expected_current_daily_budget_usd: 50, rationale: "", over_cap: true }, write: () => mocks.updateBudgetMock },
    { name: "campaign enable", cls: "google_ads.set_status_review", body: { campaign_id: "111", level: "campaign", status: "ENABLED", rationale: "", over_cap: true }, write: () => mocks.setCampaignStatusMock },
    { name: "ad group enable", cls: "google_ads.set_status_review", body: { campaign_id: "111", level: "ad_group", ad_group_id: "333", status: "ENABLED", rationale: "", over_cap: true }, write: () => mocks.setAdGroupStatusMock },
    { name: "target CPA", cls: "google_ads.update_campaign", body: { campaign_id: "111", target_cpa_usd: 12, rationale: "" }, write: () => mocks.updateCampaignMock },
    { name: "ad group bid", cls: "google_ads.update_ad_group", body: { ad_group_id: "333", cpc_bid_usd: 1.5, rationale: "" }, write: () => mocks.updateAdGroupMock },
    { name: "new ad group with a bid", cls: "google_ads.create_ad_group", body: { campaign_id: "111", name: "New", type: "SEARCH_STANDARD", cpc_bid_usd: 2, rationale: "" }, write: () => mocks.createAdGroupMock },
  ];
  const campaignPaused = () =>
    mocks.getBudgetMock.mockResolvedValue({
      campaign_resource: "customers/9/campaigns/111",
      campaign_status: "PAUSED",
      budget_resource: "customers/9/campaignBudgets/222",
      amount_micros: 50_000_000,
      channel_type: "SEARCH",
    });
  const googleReads = () => [mocks.getBudgetMock, mocks.getCampaignMock, mocks.getAdGroupMock, mocks.getAdMock];

  beforeEach(() => {
    fake = makeAdBudgetFake({ cap: 1000, days: 10, margin: 1.25 });
    campaignPaused();
  });

  it.each(cases)("$name: a USD account goes through", async (c) => {
    const r = await HANDLERS[c.cls](row(c.cls, c.body, "user-1"));
    expect(r.ok).toBe(true);
    expect(c.write()).toHaveBeenCalledTimes(1);
    expect(mocks.guardFactsMock).toHaveBeenCalledWith("tenant-1", null);
  });

  it.each(cases)("$name: a EUR account is refused before any hold or Google call", async (c) => {
    mocks.guardFactsMock.mockResolvedValue({ currency_code: "EUR", budget_period: "DAILY" });
    const r = await HANDLERS[c.cls](row(c.cls, c.body, "user-1"));
    expect(r).toMatchObject({ ok: false, code: "google_ads_non_usd_account" });
    expect(String(r.error)).toMatch(/bills in EUR/);
    expect(c.write()).not.toHaveBeenCalled();
    expect(fake.namesCalled()).toEqual([]);
    for (const read of googleReads()) expect(read).not.toHaveBeenCalled();
  });

  it.each(cases)("$name: a currency Google does not report is refused", async (c) => {
    mocks.guardFactsMock.mockResolvedValue({ currency_code: null, budget_period: null });
    const r = await HANDLERS[c.cls](row(c.cls, c.body, "user-1"));
    expect(r).toMatchObject({ ok: false, code: "google_ads_non_usd_account" });
    expect(c.write()).not.toHaveBeenCalled();
    expect(fake.namesCalled()).toEqual([]);
  });

  it.each(cases)("$name: an unreadable currency is refused (fail closed)", async (c) => {
    mocks.guardFactsMock.mockRejectedValue(new Error("google down"));
    const r = await HANDLERS[c.cls](row(c.cls, c.body, "user-1"));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/google_ads_currency_unverified/);
    expect(c.write()).not.toHaveBeenCalled();
    expect(fake.namesCalled()).toEqual([]);
    for (const read of googleReads()) expect(read).not.toHaveBeenCalled();
  });

  it("an unreadable currency keeps the read's own code (a disconnected account reads as reconnect)", async () => {
    mocks.guardFactsMock.mockRejectedValue(new ExpectedToolError("google_ads_not_connected", "not connected"));
    const r = await HANDLERS["google_ads.update_campaign_budget"](row("google_ads.update_campaign_budget", cases[0].body, "user-1"));
    expect(r).toMatchObject({ ok: false, code: "google_ads_not_connected" });
  });

  it("writes that send no amount never read the currency: a pause, a ROAS target, a rename", async () => {
    mocks.guardFactsMock.mockResolvedValue({ currency_code: "EUR", budget_period: "DAILY" });
    const pause = await HANDLERS["google_ads.set_status_review"](row("google_ads.set_status_review", { campaign_id: "111", level: "campaign", status: "PAUSED", rationale: "", over_cap: true }, "user-1"));
    expect(pause.ok).toBe(true);
    const roas = await HANDLERS["google_ads.update_campaign"](row("google_ads.update_campaign", { campaign_id: "111", target_roas: 3, rationale: "" }, "user-1"));
    expect(roas.ok).toBe(true);
    const rename = await HANDLERS["google_ads.update_ad_group"](row("google_ads.update_ad_group", { ad_group_id: "333", new_name: "Renamed", rationale: "" }, "user-1"));
    expect(rename.ok).toBe(true);
    expect(mocks.guardFactsMock).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  vi.spyOn(overProjectionGate, "read").mockResolvedValue(null);
});
