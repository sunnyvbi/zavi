
import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));
const geoCheck = vi.hoisted(() => ({ refused: null as string | null }));
vi.mock("@/services/tools/meta-ads/write/_flag-check", () => ({ isMetaAdsWriteEnabled: async () => true }));
vi.mock("@/services/tools/meta-ads/write/propose_locations", () => ({ recheckLocationChange: async () => geoCheck.refused }));
import { overProjectionGate } from "@/services/decisions/ad-budget";

const mocks = vi.hoisted(() => ({
  fbGetMock: vi.fn(),
  readOwnCampaignMock: vi.fn(),
  getCurrencyMock: vi.fn(),
  metaUpdateBudgetMock: vi.fn(),
  toMinorMock: vi.fn(),
  assertNoDriftMock: vi.fn(),
  capReaderMock: vi.fn(),
  auditInsertMock: vi.fn(),
  serviceClientMock: vi.fn(),
  enumerateMock: vi.fn(),
  classifyMock: vi.fn(),
  metaSetStatusMock: vi.fn(),
  metaCreateAdSetMock: vi.fn(),
  metaUpdateCampaignBudgetMock: vi.fn(),
  metaCreateCampaignMock: vi.fn(),
  metaUpdateCampaignMock: vi.fn(),
  metaDeleteCampaignMock: vi.fn(),
  metaUpdateAdSetMock: vi.fn(),
  metaUpdateAdMock: vi.fn(),
  metaDuplicateAdMock: vi.fn(),
  metaCreateCreativeMock: vi.fn(),
  metaUploadAssetMock: vi.fn(),
}));

import { makeAdBudgetFake } from "./_ad-budget-fake";
import { ExpectedToolError } from "@/services/tools/types";
let fake = makeAdBudgetFake(null);
let stopBudgetAfterReads: number | undefined;
let autopilotOn = true;
vi.mock("@/services/settings", () => ({
  getBoolSettingStrictResolved: async (k: string) => (k === "cgo_autopilot_enabled" ? autopilotOn : false),
}));

vi.mock("../../client", () => ({ inngest: { createFunction: () => ({}) } }));

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
vi.mock("@/services/auth/tenant-role", () => ({ loadTenantRoleFor: vi.fn(async () => "owner") }));
vi.mock("../dispatch-notice", () => ({
  buildDispatchNotice: vi.fn(),
  buildOpenPrNotice: vi.fn(),
  extractChatThreadId: vi.fn(),
  HANDLER_LABELS: {},
}));

vi.mock("@/services/tools/meta-ads/write/update_ad_set_budget", () => ({ metaUpdateAdSetBudget: mocks.metaUpdateBudgetMock }));
vi.mock("@/services/tools/meta-ads/write/creative_writes", () => ({
  metaCreateCreative: mocks.metaCreateCreativeMock,
  metaUpdateCreative: vi.fn(),
  metaUploadAsset: mocks.metaUploadAssetMock,
}));
vi.mock("@/services/tools/meta-ads/write/adset_ad_writes", () => ({
  metaUpdateAdSet: mocks.metaUpdateAdSetMock,
  metaUpdateAd: mocks.metaUpdateAdMock,
  metaDuplicateAd: mocks.metaDuplicateAdMock,
}));
vi.mock("@/services/tools/meta-ads/write/campaign_writes", () => ({
  metaCreateCampaign: mocks.metaCreateCampaignMock,
  metaUpdateCampaign: mocks.metaUpdateCampaignMock,
  metaDeleteCampaign: mocks.metaDeleteCampaignMock,
  readOwnCampaign: (tenant_id: string, campaign_id: string) => mocks.readOwnCampaignMock(tenant_id, campaign_id),
}));
vi.mock("@/services/tools/meta-ads/write/update_campaign_budget", () => ({ metaUpdateCampaignBudget: mocks.metaUpdateCampaignBudgetMock }));
vi.mock("@/services/tools/meta-ads/write/set_status", () => ({ metaSetStatus: mocks.metaSetStatusMock }));
vi.mock("@/services/tools/meta-ads/write/create_ad_set", () => ({ metaCreateAdSet: mocks.metaCreateAdSetMock }));
vi.mock("@/services/tools/meta-ads/_client", () => ({ fbGet: mocks.fbGetMock, fbPost: async () => ({ success: true }), getAdAccountCurrency: mocks.getCurrencyMock }));
vi.mock("@/services/tools/meta-ads/list_ad_sets", () => ({
  enumerateCampaignAdSets: mocks.enumerateMock,
  classifyCampaignBudgeting: mocks.classifyMock,
}));
vi.mock("@/services/tools/meta-ads/write/_helpers", async (orig) => ({
  ...(await orig<typeof import("@/services/tools/meta-ads/write/_helpers")>()),
  toBudgetMinorUnits: mocks.toMinorMock,
}));
vi.mock("@/services/tools/meta-ads/write/_drift-guard", () => ({ assertNoBudgetDrift: mocks.assertNoDriftMock }));
vi.mock("@/services/tools/meta-ads/write/cap-reader", () => ({ readTenantCapAndToday: mocks.capReaderMock }));
vi.mock("@/services/supabase", () => ({ serviceClient: mocks.serviceClientMock }));
vi.mock("@/services/growth/unattended-policy", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/unattended-policy")>()),
  authorizeUnattended: vi.fn(async () => ({ verdict: "allow", reasons: [] })),
  askFounderAboutHeld: vi.fn(async () => true),
}));

import { __testOnly_handlers as HANDLERS } from "../dispatch-decision";
import { askFounderAboutHeld, authorizeUnattended } from "@/services/growth/unattended-policy";
import { _memoryCooldownStore, _setMetaCooldownStoreForTest, gateMetaCall, metaCaller, metaSafetyActive, startMetaCooldown } from "@/services/tools/meta-ads/_cooldown";

const REAL_RUN_UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const AUTH_CAP = { enabled: true, max_daily_budget_usd: 10_000, max_pct_change_per_run: 50 };

function userChatRow(body: Record<string, unknown>) {
  return {
    id: "dec-1",
    tenant_id: "tenant-1",
    agent_run_id: REAL_RUN_UUID,
    decision_class: "meta_ads.update_ad_set_budget",
    status: "approved",
    handler: null,
    body,
  };
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => (m as ReturnType<typeof vi.fn>).mockReset());
  mocks.getCurrencyMock.mockResolvedValue("USD");
  mocks.fbGetMock.mockResolvedValue({ daily_budget: "4000" });
  mocks.toMinorMock.mockReturnValue(4000);
  mocks.assertNoDriftMock.mockReturnValue(undefined);
  mocks.metaUpdateBudgetMock.mockResolvedValue(undefined);
  mocks.auditInsertMock.mockResolvedValue({ error: null });
  mocks.enumerateMock.mockResolvedValue([{ id: "as1", daily_budget: "4000" }]);
  mocks.classifyMock.mockReturnValue({ kind: "single", adSet: { id: "as1", daily_budget: "4000" } });
  fake = makeAdBudgetFake(null);
  stopBudgetAfterReads = undefined;
  autopilotOn = true;
  mocks.serviceClientMock.mockReturnValue({
    from: (t: string) =>
      t === "ad_budgets"
        ? (() => { throw new Error("the budget is read through ad_budget_month_view"); })()
        : {
            insert: mocks.auditInsertMock,
            update: () => { const c = { eq: () => c, select: async () => ({ data: [{ id: "row" }], error: null }) }; return c; },
          },
    rpc: (n: string, a: Record<string, unknown>) => (fake.stopAfterViewReads(stopBudgetAfterReads), fake.rpc(n, a)),
  });
  mocks.metaSetStatusMock.mockResolvedValue(undefined);
  mocks.metaCreateAdSetMock.mockResolvedValue({ id: "new-as", status: "PAUSED" });
});

describe("meta_ads.update_ad_set_budget — user-initiated effective cap", () => {
  it("normal double on a NO-CAP tenant APPLIES (vs today's no_cap_configured refuse) + writes audit stage", async () => {
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      userChatRow({
        ad_set_id: "as1",
        daily_budget_usd: 80,
        expected_current_daily_budget_usd: 40,
        rationale: "user typed: double it",
        over_cap: true,
        origin: "user_initiated_chat",
        authorized_effective_cap: AUTH_CAP,
      }),
    );
    expect(r.ok).toBe(true);
    expect(mocks.metaUpdateBudgetMock).toHaveBeenCalledTimes(1);
    expect(mocks.assertNoDriftMock).toHaveBeenCalledTimes(1);
    expect(mocks.auditInsertMock).toHaveBeenCalledTimes(1);
    expect(mocks.auditInsertMock.mock.calls[0][0]).toMatchObject({
      stage: "user_chat_spend_auto_applied",
      agent_run_id: REAL_RUN_UUID,
      tenant_id: "tenant-1",
      meta: {},
    });
  });

  it("LEDGER-origin edit on a NO-CAP tenant APPLIES (vs no_cap_configured refuse) WITHOUT writing the chat audit stage", async () => {
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      userChatRow({
        ad_set_id: "as1",
        daily_budget_usd: 24,
        expected_current_daily_budget_usd: 48,
        rationale: "operator lowered budget from the Ads Manager",
        over_cap: true,
        origin: "user_initiated_ledger",
        authorized_effective_cap: AUTH_CAP,
      }),
    );
    expect(r.ok).toBe(true);
    expect(mocks.metaUpdateBudgetMock).toHaveBeenCalledTimes(1);
    expect(mocks.assertNoDriftMock).toHaveBeenCalledTimes(1);
    expect(mocks.auditInsertMock).not.toHaveBeenCalled();
  });

  it("LEDGER-origin fat-finger ($50k) on a NO-CAP tenant still REFUSES (authorized bound trips)", async () => {
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
    mocks.fbGetMock.mockResolvedValue({ daily_budget: "50000" });
    mocks.toMinorMock.mockReturnValue(50000);
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      userChatRow({
        ad_set_id: "as1",
        daily_budget_usd: 50_000,
        expected_current_daily_budget_usd: 500,
        over_cap: true,
        origin: "user_initiated_ledger",
        authorized_effective_cap: AUTH_CAP,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cap_refuse/);
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
  });

  it("$50k / 100x fat-finger on a NO-CAP tenant REFUSES (authorized bound trips)", async () => {
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
    mocks.fbGetMock.mockResolvedValue({ daily_budget: "50000" });
    mocks.toMinorMock.mockReturnValue(50000);
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      userChatRow({
        ad_set_id: "as1",
        daily_budget_usd: 50_000,
        expected_current_daily_budget_usd: 500,
        rationale: "typo'd amount",
        over_cap: true,
        origin: "user_initiated_chat",
        authorized_effective_cap: AUTH_CAP,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cap_refuse/);
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
    expect(mocks.auditInsertMock).not.toHaveBeenCalled();
  });

  it("STRICTER real tenant cap ($50/day) refuses an $80 change (stricter-per-field wins)", async () => {
    mocks.capReaderMock.mockResolvedValue({
      cap: { enabled: true, max_daily_budget_usd: 50, max_pct_change_per_run: null, max_daily_total_change_usd: null },
      today_total_change_usd: 0,
      currency: "USD",
      units_per_usd: 1,
    });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      userChatRow({
        ad_set_id: "as1",
        daily_budget_usd: 80,
        expected_current_daily_budget_usd: 40,
        rationale: "double it",
        over_cap: false,
        origin: "user_initiated_chat",
        authorized_effective_cap: AUTH_CAP,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cap_refuse/);
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
  });

  it("INR account: an approved ₹2,000 → ₹3,000 raise applies, the $10k bound read as rupees", async () => {
    mocks.getCurrencyMock.mockResolvedValue("INR");
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "INR", units_per_usd: 80 });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      userChatRow({
        ad_set_id: "as1",
        daily_budget_usd: 3000,
        expected_current_daily_budget_usd: 2000,
        currency: "INR",
        rationale: "user typed: raise to 3000",
        over_cap: true,
        origin: "user_initiated_chat",
        authorized_effective_cap: AUTH_CAP,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.notice).toContain("₹3,000/day");
    expect(mocks.metaUpdateBudgetMock).toHaveBeenCalledTimes(1);
  });

  it("INR account: a $50 tenant cap (₹4,000 at 80) refuses a ₹5,000 raise", async () => {
    mocks.getCurrencyMock.mockResolvedValue("INR");
    mocks.capReaderMock.mockResolvedValue({
      cap: { enabled: true, max_daily_budget_usd: 4000, max_pct_change_per_run: null, max_daily_total_change_usd: null },
      today_total_change_usd: 0,
      currency: "INR",
      units_per_usd: 80,
    });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      userChatRow({
        ad_set_id: "as1",
        daily_budget_usd: 5000,
        expected_current_daily_budget_usd: 2000,
        currency: "INR",
        rationale: "raise",
        over_cap: false,
        origin: "user_initiated_chat",
        authorized_effective_cap: AUTH_CAP,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("cap_refuse: over_absolute_ceiling");
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
  });

  it("a body proposed in USD is refused on an account that is now INR, before any write", async () => {
    mocks.getCurrencyMock.mockResolvedValue("INR");
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "INR", units_per_usd: 80 });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      userChatRow({
        ad_set_id: "as1",
        daily_budget_usd: 80,
        expected_current_daily_budget_usd: 40,
        rationale: "double it",
        over_cap: true,
        origin: "user_initiated_chat",
        authorized_effective_cap: AUTH_CAP,
      }),
    );
    expect(r.error).toMatch(/^meta_ads_currency_mismatch/);
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
  });

  it("drift guard STILL trips regardless of the authorized cap (never bypassed)", async () => {
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
    mocks.assertNoDriftMock.mockImplementation(() => {
      throw new Error("budget_drift: live value moved since proposal");
    });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      userChatRow({
        ad_set_id: "as1",
        daily_budget_usd: 80,
        expected_current_daily_budget_usd: 40,
        rationale: "double it",
        over_cap: true,
        origin: "user_initiated_chat",
        authorized_effective_cap: AUTH_CAP,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/budget_drift/);
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
  });

  it("AGENT-initiated body (no authorized cap) on a no-cap tenant still REFUSES no_cap_configured (unchanged)", async () => {
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      userChatRow({
        ad_set_id: "as1",
        daily_budget_usd: 80,
        expected_current_daily_budget_usd: 40,
        rationale: "agent rebalance",
        over_cap: true,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no_cap_configured/);
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
    expect(mocks.auditInsertMock).not.toHaveBeenCalled();
  });

  it("user-initiated decision REFUSES when the campaign became MULTI-budget-bearing since staging (TOCTOU fail-closed)", async () => {
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
    mocks.enumerateMock.mockResolvedValue([
      { id: "as1", daily_budget: "4000" },
      { id: "as2", daily_budget: "6000" },
    ]);
    mocks.classifyMock.mockReturnValue({ kind: "ambiguous" });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      userChatRow({
        ad_set_id: "as1",
        campaign_id: "camp-1",
        daily_budget_usd: 80,
        expected_current_daily_budget_usd: 40,
        rationale: "double it",
        over_cap: true,
        origin: "user_initiated_chat",
        authorized_effective_cap: AUTH_CAP,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("target_no_longer_single_adset");
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
    expect(mocks.assertNoDriftMock).toHaveBeenCalledTimes(1);
    expect(mocks.enumerateMock).toHaveBeenCalledWith("tenant-1", "camp-1");
  });

  it("user-initiated decision REFUSES when the single ad set no longer matches the decision's ad_set_id", async () => {
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
    mocks.classifyMock.mockReturnValue({ kind: "single", adSet: { id: "as-other", daily_budget: "4000" } });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      userChatRow({
        ad_set_id: "as1",
        campaign_id: "camp-1",
        daily_budget_usd: 80,
        expected_current_daily_budget_usd: 40,
        over_cap: true,
        origin: "user_initiated_chat",
        authorized_effective_cap: AUTH_CAP,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("target_no_longer_single_adset");
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
  });

  it("CONTROL: user-initiated decision PROCEEDS when the campaign is STILL a single matching ad set at dispatch", async () => {
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
    mocks.classifyMock.mockReturnValue({ kind: "single", adSet: { id: "as1", daily_budget: "4000" } });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      userChatRow({
        ad_set_id: "as1",
        campaign_id: "camp-1",
        daily_budget_usd: 80,
        expected_current_daily_budget_usd: 40,
        over_cap: true,
        origin: "user_initiated_chat",
        authorized_effective_cap: AUTH_CAP,
      }),
    );
    expect(r.ok).toBe(true);
    expect(mocks.metaUpdateBudgetMock).toHaveBeenCalledTimes(1);
    expect(mocks.enumerateMock).toHaveBeenCalledWith("tenant-1", "camp-1");
  });

  it("AGENT decision (no campaign_id) SKIPS the TOCTOU re-check entirely — agent path unchanged", async () => {
    mocks.capReaderMock.mockResolvedValue({
      cap: { enabled: true, max_daily_budget_usd: 10_000, max_pct_change_per_run: 100, max_daily_total_change_usd: null },
      today_total_change_usd: 0,
      currency: "USD",
      units_per_usd: 1,
    });
    mocks.classifyMock.mockReturnValue({ kind: "ambiguous" });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      userChatRow({
        ad_set_id: "as1",
        daily_budget_usd: 80,
        expected_current_daily_budget_usd: 40,
        over_cap: false,
      }),
    );
    expect(r.ok).toBe(true);
    expect(mocks.metaUpdateBudgetMock).toHaveBeenCalledTimes(1);
    expect(mocks.enumerateMock).not.toHaveBeenCalled();
  });
});

describe("T6: a CGO-approved ads decision is capped, never the approval bypass", () => {
  const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
  const raise = {
    ad_set_id: "as1",
    daily_budget_usd: 80,
    expected_current_daily_budget_usd: 40,
    rationale: "cgo: scale the winner",
    over_cap: false,
  };
  const tightCap = {
    cap: { enabled: true, max_daily_budget_usd: 50, max_pct_change_per_run: null, max_daily_total_change_usd: null },
    today_total_change_usd: 0,
    currency: "USD",
    units_per_usd: 1,
  };

  it("a cgo approval of an $80 raise over a $50/day cap is REFUSED and nothing is sent", async () => {
    fake = makeAdBudgetFake({ cap: 5000, days: 10 });
    mocks.capReaderMock.mockResolvedValue(tightCap);
    const r = await HANDLERS["meta_ads.update_ad_set_budget"]({
      ...userChatRow(raise),
      approved_by: OWNER,
      approved_by_source: "cgo",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cap_refuse/);
    expect(mocks.capReaderMock).toHaveBeenCalledTimes(1);
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
  });

  it("a cgo approval on a tenant with NO cap row and NO ad budget fails closed", async () => {
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1, cap_row_absent: true });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"]({
      ...userChatRow(raise),
      approved_by: OWNER,
      approved_by_source: "cgo",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^cgo_not_authorized/);
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
  });

  it("a queued cgo approval whose Autopilot was switched off since is refused before Meta", async () => {
    fake = makeAdBudgetFake({ cap: 5000, days: 10 });
    autopilotOn = false;
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1, cap_row_absent: true });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"]({ ...userChatRow(raise), approved_by: OWNER, approved_by_source: "cgo" });
    expect(r.error).toMatch(/^cgo_not_authorized/);
    expect(fake.namesCalled()).toEqual([]);
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
  });

  it("a cap read that FAILED is not 'no cap': with a budget on, the cgo change still refuses", async () => {
    fake = makeAdBudgetFake({ cap: 5000, days: 10 });
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1, cap_row_absent: false });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"]({ ...userChatRow(raise), approved_by: OWNER, approved_by_source: "cgo" });
    expect(r.error).toMatch(/no_cap_configured/);
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
  });

  it("a cgo approval on a tenant with an ACTIVE budget and no cap row proceeds, and is held against the budget", async () => {
    fake = makeAdBudgetFake({ cap: 1000, days: 10 });
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1, cap_row_absent: true });
    mocks.fbGetMock.mockImplementation(async (_t: string, _p: string, q: { fields: string }) =>
      q.fields === "campaign_id,lifetime_budget"
        ? { campaign_id: "camp-1", lifetime_budget: "0" }
        : q.fields === "daily_budget,lifetime_budget"
          ? { daily_budget: null, lifetime_budget: null }
          : { daily_budget: "4000" },
    );
    const r = await HANDLERS["meta_ads.update_ad_set_budget"]({
      ...userChatRow(raise),
      approved_by: OWNER,
      approved_by_source: "cgo",
    });
    expect(r.ok).toBe(true);
    expect(mocks.metaUpdateBudgetMock).toHaveBeenCalledTimes(1);
    expect(fake.res.get("dec-1:raise")).toMatchObject({ status: "committed", amount: 500 });
  });

  describe("D3: a raise that tips the month over the cap", () => {
    const tipping = { projection: { projected_usd: 26_800, month_cap_usd: 27_000, days_left: 10, over: false } };
    const budgetOk = () => {
      vi.mocked(askFounderAboutHeld).mockClear();
      fake = makeAdBudgetFake({ cap: 1000, days: 10 });
      mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1, cap_row_absent: true });
      mocks.fbGetMock.mockImplementation(async (_t: string, _p: string, q: { fields: string }) =>
        q.fields === "campaign_id,lifetime_budget"
          ? { campaign_id: "camp-1", lifetime_budget: "0" }
          : q.fields === "daily_budget,lifetime_budget"
            ? { daily_budget: null, lifetime_budget: null }
            : { daily_budget: "4000" },
      );
    };

    it("Autopilot's raise is not applied: one founder card (held_for_founder) with the warning, asked once, hold given back", async () => {
      budgetOk();
      vi.spyOn(overProjectionGate, "read").mockResolvedValue(tipping);
      const r = await HANDLERS["meta_ads.update_ad_set_budget"]({ ...userChatRow(raise), approved_by: OWNER, approved_by_source: "cgo" });
      expect(r).toMatchObject({ ok: false, held_for_founder: true, code: "over_projection_with_change" });
      expect(r.error).toMatch(/^This puts you on track for \$27,200 this month, \$200 over your \$27,000 cap/);
      expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
      expect(fake.res.get("dec-1:raise")?.status).toBe("released");
      expect(askFounderAboutHeld).toHaveBeenCalledTimes(1);
      expect(vi.mocked(askFounderAboutHeld).mock.calls[0]![2]).toMatchObject({ reasons: ["over_projection_with_change"] });
    });

    it("a raise that keeps the month under the cap is applied", async () => {
      budgetOk();
      vi.spyOn(overProjectionGate, "read").mockResolvedValue({ projection: { ...tipping.projection, projected_usd: 26_000 } });
      const r = await HANDLERS["meta_ads.update_ad_set_budget"]({ ...userChatRow(raise), approved_by: OWNER, approved_by_source: "cgo" });
      expect(r.ok).toBe(true);
      expect(mocks.metaUpdateBudgetMock).toHaveBeenCalledTimes(1);
      expect(askFounderAboutHeld).not.toHaveBeenCalled();
    });

    it("the founder's own approval of the same tip-over raise is applied (the card warned them)", async () => {
      budgetOk();
      vi.spyOn(overProjectionGate, "read").mockResolvedValue(tipping);
      mocks.capReaderMock.mockResolvedValue({ cap: { enabled: true, max_daily_budget_usd: 10_000, max_pct_change_per_run: null, max_daily_total_change_usd: null }, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
      const r = await HANDLERS["meta_ads.update_ad_set_budget"]({ ...userChatRow(raise), approved_by: OWNER });
      expect(r.error).toBeUndefined();
      expect(r.ok).toBe(true);
      expect(mocks.metaUpdateBudgetMock).toHaveBeenCalledTimes(1);
      expect(askFounderAboutHeld).not.toHaveBeenCalled();
    });
  });

  it("the same cgo approval over what the budget has left is refused, and nothing is sent", async () => {
    fake = makeAdBudgetFake({ cap: 400, days: 10 });
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1, cap_row_absent: true });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"]({
      ...userChatRow(raise),
      approved_by: OWNER,
      approved_by_source: "cgo",
    });
    expect(r.error).toBe("cap_refuse: ad_budget_over_month");
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
  });

  it("with a budget AND a caps row, both apply: the tight cap still refuses", async () => {
    fake = makeAdBudgetFake({ cap: 5000, days: 10 });
    mocks.capReaderMock.mockResolvedValue(tightCap);
    const r = await HANDLERS["meta_ads.update_ad_set_budget"]({
      ...userChatRow(raise),
      approved_by: OWNER,
      approved_by_source: "cgo",
    });
    expect(r.error).toMatch(/cap_refuse/);
    expect(fake.namesCalled()).toEqual([]);
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
  });

  it("a budget stopped between the checks and the reserve refuses: no caps row", async () => {
    fake = makeAdBudgetFake({ cap: 5000, days: 10 });
    stopBudgetAfterReads = 2;
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1, cap_row_absent: true });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"]({
      ...userChatRow(raise),
      approved_by: OWNER,
      approved_by_source: "cgo",
    });
    expect(r.error).toMatch(/^cap_refuse: ad_budget_not_active/);
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
  });

  it("a budget stopped between the checks and the reserve refuses even when a caps row allows the change", async () => {
    fake = makeAdBudgetFake({ cap: 5000, days: 10 });
    stopBudgetAfterReads = 1;
    mocks.capReaderMock.mockResolvedValue({
      cap: { enabled: true, max_daily_budget_usd: 100_000, max_pct_change_per_run: 1000, max_daily_total_change_usd: null },
      today_total_change_usd: 0,
      currency: "USD",
      units_per_usd: 1,
      cap_row_absent: false,
    });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"]({ ...userChatRow(raise), approved_by: OWNER, approved_by_source: "cgo" });
    expect(r.error).toMatch(/^cap_refuse: ad_budget_not_active/);
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
  });

  it("a cgo-approved create and resume under a budget with no cap row are held too", async () => {
    fake = makeAdBudgetFake({ cap: 5000, days: 10 });
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1, cap_row_absent: true });
    mocks.fbGetMock.mockImplementation(async (_t: string, _p: string, q: { fields: string }) =>
      q.fields === "campaign_id,lifetime_budget"
        ? { campaign_id: "camp-1", lifetime_budget: "0" }
        : q.fields === "daily_budget,lifetime_budget"
          ? { daily_budget: null, lifetime_budget: null }
          : { daily_budget: "6000" },
    );
    const cgo = { approved_by: OWNER, approved_by_source: "cgo" };
    const create = await HANDLERS["meta_ads.create_ad_set"]({
      id: "c-cgo",
      tenant_id: "tenant-1",
      agent_run_id: REAL_RUN_UUID,
      decision_class: "meta_ads.create_ad_set",
      status: "approved",
      handler: null,
      body: {
        campaign_id: "camp-1",
        name: "Test",
        daily_budget_usd: 40,
        optimization_goal: "LINK_CLICKS",
        billing_event: "IMPRESSIONS",
        targeting: { geo_locations: { countries: ["US"] } },
        rationale: "",
      },
      ...cgo,
    });
    const resume = await HANDLERS["meta_ads.set_status"]({
      id: "s-cgo",
      tenant_id: "tenant-1",
      agent_run_id: REAL_RUN_UUID,
      decision_class: "meta_ads.set_status",
      status: "approved",
      handler: null,
      body: { object_id: "as-old", level: "adset", status: "ACTIVE", over_cap: false },
      ...cgo,
    });
    expect(create.ok).toBe(true);
    expect(resume.ok).toBe(true);
    expect(fake.res.get("c-cgo:create")!.status).toBe("committed");
    expect(fake.res.get("s-cgo:resume")!.status).toBe("committed");
  });

  it("CONTROL: the SAME row approved by the founder (source null) skips the cap and applies, as today", async () => {
    mocks.capReaderMock.mockResolvedValue(tightCap);
    const r = await HANDLERS["meta_ads.update_ad_set_budget"]({
      ...userChatRow(raise),
      approved_by: OWNER,
      approved_by_source: null,
    });
    expect(r.ok).toBe(true);
    expect(mocks.capReaderMock).not.toHaveBeenCalled();
    expect(mocks.metaUpdateBudgetMock).toHaveBeenCalledTimes(1);
  });
});

describe("ad budget holds on Meta spend writes", () => {
  const GENEROUS = { enabled: true, max_daily_budget_usd: 100_000, max_pct_change_per_run: 1000, max_daily_total_change_usd: null };

  function metaGraph(o: { campaignDaily?: string; adSetLifetime?: string; liveDaily?: string } = {}) {
    mocks.fbGetMock.mockImplementation(async (_t: string, path: string, q: { fields: string }) => {
      if (q.fields === "campaign_id,lifetime_budget") return { campaign_id: "camp-1", lifetime_budget: o.adSetLifetime ?? "0" };
      if (q.fields === "daily_budget,lifetime_budget") return { daily_budget: o.campaignDaily ?? null, lifetime_budget: null };
      return { daily_budget: o.liveDaily ?? "4000", path };
    });
  }
  function row(id: string, decision_class: string, body: Record<string, unknown>, approved_by: string | null = null) {
    return { id, tenant_id: "tenant-1", agent_run_id: REAL_RUN_UUID, decision_class, status: "approved", handler: null, body, approved_by, approved_by_source: null };
  }
  const createBody = {
    campaign_id: "camp-1",
    name: "Spring promo",
    daily_budget_usd: 40,
    optimization_goal: "LINK_CLICKS",
    billing_event: "IMPRESSIONS",
    targeting: { geo_locations: { countries: ["US"] } },
    rationale: "",
  };

  beforeEach(() => {
    mocks.capReaderMock.mockResolvedValue({ cap: GENEROUS, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
    metaGraph();
  });

  it("T1: a create under the limit is created and held, with the name prefix and NO end date", async () => {
    fake = makeAdBudgetFake({ cap: 1000, days: 10, margin: 1.25 });
    const r = await HANDLERS["meta_ads.create_ad_set"](row("c1", "meta_ads.create_ad_set", createBody));
    expect(r.ok).toBe(true);
    expect(mocks.metaCreateAdSetMock).toHaveBeenCalledTimes(1);
    expect(mocks.metaCreateAdSetMock.mock.calls[0][1]).toMatchObject({
      name: "Zavi · Spring promo",
      status: "PAUSED",
    });
    expect(mocks.metaCreateAdSetMock.mock.calls[0][1]).not.toHaveProperty("end_time");
    expect(fake.res.get("c1:create")).toMatchObject({ status: "committed", object_id: "new-as", amount: 500 });
    expect(fake.budget!.held).toBe(500);
  });

  it("GS09: an approved card whose city has only a name is refused before any hold or Meta call; a resolved one is created with its keys", async () => {
    fake = makeAdBudgetFake({ cap: 1000, days: 10, margin: 1.25 });
    const named = { ...createBody, targeting: { geo_locations: { cities: [{ name: "Austin" }] } } };
    const r = await HANDLERS["meta_ads.create_ad_set"](row("g1", "meta_ads.create_ad_set", named));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Meta location key/);
    expect(mocks.metaCreateAdSetMock).not.toHaveBeenCalled();
    expect(fake.namesCalled()).toEqual([]);

    const resolved = { ...createBody, targeting: { geo_locations: { cities: [{ key: "2421836" }] } } };
    expect((await HANDLERS["meta_ads.create_ad_set"](row("g2", "meta_ads.create_ad_set", resolved))).ok).toBe(true);
    expect(mocks.metaCreateAdSetMock.mock.calls[0][1]).toMatchObject({ targeting: { geo_locations: { cities: [{ key: "2421836" }] } } });
  });

  it("T2: a create past the limit is refused and nothing is sent to Meta", async () => {
    fake = makeAdBudgetFake({ cap: 400, days: 10 });
    const r = await HANDLERS["meta_ads.create_ad_set"](row("c2", "meta_ads.create_ad_set", createBody, "user-1"));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("cap_refuse: ad_budget_over_month");
    expect(mocks.metaCreateAdSetMock).not.toHaveBeenCalled();
    expect(fake.budget!.held).toBe(0);
  });

  it("T4: a definite 4xx from Meta gives the hold back", async () => {
    fake = makeAdBudgetFake({ cap: 1000 });
    mocks.metaCreateAdSetMock.mockRejectedValue(
      new ExpectedToolError("meta_ads_write_failed", "Meta Ads write failed: 400 {\"error\":{}}"),
    );
    const r = await HANDLERS["meta_ads.create_ad_set"](row("c4", "meta_ads.create_ad_set", createBody));
    expect(r.ok).toBe(false);
    expect(fake.res.get("c4:create")!.status).toBe("released");
    expect(fake.budget!.held).toBe(0);
  });

  it("T5: a retry of the same decision holds once, and a retry never releases the first attempt's hold", async () => {
    fake = makeAdBudgetFake({ cap: 1000 });
    mocks.metaCreateAdSetMock.mockRejectedValueOnce(new ExpectedToolError("meta_ads_timeout", "no answer in 15s"));
    await HANDLERS["meta_ads.create_ad_set"](row("c5", "meta_ads.create_ad_set", createBody));
    mocks.metaCreateAdSetMock.mockRejectedValueOnce(
      new ExpectedToolError("meta_ads_adset_name_exists", "An ad set named ... already exists"),
    );
    await HANDLERS["meta_ads.create_ad_set"](row("c5", "meta_ads.create_ad_set", createBody));
    const reserves = fake.calls.filter((c) => c.name === "reserve_ad_spend");
    expect(reserves.map((c) => c.args.p_idem_key)).toEqual(["c5:create", "c5:create"]);
    expect(fake.res.get("c5:create")!.status).toBe("reserved");
    expect(fake.res.get("c5:create")!.ref).toEqual({ kind: "meta_adset_name", campaign_id: createBody.campaign_id, name: "Zavi · Spring promo" });
    expect(fake.budget!.held).toBe(500);
  });

  it("T7: resuming an ad set holds its remaining maximum; resuming the one it just created holds nothing more", async () => {
    fake = makeAdBudgetFake({ cap: 5000, days: 10 });
    metaGraph({ liveDaily: "6000" });
    const other = await HANDLERS["meta_ads.set_status"](
      row("s1", "meta_ads.set_status", { object_id: "as-old", level: "adset", status: "ACTIVE", over_cap: false }),
    );
    expect(other.ok).toBe(true);
    expect(fake.res.get("s1:resume")).toMatchObject({ amount: 750, status: "committed" });

    metaGraph({ liveDaily: "4000" });
    await HANDLERS["meta_ads.create_ad_set"](row("c7", "meta_ads.create_ad_set", createBody));
    const own = await HANDLERS["meta_ads.set_status"](
      row("s2", "meta_ads.set_status", { object_id: "new-as", level: "adset", status: "ACTIVE", over_cap: false }),
    );
    expect(own.ok).toBe(true);
    expect(fake.res.get("s2:resume")!.amount).toBe(0);
    expect(fake.budget!.held).toBe(1250);
  });

  it("bug #6: a resume records the daily amount it re-opens on its row, before the platform write, for today's cap total", async () => {
    fake = makeAdBudgetFake({ cap: 5000, days: 10 });
    metaGraph({ liveDaily: "6000" });
    const updates: Array<{ table: string; patch: unknown; filters: Array<[string, unknown]> }> = [];
    const base = mocks.serviceClientMock();
    mocks.serviceClientMock.mockReturnValue({
      ...base,
      from: (t: string) => {
        if (t !== "decisions") return base.from(t);
        return {
          update: (patch: unknown) => {
            const u = { table: t, patch, filters: [] as Array<[string, unknown]> };
            updates.push(u);
            const chain = {
              eq: (c: string, v: unknown) => (u.filters.push([c, v]), chain),
              select: async () => {
                expect(mocks.metaSetStatusMock).not.toHaveBeenCalled();
                return { data: [{ id: "s9" }], error: null };
              },
            };
            return chain;
          },
        };
      },
    });
    const r = await HANDLERS["meta_ads.set_status"](row("s9", "meta_ads.set_status", { object_id: "as-old", level: "adset", status: "ACTIVE", over_cap: false }));
    expect(r.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toEqual({ cap_counted: { daily: 60, currency: "USD" } });
    expect(updates[0].filters).toEqual(expect.arrayContaining([["id", "s9"], ["tenant_id", "tenant-1"], ["status", "dispatching"]]));
  });

  it("bug #6: an ad set with no budget of its own records its campaign's daily budget; an unreadable one is recorded as unknown", async () => {
    const patches: unknown[] = [];
    const base = mocks.serviceClientMock();
    mocks.serviceClientMock.mockReturnValue({
      ...base,
      from: (t: string) =>
        t !== "decisions"
          ? base.from(t)
          : { update: (patch: unknown) => { patches.push(patch); const c = { eq: () => c, select: async () => ({ data: [{ id: "r" }], error: null }) }; return c; } },
    });
    mocks.fbGetMock.mockImplementation(async (_t: string, _p: string, q: { fields: string }) =>
      q.fields === "campaign{daily_budget}" ? { campaign: { daily_budget: "7000" } } : { daily_budget: "0", status: "PAUSED" },
    );
    await HANDLERS["meta_ads.set_status"](row("cbo", "meta_ads.set_status", { object_id: "as-cbo", level: "adset", status: "ACTIVE", over_cap: false }, "user-1"));
    expect(patches[0]).toEqual({ cap_counted: { daily: 70, currency: "USD" } });
    mocks.fbGetMock.mockImplementation(async (_t: string, _p: string, q: { fields: string }) =>
      q.fields === "campaign{daily_budget}" ? Promise.reject(new Error("down")) : { daily_budget: "0", status: "PAUSED" },
    );
    await HANDLERS["meta_ads.set_status"](row("cbo2", "meta_ads.set_status", { object_id: "as-cbo", level: "adset", status: "ACTIVE", over_cap: false }, "user-1"));
    expect(patches[1]).toEqual({ cap_counted: { daily: null, unknown: true, currency: "USD" } });
  });

  it("bug #6: a switch-on whose amount could not be recorded is not sent", async () => {
    const base = mocks.serviceClientMock();
    mocks.serviceClientMock.mockReturnValue({
      ...base,
      from: (t: string) =>
        t !== "decisions" ? base.from(t) : { update: () => { const c = { eq: () => c, select: async () => ({ data: null, error: { message: "db down" } }) }; return c; } },
    });
    metaGraph({ liveDaily: "6000" });
    const r = await HANDLERS["meta_ads.set_status"](row("nr", "meta_ads.set_status", { object_id: "as-old", level: "adset", status: "ACTIVE", over_cap: false }, "user-1"));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^resume_not_recorded/);
    expect(mocks.metaSetStatusMock).not.toHaveBeenCalled();
  });

  it("T14: pausing an ad set gives back its hold for the days after today", async () => {
    fake = makeAdBudgetFake({ cap: 5000, days: 10 });
    metaGraph({ liveDaily: "6000" });
    await HANDLERS["meta_ads.set_status"](
      row("s3", "meta_ads.set_status", { object_id: "as-old", level: "adset", status: "ACTIVE", over_cap: false }),
    );
    const r = await HANDLERS["meta_ads.set_status"](
      row("s4", "meta_ads.set_status", { object_id: "as-old", level: "adset", status: "PAUSED", over_cap: false }),
    );
    expect(r.ok).toBe(true);
    expect(fake.budget!.held).toBe(75);
    expect(fake.calls.at(-1)).toMatchObject({ name: "release_ad_spend_for_object", args: { p_platform: "meta", p_object_id: "as-old" } });
  });

  it("refuses an ad set resume whose daily budget reads 0 (a lifetime budget, or a budget held elsewhere)", async () => {
    fake = makeAdBudgetFake({ cap: 5000 });
    metaGraph({ liveDaily: "0" });
    const r = await HANDLERS["meta_ads.set_status"](
      row("s5", "meta_ads.set_status", { object_id: "as-0", level: "adset", status: "ACTIVE", over_cap: false }, "user-1"),
    );
    expect(r.error).toBe("cap_refuse: ad_budget_zero_daily_budget");
    expect(mocks.metaSetStatusMock).not.toHaveBeenCalled();
  });

  it("F2: under a budget a campaign that holds the daily budget itself (CBO) is turned on and held at its budget", async () => {
    fake = makeAdBudgetFake({ cap: 5000 });
    metaGraph({ liveDaily: "10000" });
    const r = await HANDLERS["meta_ads.set_status"](
      row("s6", "meta_ads.set_status", { object_id: "camp-1", level: "campaign", status: "ACTIVE", over_cap: false }, "user-1"),
    );
    expect(r.ok).toBe(true);
    expect(mocks.metaSetStatusMock).toHaveBeenCalledTimes(1);
    expect(fake.res.get("s6:resume")).toMatchObject({ status: "committed", object_id: "camp-1" });
    expect(fake.budget!.held).toBeGreaterThan(0);
  });

  it("F2: under a budget a campaign whose budget is on its ad sets is never turned on; nothing sent, nothing held", async () => {
    fake = makeAdBudgetFake({ cap: 5000 });
    metaGraph({ liveDaily: "0" });
    const r = await HANDLERS["meta_ads.set_status"](
      row("s6b", "meta_ads.set_status", { object_id: "camp-2", level: "campaign", status: "ACTIVE", over_cap: false }, "user-1"),
    );
    expect(r.error).toBe(
      "cap_refuse: ad_budget_campaign_level_resume: turn on its ad sets instead, so each one is held and its spend is read",
    );
    expect(mocks.metaSetStatusMock).not.toHaveBeenCalled();
    expect(fake.budget!.held).toBe(0);
  });

  it("F2: with no budget, a campaign resume is unchanged", async () => {
    fake = makeAdBudgetFake(null);
    metaGraph({ liveDaily: "10000" });
    const r = await HANDLERS["meta_ads.set_status"](
      row("s7", "meta_ads.set_status", { object_id: "camp-1", level: "campaign", status: "ACTIVE", over_cap: false }, "user-1"),
    );
    expect(r.ok).toBe(true);
    expect(mocks.metaSetStatusMock).toHaveBeenCalledTimes(1);
  });

  it("T8: a raise and a create under a CBO campaign are refused with a reason, and hold nothing", async () => {
    fake = makeAdBudgetFake({ cap: 5000 });
    metaGraph({ campaignDaily: "10000" });
    const raise = await HANDLERS["meta_ads.update_ad_set_budget"](
      row("r8", "meta_ads.update_ad_set_budget", { ad_set_id: "as1", daily_budget_usd: 80, expected_current_daily_budget_usd: 40, over_cap: false }),
    );
    const create = await HANDLERS["meta_ads.create_ad_set"](row("c8", "meta_ads.create_ad_set", createBody, "user-1"));
    expect(raise.error).toBe("cap_refuse: ad_budget_cbo_campaign_in_budget");
    expect(create.error).toBe("cap_refuse: ad_budget_cbo_campaign_in_budget");
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
    expect(mocks.metaCreateAdSetMock).not.toHaveBeenCalled();
    expect(fake.budget!.held).toBe(0);
  });

  it("a create proposed in USD on an account that is now EUR is refused before any hold or Meta call", async () => {
    fake = makeAdBudgetFake({ cap: 5000 });
    mocks.getCurrencyMock.mockResolvedValue("EUR");
    const r = await HANDLERS["meta_ads.create_ad_set"](row("c-eur", "meta_ads.create_ad_set", createBody, "user-1"));
    expect(r.error).toMatch(/^meta_ads_currency_mismatch: .*USD.*EUR/);
    expect(mocks.metaCreateAdSetMock).not.toHaveBeenCalled();
    expect(fake.budget!.held).toBe(0);
  });

  it("an INR create under an active ad budget is refused (the ledger counts dollars) and holds nothing", async () => {
    fake = makeAdBudgetFake({ cap: 5000 });
    mocks.getCurrencyMock.mockResolvedValue("INR");
    const r = await HANDLERS["meta_ads.create_ad_set"](
      row("c-inr", "meta_ads.create_ad_set", { ...createBody, daily_budget_usd: 2000, currency: "INR" }, "user-1"),
    );
    expect(r.error).toMatch(/^cap_refuse: ad_budget_non_usd_account/);
    expect(mocks.metaCreateAdSetMock).not.toHaveBeenCalled();
    expect(fake.budget!.held).toBe(0);
  });

  it("refuses a raise on a lifetime-budget ad set", async () => {
    fake = makeAdBudgetFake({ cap: 5000 });
    metaGraph({ adSetLifetime: "500000" });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      row("r9", "meta_ads.update_ad_set_budget", { ad_set_id: "as1", daily_budget_usd: 80, expected_current_daily_budget_usd: 40, over_cap: false }),
    );
    expect(r.error).toBe("cap_refuse: ad_budget_lifetime_budget");
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
  });

  it("the chat spend-apply fast path is held too (a person typed it, it still counts)", async () => {
    fake = makeAdBudgetFake({ cap: 100, days: 10 });
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      userChatRow({
        ad_set_id: "as1",
        daily_budget_usd: 80,
        expected_current_daily_budget_usd: 40,
        over_cap: true,
        origin: "user_initiated_chat",
        authorized_effective_cap: AUTH_CAP,
      }),
    );
    expect(r.error).toBe("cap_refuse: ad_budget_over_month");
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
  });

  it("the null-approver auto raise passes the cap AND takes a hold before Meta is called", async () => {
    fake = makeAdBudgetFake({ cap: 1000, days: 10 });
    const order: string[] = [];
    mocks.metaUpdateBudgetMock.mockImplementation(async () => {
      order.push("meta");
    });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      row("auto1", "meta_ads.update_ad_set_budget", { ad_set_id: "as1", daily_budget_usd: 50, expected_current_daily_budget_usd: 40, over_cap: false }),
    );
    expect(r.ok).toBe(true);
    expect(mocks.capReaderMock).toHaveBeenCalledTimes(1);
    expect(fake.res.get("auto1:raise")).toMatchObject({ status: "committed", object_id: "as1", amount: 125 });
    expect(fake.calls[0].name).toBe("reserve_ad_spend");
    expect(fake.calls.at(-1)!.name).toBe("settle_ad_spend");
    expect(order).toEqual(["meta"]);
  });

  it("a cut takes no hold; on an ad set the budget does not hold, its rebase changes nothing", async () => {
    fake = makeAdBudgetFake({ cap: 100 });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      row("cut", "meta_ads.update_ad_set_budget", { ad_set_id: "as1", daily_budget_usd: 20, expected_current_daily_budget_usd: 40, over_cap: false }),
    );
    expect(r.ok).toBe(true);
    expect(fake.namesCalled()).toEqual(["rebase_ad_spend_for_object"]);
    expect(fake.calls[0].args).toMatchObject({ p_platform: "meta", p_object_id: "as1", p_new_daily_usd: 20, p_idem_key: "cut:rebase" });
    expect(fake.res.size).toBe(0);
  });

  it("a cut lowers the hold by the cut: +$50 held, cut by $20 holds $30 a day; a raise to $90 then holds only +$10; a retry does not double", async () => {
    fake = makeAdBudgetFake({ cap: 100000, days: 10, margin: 1.25 });
    const set = (id: string, to: number, from: number) =>
      HANDLERS["meta_ads.update_ad_set_budget"](
        row(id, "meta_ads.update_ad_set_budget", { ad_set_id: "as9", daily_budget_usd: to, expected_current_daily_budget_usd: from, over_cap: false }),
      );
    expect((await set("r100", 100, 50)).ok).toBe(true);
    expect(fake.heldDaily("meta", "as9")).toBe(50);

    expect((await set("c80", 80, 100)).ok).toBe(true);
    expect(fake.calls.find((c) => c.args.p_idem_key === "c80:rebase")!.args).toMatchObject({ p_new_daily_usd: 80, p_cut_usd: 20 });
    expect(fake.heldDaily("meta", "as9")).toBe(30);
    expect(fake.budget!.held).toBe(437.5);

    expect((await set("c80", 80, 100)).ok).toBe(true);
    expect(fake.heldDaily("meta", "as9")).toBe(30);
    expect([...fake.res.values()].filter((x) => x.op === "rebase")).toHaveLength(1);

    expect((await set("r90", 90, 80)).ok).toBe(true);
    expect(fake.res.get("r90:raise")).toMatchObject({ status: "committed", delta: 10, amount: 125 });
    expect(fake.heldDaily("meta", "as9")).toBe(40);
  });

  it("a cut the platform refused does not rebase", async () => {
    fake = makeAdBudgetFake({ cap: 100000, days: 10 });
    mocks.metaUpdateBudgetMock.mockImplementationOnce(async () => {
      throw new Error("meta down");
    });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      row("cutx", "meta_ads.update_ad_set_budget", { ad_set_id: "as1", daily_budget_usd: 20, expected_current_daily_budget_usd: 40, over_cap: false }),
    );
    expect(r.ok).toBe(false);
    expect(fake.namesCalled()).toEqual([]);
  });

  it("a rebase that fails leaves the cut applied (best effort; the old hold only over-holds)", async () => {
    fake = makeAdBudgetFake({ cap: 100000, days: 10 });
    fake.failRpc("db down");
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      row("cuty", "meta_ads.update_ad_set_budget", { ad_set_id: "as1", daily_budget_usd: 20, expected_current_daily_budget_usd: 40, over_cap: false }),
    );
    expect(r.ok).toBe(true);
    expect(fake.namesCalled()).toEqual(["rebase_ad_spend_for_object", "rebase_ad_spend_for_object", "rebase_ad_spend_for_object"]);
  });

  it("T13: with no budget, a create keeps its name, gets no end date, and makes no budget reads", async () => {
    const r = await HANDLERS["meta_ads.create_ad_set"](row("c13", "meta_ads.create_ad_set", createBody));
    expect(r.ok).toBe(true);
    expect(mocks.metaCreateAdSetMock.mock.calls[0][1].name).toBe("Spring promo");
    expect(mocks.metaCreateAdSetMock.mock.calls[0][1]).not.toHaveProperty("end_time");
    expect(mocks.fbGetMock).not.toHaveBeenCalled();
    expect(fake.namesCalled()).toEqual(["reserve_ad_spend"]);
  });
});

describe("S7: prior state of every reversible Meta change, and Undo through the same executor", () => {
  const GENEROUS = { enabled: true, max_daily_budget_usd: 100_000, max_pct_change_per_run: 1000, max_daily_total_change_usd: null };
  const row = (id: string, decision_class: string, body: Record<string, unknown>, approved_by: string | null = "user-1", exec = false) => ({
    id,
    tenant_id: "tenant-1",
    agent_run_id: REAL_RUN_UUID,
    decision_class,
    status: "approved",
    handler: null,
    body,
    approved_by,
    ...(exec ? { exec_source: "channel_actions" as const } : {}),
  });
  beforeEach(() => {
    mocks.capReaderMock.mockResolvedValue({ cap: GENEROUS, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
    mocks.fbGetMock.mockImplementation(async (_t: string, _id: string, q: { fields: string }) =>
      q.fields.includes("status") ? { status: "ACTIVE", daily_budget: "1900" } : { daily_budget: "4000" },
    );
  });

  it("a pause records the status and daily budget it had, from the channel action that ran it", async () => {
    fake = makeAdBudgetFake({ cap: 5000 });
    const r = await HANDLERS["meta_ads.set_status"](
      row("act-pause", "meta_ads.set_status", { object_id: "as1", level: "adset", status: "PAUSED", over_cap: false, name: "Awareness" }, "owner-1", true) as never,
    );
    expect(r.ok).toBe(true);
    expect(fake.adChanges).toEqual([
      expect.objectContaining({
        platform: "meta",
        object_id: "as1",
        level: "ad_set",
        source: "zavi",
        action_table: "channel_actions",
        action_id: "act-pause",
        change_kind: "status",
        before_status: "ACTIVE",
        after_status: "PAUSED",
        before_daily_usd: 19,
        object_name: "Awareness",
      }),
    ]);
  });

  it("a budget change records the budget it replaced (the drift-checked one), from the decision", async () => {
    fake = makeAdBudgetFake({ cap: 5000 });
    const r = await HANDLERS["meta_ads.update_ad_set_budget"](
      row("dec-cut", "meta_ads.update_ad_set_budget", { ad_set_id: "as2", daily_budget_usd: 30, expected_current_daily_budget_usd: 40, over_cap: false }) as never,
    );
    expect(r.ok).toBe(true);
    expect(fake.adChanges).toEqual([
      expect.objectContaining({ action_table: "decisions", action_id: "dec-cut", change_kind: "budget", before_daily_usd: 40, after_daily_usd: 30 }),
    ]);
  });

  it("a prior state that cannot be read never blocks the pause; it only is not undoable", async () => {
    fake = makeAdBudgetFake({ cap: 5000 });
    mocks.fbGetMock.mockRejectedValue(new Error("graph down"));
    const r = await HANDLERS["meta_ads.set_status"](row("act-p2", "meta_ads.set_status", { object_id: "as1", level: "adset", status: "PAUSED", over_cap: false }) as never);
    expect(r.ok).toBe(true);
    expect(mocks.metaSetStatusMock).toHaveBeenCalledTimes(1);
    expect(fake.adChanges).toEqual([]);
  });

  it("Undo of a pause is a founder-approved resume that still takes the budget hold, and is refused past the budget", async () => {
    const { inverseOf } = await import("@/services/decisions/ad-changes");
    const inv = inverseOf({
      id: "ch-1",
      platform: "meta",
      object_id: "as1",
      level: "ad_set",
      campaign_id: null,
      object_name: "Awareness",
      source: "zavi",
      action_table: "channel_actions",
      action_id: "act-pause",
      change_kind: "status",
      before_status: "ACTIVE",
      after_status: "PAUSED",
      before_daily_usd: "40",
      after_daily_usd: "40",
      occurred_at: "2026-09-28T08:25:00Z",
    })!;
    expect(inv.decision_class).toBe("meta_ads.set_status_review");
    mocks.fbGetMock.mockImplementation(async () => ({ daily_budget: "4000", status: "PAUSED" }));

    fake = makeAdBudgetFake({ cap: 5000, days: 10 });
    const ok = await HANDLERS[inv.decision_class](row("undo-1", inv.decision_class, inv.body, "user-1") as never);
    expect(ok.ok).toBe(true);
    expect(fake.calls.find((c) => c.name === "reserve_ad_spend")!.args).toMatchObject({ p_op: "resume", p_object_id: "as1" });
    expect(mocks.metaSetStatusMock).toHaveBeenCalledWith("tenant-1", { object_id: "as1", level: "adset", status: "ACTIVE" });

    mocks.metaSetStatusMock.mockClear();
    fake = makeAdBudgetFake({ cap: 100, days: 10 });
    const refused = await HANDLERS[inv.decision_class](row("undo-2", inv.decision_class, inv.body, "user-1") as never);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/cap_refuse: ad_budget_over/);
    expect(mocks.metaSetStatusMock).not.toHaveBeenCalled();
  });

  it("Undo refuses when the ad was changed since (live status is not what Zavi left): nothing held, nothing sent", async () => {
    const { inverseOf } = await import("@/services/decisions/ad-changes");
    const inv = inverseOf({
      id: "ch-1", platform: "meta", object_id: "as1", level: "ad_set", campaign_id: null, object_name: "Awareness",
      source: "zavi", action_table: "channel_actions", action_id: "act-pause", change_kind: "status",
      before_status: "ACTIVE", after_status: "PAUSED", before_daily_usd: "40", after_daily_usd: "40", occurred_at: "2026-09-28T08:25:00Z",
    })!;
    expect(inv.body).toMatchObject({ status: "ACTIVE", expected_current_status: "PAUSED" });
    fake = makeAdBudgetFake({ cap: 5000, days: 10 });
    mocks.fbGetMock.mockImplementation(async () => ({ daily_budget: "4000", status: "ACTIVE" }));
    const r = await HANDLERS[inv.decision_class](row("undo-3", inv.decision_class, inv.body, "user-1") as never);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^meta_ads_status_drift/);
    expect(mocks.metaSetStatusMock).not.toHaveBeenCalled();
    expect(fake.namesCalled()).toEqual([]);
    mocks.fbGetMock.mockRejectedValue(new Error("graph down"));
    const r2 = await HANDLERS[inv.decision_class](row("undo-4", inv.decision_class, inv.body, "user-1") as never);
    expect(r2.error).toMatch(/^meta_ads_status_drift/);
    expect(mocks.metaSetStatusMock).not.toHaveBeenCalled();
  });
});

describe("meta_ads.update_campaign_budget — a campaign that holds its own budget (CBO)", () => {
  const GENEROUS = { enabled: true, max_daily_budget_usd: 100_000, max_pct_change_per_run: 1000, max_daily_total_change_usd: null };
  function campaignRow(body: Record<string, unknown>, decision_class = "meta_ads.update_campaign_budget", approved_by: string | null = null) {
    return { id: "cb-1", tenant_id: "tenant-1", agent_run_id: REAL_RUN_UUID, decision_class, status: "approved", handler: null, body, approved_by };
  }
  const raise = { campaign_id: "camp-9", daily_budget_usd: 80, expected_current_daily_budget_usd: 40, rationale: "scale the winner", over_cap: false };

  beforeEach(() => {
    mocks.capReaderMock.mockResolvedValue({ cap: GENEROUS, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
    mocks.fbGetMock.mockResolvedValue({ daily_budget: "4000", lifetime_budget: null });
    mocks.readOwnCampaignMock.mockImplementation((t: string, id: string) => mocks.fbGetMock(t, id, { fields: "daily_budget,lifetime_budget" }));
    mocks.metaUpdateCampaignBudgetMock.mockResolvedValue({ id: "camp-9", daily_budget: "8000" });
  });

  it("raises the CAMPAIGN's daily budget after the live read and the drift guard, never an ad-set write", async () => {
    const r = await HANDLERS["meta_ads.update_campaign_budget"](campaignRow(raise));
    expect(r.ok).toBe(true);
    expect(mocks.readOwnCampaignMock).toHaveBeenCalledWith("tenant-1", "camp-9");
    expect(mocks.assertNoDriftMock).toHaveBeenCalledWith(4000, 4000);
    expect(mocks.metaUpdateCampaignBudgetMock).toHaveBeenCalledWith("tenant-1", { campaign_id: "camp-9", daily_budget_usd: 80 });
    expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
  });

  it("a campaign outside the tenant's ad account is refused before any hold or Meta write", async () => {
    mocks.readOwnCampaignMock.mockRejectedValueOnce(new Error("campaign camp-9 is not in this workspace's connected ad account; nothing was sent."));
    const r = await HANDLERS["meta_ads.update_campaign_budget"](campaignRow(raise));
    expect(r.ok).toBe(false);
    expect(mocks.metaUpdateCampaignBudgetMock).not.toHaveBeenCalled();
  });

  it("the review class runs the same handler", async () => {
    const r = await HANDLERS["meta_ads.update_campaign_budget_review"](campaignRow({ ...raise, over_cap: true }, "meta_ads.update_campaign_budget_review"));
    expect(r.ok).toBe(true);
    expect(mocks.metaUpdateCampaignBudgetMock).toHaveBeenCalledTimes(1);
  });

  it("a LIFETIME campaign budget is refused, never converted, and nothing is written", async () => {
    mocks.fbGetMock.mockResolvedValue({ daily_budget: null, lifetime_budget: "900000" });
    const r = await HANDLERS["meta_ads.update_campaign_budget"](campaignRow(raise));
    expect(r).toMatchObject({ ok: false, code: "meta_ads_lifetime_budget" });
    expect(mocks.metaUpdateCampaignBudgetMock).not.toHaveBeenCalled();
  });

  it("a campaign whose budget lives on its ad sets is refused", async () => {
    mocks.fbGetMock.mockResolvedValue({ daily_budget: null, lifetime_budget: null });
    const r = await HANDLERS["meta_ads.update_campaign_budget"](campaignRow(raise));
    expect(r).toMatchObject({ ok: false, code: "meta_ads_budget_on_ad_sets" });
    expect(mocks.metaUpdateCampaignBudgetMock).not.toHaveBeenCalled();
  });

  it("a drift refuses before any cap read or write", async () => {
    mocks.assertNoDriftMock.mockImplementation(() => {
      throw new ExpectedToolError("meta_ads_budget_drift", "drifted");
    });
    const r = await HANDLERS["meta_ads.update_campaign_budget"](campaignRow(raise));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/drifted/);
    expect(mocks.capReaderMock).not.toHaveBeenCalled();
    expect(mocks.metaUpdateCampaignBudgetMock).not.toHaveBeenCalled();
  });

  it("an agent-initiated raise over the tenant cap is refused (the same cap as ad sets)", async () => {
    mocks.capReaderMock.mockResolvedValue({
      cap: { enabled: true, max_daily_budget_usd: 50, max_pct_change_per_run: null, max_daily_total_change_usd: null },
      today_total_change_usd: 0,
      currency: "USD",
      units_per_usd: 1,
    });
    const r = await HANDLERS["meta_ads.update_campaign_budget"](campaignRow(raise));
    expect(r.ok).toBe(false);
    expect(r.error).toBe("cap_refuse: over_absolute_ceiling");
    expect(mocks.metaUpdateCampaignBudgetMock).not.toHaveBeenCalled();
  });

  it("an agent-initiated raise on a tenant with NO cap is refused (fails closed)", async () => {
    mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
    const r = await HANDLERS["meta_ads.update_campaign_budget"](campaignRow(raise));
    expect(r.error).toBe("cap_refuse: no_cap_configured");
    expect(mocks.metaUpdateCampaignBudgetMock).not.toHaveBeenCalled();
  });

  it("a body in another currency than the account's is refused", async () => {
    const r = await HANDLERS["meta_ads.update_campaign_budget"](campaignRow({ ...raise, currency: "INR" }));
    expect(r.ok).toBe(false);
    expect(mocks.metaUpdateCampaignBudgetMock).not.toHaveBeenCalled();
  });

  it("under an ad budget, a raise is held on the CAMPAIGN as what it adds (new minus live)", async () => {
    fake = makeAdBudgetFake({ cap: 5000, days: 10, margin: 1 });
    const r = await HANDLERS["meta_ads.update_campaign_budget"](campaignRow(raise));
    expect(r.ok).toBe(true);
    const reserve = fake.calls.find((c) => c.name === "reserve_ad_spend");
    expect(reserve?.args).toMatchObject({ p_platform: "meta", p_object_id: "camp-9", p_op: "raise", p_daily_delta_usd: 40 });
    expect(fake.budget!.held).toBe(400);
  });

  it("a landed cut lowers the campaign's hold by the cut, not to the new rate", async () => {
    fake = makeAdBudgetFake({ cap: 5000, days: 10, margin: 1 });
    mocks.fbGetMock.mockResolvedValue({ daily_budget: "8000", lifetime_budget: null });
    const cut = { campaign_id: "camp-9", daily_budget_usd: 60, expected_current_daily_budget_usd: 80, rationale: "trim", over_cap: false };
    const r = await HANDLERS["meta_ads.update_campaign_budget"](campaignRow(cut));
    expect(r.ok).toBe(true);
    expect(fake.calls.filter((c) => c.name === "reserve_ad_spend")).toEqual([]);
    expect(fake.calls.find((c) => c.name === "rebase_ad_spend_for_object")!.args).toMatchObject({ p_object_id: "camp-9", p_new_daily_usd: 60, p_cut_usd: 20 });
  });

  it("a raise past the month's ad budget is refused and nothing is sent to Meta", async () => {
    fake = makeAdBudgetFake({ cap: 100, days: 10 });
    const r = await HANDLERS["meta_ads.update_campaign_budget"](campaignRow(raise, "meta_ads.update_campaign_budget", "user-1"));
    expect(r.ok).toBe(false);
    expect(mocks.metaUpdateCampaignBudgetMock).not.toHaveBeenCalled();
  });
});

describe("meta_ads campaign create / change / delete", () => {
  const GENEROUS = { enabled: true, max_daily_budget_usd: 100_000, max_pct_change_per_run: 1000, max_daily_total_change_usd: null };
  const DEC = "a1b2c3d4-e5f6-4a5b-8c9d-0123456789ab";
  function row(decision_class: string, body: Record<string, unknown>, approved_by: string | null = null) {
    return { id: DEC, tenant_id: "tenant-1", agent_run_id: REAL_RUN_UUID, decision_class, status: "approved", handler: null, body, approved_by };
  }
  const create = { name: "Leads Q4", objective: "OUTCOME_LEADS", daily_budget_usd: 40, rationale: "" };

  beforeEach(() => {
    mocks.capReaderMock.mockResolvedValue({ cap: GENEROUS, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 });
    mocks.metaCreateCampaignMock.mockResolvedValue({ id: "c-new", name: "Leads Q4 · zva1b2c3d4e5", reused: false });
    mocks.metaUpdateCampaignMock.mockResolvedValue({ updated_fields: ["name"], live: {} });
    mocks.metaDeleteCampaignMock.mockResolvedValue({ before_status: "ACTIVE", name: "Old" });
  });

  it("a budgeted create is held, named with the prefix, tagged by the action, created PAUSED and committed on its id", async () => {
    fake = makeAdBudgetFake({ cap: 1000, days: 10, margin: 1.25 });
    const r = await HANDLERS["meta_ads.create_campaign"](row("meta_ads.create_campaign", create));
    expect(r.ok).toBe(true);
    expect(r.created).toEqual({ platform: "meta", object_type: "campaign", id: "c-new", status: "PAUSED" });
    const call = mocks.metaCreateCampaignMock.mock.calls[0][1] as Record<string, unknown>;
    expect(call).toMatchObject({ name: "Zavi · Leads Q4", tag: "zva1b2c3d4e5", objective: "OUTCOME_LEADS", daily_budget_usd: 40 });
    expect(fake.calls.find((c) => c.name === "note_ad_spend_ref")?.args.p_ref).toMatchObject({ kind: "meta_tag", level: "campaign", tag: "zva1b2c3d4e5" });
    expect(fake.budget!.held).toBe(500);
  });

  it("a create with no campaign budget moves no money: no cap read, no hold", async () => {
    fake = makeAdBudgetFake({ cap: 1000 });
    const { daily_budget_usd: _omit, ...unbudgeted } = create;
    const r = await HANDLERS["meta_ads.create_campaign"](row("meta_ads.create_campaign", unbudgeted));
    expect(r.ok).toBe(true);
    expect(mocks.capReaderMock).not.toHaveBeenCalled();
    expect(fake.calls.filter((c) => c.name === "reserve_ad_spend")).toEqual([]);
    expect(mocks.metaCreateCampaignMock.mock.calls[0][1]).toMatchObject({ name: "Leads Q4" });
  });

  it("an agent-approved budgeted create over the tenant cap is refused before Meta", async () => {
    mocks.capReaderMock.mockResolvedValue({
      cap: { enabled: true, max_daily_budget_usd: 20, max_pct_change_per_run: null, max_daily_total_change_usd: null },
      today_total_change_usd: 0,
      currency: "USD",
      units_per_usd: 1,
    });
    const r = await HANDLERS["meta_ads.create_campaign"](row("meta_ads.create_campaign", create));
    expect(r.error).toBe("cap_refuse: over_absolute_ceiling");
    expect(mocks.metaCreateCampaignMock).not.toHaveBeenCalled();
  });

  it("a budgeted create past the month's ad budget is refused and nothing is sent", async () => {
    fake = makeAdBudgetFake({ cap: 100, days: 10 });
    const r = await HANDLERS["meta_ads.create_campaign"](row("meta_ads.create_campaign", create, "user-1"));
    expect(r.ok).toBe(false);
    expect(mocks.metaCreateCampaignMock).not.toHaveBeenCalled();
  });

  it("a change passes the parsed body to the executor and surfaces its refusal code", async () => {
    const body = { campaign_id: "120200000001", new_name: "Renamed", rationale: "" };
    expect((await HANDLERS["meta_ads.update_campaign"](row("meta_ads.update_campaign", body))).ok).toBe(true);
    expect(mocks.metaUpdateCampaignMock.mock.calls[0][1]).toMatchObject({ campaign_id: "120200000001", new_name: "Renamed" });
    mocks.metaUpdateCampaignMock.mockRejectedValueOnce(new ExpectedToolError("meta_ads_spend_cap_drift", "moved"));
    const r = await HANDLERS["meta_ads.update_campaign"](row("meta_ads.update_campaign", body));
    expect(r).toMatchObject({ ok: false, code: "meta_ads_spend_cap_drift" });
  });

  it("a delete releases the campaign's holds after the delete lands", async () => {
    fake = makeAdBudgetFake({ cap: 5000 });
    const r = await HANDLERS["meta_ads.delete_campaign"](row("meta_ads.delete_campaign", { campaign_id: "120200000001", rationale: "" }, "user-1"));
    expect(r.ok).toBe(true);
    expect(mocks.metaDeleteCampaignMock).toHaveBeenCalledWith("tenant-1", "120200000001");
    expect(fake.calls.at(-1)).toMatchObject({ name: "release_ad_spend_for_object", args: { p_platform: "meta", p_object_id: "120200000001" } });
  });

  it("a failed delete releases nothing", async () => {
    fake = makeAdBudgetFake({ cap: 5000 });
    mocks.metaDeleteCampaignMock.mockRejectedValueOnce(new ExpectedToolError("meta_ads_invalid_target", "not yours"));
    const r = await HANDLERS["meta_ads.delete_campaign"](row("meta_ads.delete_campaign", { campaign_id: "120200000001", rationale: "" }, "user-1"));
    expect(r).toMatchObject({ ok: false, code: "meta_ads_invalid_target" });
    expect(fake.calls.some((c) => c.name === "release_ad_spend_for_object")).toBe(false);
  });
});

describe("meta_ads ad set / ad edits and the copy of one ad", () => {
  const DEC = "b1b2c3d4-e5f6-4a5b-8c9d-0123456789ab";
  const row = (decision_class: string, body: Record<string, unknown>) => ({
    id: DEC, tenant_id: "tenant-1", agent_run_id: REAL_RUN_UUID, decision_class, status: "approved", handler: null, body, approved_by: "user-1",
  });

  it("an ad set change hands the parsed (normalised) body to the executor, and never touches the ad budget", async () => {
    fake = makeAdBudgetFake({ cap: 5000 });
    mocks.metaUpdateAdSetMock.mockResolvedValue({ updated_fields: ["end_time"] });
    const r = await HANDLERS["meta_ads.update_ad_set"](row("meta_ads.update_ad_set", {
      ad_set_id: "238000000001", end_time: "2026-12-01T00:00:00+0000", expected_current_end_time: null, rationale: "",
    }));
    expect(r.ok).toBe(true);
    expect(mocks.metaUpdateAdSetMock.mock.calls[0][1]).toMatchObject({ end_time: "2026-12-01T00:00:00+00:00" });
    expect(fake.calls).toEqual([]);
  });

  it("an invalid ad set body is refused before Meta", async () => {
    const r = await HANDLERS["meta_ads.update_ad_set"](row("meta_ads.update_ad_set", { ad_set_id: "238000000001", bid_amount_usd: 3, rationale: "" }));
    expect(r.ok).toBe(false);
    expect(mocks.metaUpdateAdSetMock).not.toHaveBeenCalled();
  });

  it("an ad change surfaces the executor's refusal code", async () => {
    mocks.metaUpdateAdMock.mockRejectedValueOnce(new ExpectedToolError("meta_ads_creative_drift", "moved"));
    const r = await HANDLERS["meta_ads.update_ad"](row("meta_ads.update_ad", { ad_id: "238000000777", creative_id: "222222", expected_current_creative_id: "111111", rationale: "" }));
    expect(r).toMatchObject({ ok: false, code: "meta_ads_creative_drift" });
  });

  it("a copy of one ad is tagged by the action and reported live", async () => {
    mocks.metaDuplicateAdMock.mockResolvedValue({ id: "238000000999", name: "Hero · zvb1b2c3d4e5", reused: false });
    const r = await HANDLERS["meta_ads.duplicate_ad"](row("meta_ads.duplicate_ad", { source_ad_id: "238000000777", ad_set_id: "238000000001", rationale: "" }));
    expect(r.ok).toBe(true);
    expect(mocks.metaDuplicateAdMock.mock.calls[0][1]).toMatchObject({ tag: "zvb1b2c3d4e5" });
    expect(r.created).toEqual({ platform: "meta", object_type: "ad", id: "238000000999", status: "ACTIVE" });
  });
});

describe("meta_ads creatives and library assets", () => {
  const DEC = "c1b2c3d4-e5f6-4a5b-8c9d-0123456789ab";
  const row = (decision_class: string, body: Record<string, unknown>) => ({
    id: DEC, tenant_id: "tenant-1", agent_run_id: REAL_RUN_UUID, decision_class, status: "approved", handler: null, body, approved_by: "user-1",
  });

  it("a creative is tagged by the action and its id goes back to the agent", async () => {
    mocks.metaCreateCreativeMock.mockResolvedValue({ id: "777000", name: "Autumn · zvc1b2c3d4e5", reused: false });
    const r = await HANDLERS["meta_ads.create_creative"](row("meta_ads.create_creative", {
      name: "Autumn", primary_text: "x", headline: "y", link_url: "https://example.com", image_url: "https://example.com/a.png", rationale: "",
    }));
    expect(r.ok).toBe(true);
    expect(mocks.metaCreateCreativeMock.mock.calls[0][1]).toMatchObject({ tag: "zvc1b2c3d4e5" });
    expect(JSON.parse(r.agent_outcome as string)).toEqual({ creative_id: "777000", name: "Autumn · zvc1b2c3d4e5" });
  });

  it("an uploaded image's hash goes back to the agent", async () => {
    mocks.metaUploadAssetMock.mockResolvedValue({ kind: "image", hash: "abc123", url: null });
    const r = await HANDLERS["meta_ads.upload_asset"](row("meta_ads.upload_asset", { kind: "image", url: "https://example.com/a.png", name: "Hero", rationale: "" }));
    expect(JSON.parse(r.agent_outcome as string)).toEqual({ image_hash: "abc123", url: null });
  });
});

describe("Meta rate-limit cooldown at dispatch", () => {
  const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
  async function withCooldown(run: () => Promise<void>) {
    _setMetaCooldownStoreForTest(_memoryCooldownStore());
    await startMetaCooldown("act_1", Date.now() + 5 * 60_000, "test");
    vi.mocked(authorizeUnattended).mockImplementation(async () => {
      try {
        if (!metaSafetyActive()) await gateMetaCall("act_1", metaCaller());
        return { verdict: "allow", reasons: [] } as never;
      } catch {
        return { verdict: "deny", reasons: ["ad_facts_unreadable"] } as never;
      }
    });
    try {
      await run();
    } finally {
      vi.mocked(authorizeUnattended).mockImplementation(async () => ({ verdict: "allow", reasons: [] }) as never);
      _setMetaCooldownStoreForTest(null);
    }
  }
  const cgoRow = (daily: number) => ({
    ...userChatRow({ ad_set_id: "as1", daily_budget_usd: daily, expected_current_daily_budget_usd: 40, rationale: "cgo", over_cap: false }),
    approved_by: OWNER,
    approved_by_source: "cgo",
  });

  it("a cgo-approved budget cut during the cooldown executes (the recheck runs as a safety job)", async () => {
    await withCooldown(async () => {
      fake = makeAdBudgetFake({ cap: 1000, days: 10 });
      mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1, cap_row_absent: true });
      const r = await HANDLERS["meta_ads.update_ad_set_budget"](cgoRow(30));
      expect(r.ok).toBe(true);
      expect(mocks.metaUpdateBudgetMock).toHaveBeenCalledTimes(1);
    });
  });

  it("a cgo-approved raise during the cooldown is refused before Meta", async () => {
    await withCooldown(async () => {
      fake = makeAdBudgetFake({ cap: 1000, days: 10 });
      mocks.capReaderMock.mockResolvedValue({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1, cap_row_absent: true });
      const r = await HANDLERS["meta_ads.update_ad_set_budget"](cgoRow(80));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/ad_facts_unreadable/);
      expect(mocks.metaUpdateBudgetMock).not.toHaveBeenCalled();
    });
  });
});

beforeEach(() => {
  vi.spyOn(overProjectionGate, "read").mockResolvedValue(null);
});

describe("meta_ads.pause_past_cut_guard: a person's pause past the cut guard", () => {
  const DEC = "d1b2c3d4-e5f6-4a5b-8c9d-0123456789ab";
  const row = (body: Record<string, unknown>, approved_by: string | null = "member-1") => ({
    id: DEC, tenant_id: "tenant-1", agent_run_id: REAL_RUN_UUID, decision_class: "meta_ads.pause_past_cut_guard", status: "approved", handler: null, body, approved_by,
  });
  const BODY = {
    object_id: "238000000001", level: "adset", status: "PAUSED", day: "2026-11-01",
    guard_code: "cut_blocked_insufficient_settled_signal", guard_reason: "Still learning.", spend_7d_usd: 42.5,
    name: "Set A", rationale: "", over_cap: true, origin: "cut_guard_override",
  };

  it("pauses the ad set and marks the result as a cut guard override", async () => {
    metaGraphStatus();
    const r = await HANDLERS["meta_ads.pause_past_cut_guard"](row(BODY));
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ cut_guard_override: true });
    expect(mocks.metaSetStatusMock).toHaveBeenCalledWith("tenant-1", { object_id: "238000000001", level: "adset", status: "PAUSED" });
  });

  it.each([
    ["a resume", { ...BODY, status: "ACTIVE" }],
    ["a campaign", { ...BODY, level: "campaign" }],
    ["a budget riding along", { ...BODY, daily_budget_usd: 500 }],
    ["another origin", { ...BODY, origin: "agent" }],
  ])("refuses %s before Meta", async (_label, body) => {
    const r = await HANDLERS["meta_ads.pause_past_cut_guard"](row(body));
    expect(r.ok).toBe(false);
    expect(mocks.metaSetStatusMock).not.toHaveBeenCalled();
  });

  function metaGraphStatus() {
    mocks.fbGetMock.mockResolvedValue({ status: "ACTIVE", daily_budget: "4000" });
  }
});

describe("meta_ads.replace_ad_set_geo_review: a Zavi location proposal", () => {
  it("a stale fingerprint refuses before Meta is written, and nothing is retried", async () => {
    mocks.fbGetMock.mockResolvedValue({ name: "Set A", targeting: { geo_locations: { countries: ["US"] } } });
    const r = await HANDLERS["meta_ads.replace_ad_set_geo_review"]({
      id: "e1b2c3d4-e5f6-4a5b-8c9d-0123456789ab", tenant_id: "tenant-1", agent_run_id: REAL_RUN_UUID, decision_class: "meta_ads.replace_ad_set_geo_review", status: "approved", handler: null, approved_by: "user-1",
      body: { ad_set_id: "238000000001", places: [{ type: "city", key: "2420605", name: "Denver" }], before_names: ["United States"], expected_fingerprint: "0".repeat(64), rationale: "Most orders come from Denver.", over_cap: true, origin: "zavi_location_proposal" },
    });
    expect(r).toMatchObject({ ok: false, code: "meta_ads_geo_stale" });
  });
});

describe("meta_ads.replace_ad_set_geo_review: Zavi's change at dispatch", () => {
  const BODY = { ad_set_id: "238000000001", places: [{ type: "city", key: "2420605", name: "Denver" }], before_names: ["United States"], before_places: [{ type: "country", key: "US", name: "United States" }], rationale: "Most orders come from Denver.", over_cap: true, origin: "zavi_location_proposal" };
  const row = (body: Record<string, unknown>) => ({ id: "f1b2c3d4-e5f6-4a5b-8c9d-0123456789ab", tenant_id: "tenant-1", agent_run_id: REAL_RUN_UUID, decision_class: "meta_ads.replace_ad_set_geo_review", status: "approved", handler: null, approved_by: "user-1", body });

  it("a read-back that differs fails the card, with no undo", async () => {
    const { metaGeoFingerprint } = await import("@/services/tools/meta-ads/write/replace_ad_set_geo");
    const geo = { countries: ["US"] };
    geoCheck.refused = null;
    mocks.fbGetMock.mockResolvedValue({ name: "Set A", targeting: { geo_locations: geo } });
    const r = await HANDLERS["meta_ads.replace_ad_set_geo_review"](row({ ...BODY, expected_fingerprint: metaGeoFingerprint(geo) }));
    expect(r).toMatchObject({ ok: false, code: "meta_ads_geo_unverified" });
    expect((r as { location_undo?: unknown }).location_undo).toBeUndefined();
  });

  it("a refused recheck (rules or countries changed) writes nothing", async () => {
    geoCheck.refused = "Denver is blocked now.";
    const r = await HANDLERS["meta_ads.replace_ad_set_geo_review"](row({ ...BODY, expected_fingerprint: "0".repeat(64) }));
    expect(r).toMatchObject({ ok: false, code: "meta_ads_locations_refused" });
    geoCheck.refused = null;
  });
});
