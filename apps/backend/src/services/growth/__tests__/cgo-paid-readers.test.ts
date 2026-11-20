import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  redditAdsAccount: vi.fn(), listAdAccounts: vi.fn(), listObjects: vi.fn(), performance: vi.fn(), gadsSearch: vi.fn(),
  proxy: vi.fn(), ensureAdAccounts: vi.fn(), health: vi.fn(), honest: vi.fn(),
}));
vi.mock("@/services/connectors/composio/api", () => ({ composioProxy: m.proxy }));
vi.mock("@/services/connectors/composio/account", () => ({ honestComposioToolError: m.honest, resolveOwnedComposioAccount: async (tenant_id: string) => ({ tenant_id, toolkit: "tiktok_ads", connected_account_id: "ca", auth_config_id: "cfg" }) }));
vi.mock("@/services/connectors/tiktok-ads/ad-accounts", () => ({ ensureAdAccounts: m.ensureAdAccounts }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => { throw new Error("no db"); } }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (s: string) => s, tenantClient: () => { throw new Error("no db"); } }));
vi.mock("@/services/connectors/reddit-ads/adapter", () => ({ redditAdsAccount: m.redditAdsAccount, listAdAccounts: m.listAdAccounts, listObjects: m.listObjects }));
vi.mock("@/services/connectors/reddit-ads/reporting", () => ({ performance: m.performance }));
vi.mock("@/services/tools/google-ads/conversion_tracking_health", () => ({ conversionTrackingHealthTool: { execute: async () => (await m.health()) ?? { overall_status: "healthy" } } }));
vi.mock("../ad-goal-match", () => ({ loadGoalMatchContext: async () => ({ mode: "unknown", googleBrand: null, googlePurchaseCampaigns: null }), withGoalMatch: (o: unknown) => o }));

import * as googleClient from "@/services/tools/google-ads/_client";
import { PAID_LABELS, loadCgoEvidence, readGoogleEvidence } from "../cgo-evidence";
import { loadTiktokObjects, readRedditAdsEvidence, readTiktokAdsEvidence, tiktokWindow } from "../cgo-channel-readers";
import { evaluateUnattended, loadUnattendedFacts, type UnattendedFacts } from "../unattended-policy";

const now = new Date("2026-10-08T12:00:00Z");
const conn = { id: "conn-1" };
const row = (object_id: string, date: string, spend: number | null, impressions: number | null) =>
  ({ object_id, date, provisional: false, spend, impressions, clicks: 1, signups: null, leads: null, purchases: 0, revenue: null, goal_conversions: null });

beforeEach(() => {
  vi.clearAllMocks();
  m.honest.mockImplementation(async (_t: string, _k: string, _l: string, e: unknown) => e);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(googleClient, "gadsSearch").mockImplementation(m.gadsSearch);
  m.redditAdsAccount.mockResolvedValue(conn);
  m.listAdAccounts.mockResolvedValue([{ id: "a2_1", name: "Acme", currency: "USD", business_id: "b1" }]);
  m.listObjects.mockResolvedValue([
    { id: "c1", ad_account_id: "a2_1", name: "Launch", configured_status: "ACTIVE", effective_status: "DELIVERING", optimization_goal: "CLICKS" },
    { id: "c2", ad_account_id: "a2_1", name: "Old", configured_status: "ARCHIVED" },
    { id: "c3", ad_account_id: "a2_1", name: "Quiet", configured_status: "PAUSED" },
  ]);
  m.performance.mockResolvedValue({
    currency: "USD", account_timezone: "America/Los_Angeles", window: { since: "2026-10-02", until: "2026-10-08" }, fetched_at: now.toISOString(),
    rows: [row("c1", "2026-10-02", 3, 100), row("c1", "2026-10-03", null, 50), row("c3", "2026-10-02", 0, 0)],
  });
});

describe("reddit_ads evidence", () => {
  it("reads the owned account through the ownership-checked reporter and keeps a missing metric unknown", async () => {
    const e = await readRedditAdsEvidence("tenant-a", now);
    expect(m.performance).toHaveBeenCalledWith("tenant-a", "a2_1", 7, "campaign");
    expect(m.listObjects).toHaveBeenCalledWith(conn, "a2_1", "campaign");
    expect(e.status).toBe("read");
    expect(e.campaigns!.map((c) => c.id)).toEqual(["c3", "c1"]);
    const c1 = e.campaigns![1];
    expect(c1).toMatchObject({ objective: "CLICKS", label: PAID_LABELS.trackingUnknown, reported: { currency: "USD", status: "DELIVERING", period_confirmed: true } });
    expect(c1.reported!.metrics).toBe("impressions 150, clicks 2, purchases 0");
    expect(e.as_of).toBe(now.toISOString());
    expect(e.reporting_period).toContain("America/Los_Angeles");
  });

  it("keeps purchases when all six metrics are known and lists the biggest spender first", async () => {
    m.performance.mockResolvedValueOnce({
      currency: "USD", account_timezone: "UTC", window: { since: "2026-10-02", until: "2026-10-08" }, fetched_at: now.toISOString(),
      rows: [
        { ...row("c1", "2026-10-02", 2, 10), signups: 1, leads: 1, purchases: 4 },
        { ...row("c3", "2026-10-02", 9, 10), signups: 0, leads: 0, purchases: 0 },
      ],
    });
    const e = await readRedditAdsEvidence("tenant-a", now);
    expect(e.campaigns!.map((c) => c.id)).toEqual(["c3", "c1"]);
    expect(e.campaigns![1].reported!.metrics).toBe("impressions 10, clicks 1, spend 2, signups 1, leads 1, purchases 4");
  });

  it("never guesses between several accounts", async () => {
    m.listAdAccounts.mockResolvedValue([{ id: "a2_1" }, { id: "a2_2" }]);
    expect(await readRedditAdsEvidence("tenant-a", now)).toMatchObject({ status: "could not read", reason: expect.stringMatching(/Multiple/) });
    expect(m.performance).not.toHaveBeenCalled();
  });

  it("is wired into cgo evidence; a not-connected workspace says so", async () => {
    const read = await loadCgoEvidence({ tenant_id: "tenant-a", channelSlugs: ["reddit_ads"], now, cardClass: "cgo" });
    expect(read.paid[0]).toMatchObject({ channel_slug: "reddit_ads", status: "read" });
    m.redditAdsAccount.mockRejectedValue(Object.assign(new Error("off"), { code: "reddit_ads_not_connected" }));
    const off = await loadCgoEvidence({ tenant_id: "tenant-a", channelSlugs: ["reddit_ads"], now, cardClass: "cgo" });
    expect(off.paid).toEqual([{ channel_slug: "reddit_ads", status: "not connected" }]);
  });

  it("set up but its login stopped working: cgo reads that, never \"not connected\"", async () => {
    const { ExpectedToolError } = await import("@/services/tools/types");
    m.redditAdsAccount.mockRejectedValue(new ExpectedToolError("reddit_ads_not_connected", "off"));
    m.honest.mockResolvedValue(new ExpectedToolError("reddit_ads_connection_stopped", "Reddit Ads connection stopped working on Oct 15. Reconnect it."));
    const off = await loadCgoEvidence({ tenant_id: "tenant-a", channelSlugs: ["reddit_ads"], now, cardClass: "cgo" });
    expect(m.honest).toHaveBeenCalledWith("tenant-a", "reddit_ads", "Reddit Ads", expect.objectContaining({ code: "reddit_ads_not_connected" }));
    expect(off.paid).toEqual([{ channel_slug: "reddit_ads", status: "could not read", reason: "Reddit Ads connection stopped working on Oct 15. Reconnect it." }]);
  });
});

describe("google_ads evidence carries the bidding-tracking verdict", () => {
  beforeEach(() => {
    m.gadsSearch.mockImplementation(async (_t: string, q: string) => {
      if (q.startsWith("SELECT campaign.id, campaign.name")) return [{ campaign: { id: "3", name: "Search" } }];
      if (q.includes("ORDER BY metrics.cost_micros")) return [];
      return [{ campaign: { resourceName: "customers/1/campaigns/3", advertisingChannelType: "SEARCH", biddingStrategyType: "MAXIMIZE_CONVERSIONS" }, metrics: { costMicros: "5000000", conversions: 2 } }];
    });
  });

  it("must catch: a broken verdict reaches cgo as tracking_verdict, reason and since, while the account reads healthy", async () => {
    const verdict = { status: "broken", reason: "Google is bidding blind: \"Booked job (upload)\" (0 conversions in 14 days on 900 clicks).", since: "2026-09-02", since_is_lower_bound: false };
    m.health.mockResolvedValue({ overall_status: "healthy", tracking_verdict: verdict });
    const g = await readGoogleEvidence("tenant-a", now);
    expect(g.tracking_verdict).toEqual(verdict);
  });

  it("must not catch: an unreadable verdict is left out, never guessed", async () => {
    m.health.mockRejectedValue(new Error("google_ads_not_connected"));
    const g = await readGoogleEvidence("tenant-a", now);
    expect(g).not.toHaveProperty("tracking_verdict");
  });
});

describe("youtube_ads evidence", () => {
  beforeEach(() => {
    m.gadsSearch.mockImplementation(async (_t: string, q: string) => {
      if (q.startsWith("SELECT campaign.id, campaign.name")) return [{ campaign: { id: "7", name: "Demand Gen" } }];
      if (q.includes("ORDER BY metrics.cost_micros")) return [{ campaign: { id: "7" }, metrics: { costMicros: "5000000" } }];
      return [{ campaign: { resourceName: "customers/1/campaigns/7", advertisingChannelType: "DEMAND_GEN", biddingStrategyType: "MAXIMIZE_CONVERSIONS" }, metrics: { costMicros: "5000000", conversions: 2 } }];
    });
  });

  it("lists only video and demand gen campaigns, and google_ads excludes them", async () => {
    const yt = await readGoogleEvidence("tenant-a", now, "youtube_ads");
    expect(yt).toMatchObject({ channel_slug: "youtube_ads", status: "read" });
    expect(yt.campaigns![0]).toMatchObject({ id: "7", name: "Demand Gen" });
    for (const q of m.gadsSearch.mock.calls.slice(0, 2).map((c) => c[1] as string)) expect(q).toContain("campaign.advertising_channel_type IN ('VIDEO', 'DEMAND_GEN')");
    m.gadsSearch.mockClear();
    await readGoogleEvidence("tenant-a", now);
    for (const q of m.gadsSearch.mock.calls.slice(0, 2).map((c) => c[1] as string)) expect(q).toContain("campaign.advertising_channel_type NOT IN ('VIDEO', 'DEMAND_GEN')");
  });

  it("loads alongside google_ads as its own channel, each from its own campaign types", async () => {
    m.gadsSearch.mockImplementation(async (_t: string, q: string) => {
      const yt = !q.includes("NOT IN");
      if (q.startsWith("SELECT campaign.id, campaign.name")) return [{ campaign: yt ? { id: "7", name: "Demand Gen" } : { id: "3", name: "Search" } }];
      if (q.includes("ORDER BY metrics.cost_micros")) return [];
      const id = /campaign\.id = (\d+)/.exec(q)?.[1];
      return [{ campaign: { resourceName: `customers/1/campaigns/${id}`, advertisingChannelType: id === "7" ? "DEMAND_GEN" : "SEARCH", biddingStrategyType: "MAXIMIZE_CONVERSIONS" }, metrics: { costMicros: "1000000", conversions: 1 } }];
    });
    const e = await loadCgoEvidence({ tenant_id: "tenant-a", channelSlugs: ["youtube_ads", "google_ads"], now, cardClass: "cgo" });
    expect(e.paid.map((p) => [p.channel_slug, p.status, p.campaigns!.map((c) => c.id)])).toEqual([["google_ads", "read", ["3"]], ["youtube_ads", "read", ["7"]]]);
  });
});

describe("tiktok_ads evidence", () => {
  const adv = (id: string, currency = "USD") => ({ advertiser_id: id, name: `Adv ${id}`, currency, status: "ENABLE", timezone: "America/Los_Angeles", source: "business_center" });
  const ok = (data: unknown) => ({ ok: true, status: 200, json: { code: 0, message: "OK", data } });
  const campaign = (id: string, name: string, op = "ENABLE", secondary = "CAMPAIGN_STATUS_ENABLE") =>
    ({ campaign_id: id, campaign_name: name, operation_status: op, secondary_status: secondary, objective_type: "WEB_CONVERSIONS", budget: 50, budget_mode: "BUDGET_MODE_DAY" });
  const metrics = (spend: unknown, conversion: unknown, extra: Record<string, unknown> = {}) =>
    ({ spend, impressions: "1000", clicks: "20", conversion, complete_payment: "2", total_complete_payment_rate: "180.5", value_per_complete_payment: "90.25", ...extra });
  let reportRows: Array<{ dimensions: Record<string, string>; metrics: Record<string, unknown> }>;
  const paths: string[] = [];

  beforeEach(() => {
    paths.length = 0;
    m.ensureAdAccounts.mockResolvedValue({ connected: true, accounts: [adv("111")], selected_id: "111", needs: "nothing", checked_at: "x" });
    reportRows = [
      { dimensions: { campaign_id: "1001" }, metrics: metrics("12.50", "1") },
      { dimensions: { campaign_id: "1002" }, metrics: metrics("90", "4") },
      { dimensions: { campaign_id: "1003" }, metrics: metrics(null, "0", { total_complete_payment_rate: "" }) },
    ];
    m.proxy.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
      paths.push(endpoint);
      if (endpoint.startsWith("/campaign/get/") && endpoint.includes("filtering")) return ok({ list: [campaign("1002", "Spring")] });
      if (endpoint.startsWith("/campaign/get/")) return ok({ list: [campaign("1001", "Small"), campaign("1002", "Spring"), campaign("1003", "Unknown spend"), campaign("1004", "Idle", "DISABLE", "CAMPAIGN_STATUS_DISABLE"), campaign("1005", "Gone", "DISABLE", "CAMPAIGN_STATUS_DELETE")] });
      if (endpoint.startsWith("/report/integrated/get/")) return ok({ list: reportRows, page_info: { page: 1, total_page: 1 } });
      throw new Error(`unexpected ${endpoint}`);
    });
  });

  it("sums the last 7 whole days per campaign, biggest spend first, unknown spend last, deleted left out", async () => {
    const e = await readTiktokAdsEvidence("tenant-a", now);
    expect(e).toMatchObject({ channel_slug: "tiktok_ads", status: "read", source: "TikTok Ads campaign report" });
    expect(e.campaigns!.map((c) => c.id)).toEqual(["1002", "1001", "1004", "1003"]);
    const report = decodeURIComponent(paths.find((p) => p.startsWith("/report/"))!);
    expect(report).toContain("advertiser_id=111");
    expect(report).toContain("data_level=AUCTION_CAMPAIGN");
    expect(report).toContain('["spend","impressions","clicks","conversion","complete_payment","total_complete_payment_rate","value_per_complete_payment"]');
    expect(report).toContain("start_date=2026-10-01&end_date=2026-10-07");
    expect(e.reporting_period).toBe("2026-10-01 through 2026-10-07 (America/Los_Angeles; requested dates)");
    expect(e.campaigns![0]).toMatchObject({ name: "Spring", objective: "WEB_CONVERSIONS", label: PAID_LABELS.trackingUnknown, reported: { currency: "USD", period_confirmed: true, spend: 90 } });
    expect(e.campaigns![0].reported!.metrics).toBe("spend 90, impressions 1000, clicks 20, conversions 4, website_purchases 2, website_purchase_value 180.5, value_per_website_purchase 90.25");
    expect(e.campaigns![2].reported!.metrics).toBe("spend 0, impressions 0, clicks 0, conversions 0, website_purchases 0, website_purchase_value 0, value_per_website_purchase 0");
  });

  it("a metric TikTok returned null or blank stays unknown, never 0", async () => {
    const e = await readTiktokAdsEvidence("tenant-a", now);
    const c3 = e.campaigns!.find((c) => c.id === "1003")!;
    expect(c3.reported!.metrics).toBe("impressions 1000, clicks 20, conversions 0, website_purchases 2, value_per_website_purchase 90.25");
    expect(c3.reported).not.toHaveProperty("spend");
  });

  it("a Composio failure is could-not-read, never zero", async () => {
    m.proxy.mockResolvedValue({ ok: false, status: 502, json: null });
    const read = await loadCgoEvidence({ tenant_id: "tenant-a", channelSlugs: ["tiktok_ads"], now, cardClass: "cgo" });
    expect(read.paid).toEqual([{ channel_slug: "tiktok_ads", status: "could not read", reason: "TikTok read failed (HTTP 502)." }]);
    m.proxy.mockResolvedValue(ok({ list: [], page_info: { total_page: 1 } }));
    m.proxy.mockResolvedValueOnce({ ok: true, status: 200, json: { code: 40001, message: "boom" } });
    expect((await loadCgoEvidence({ tenant_id: "tenant-a", channelSlugs: ["tiktok_ads"], now, cardClass: "cgo" })).paid[0].status).toBe("could not read");
  });

  it("never guesses between several accounts; uses the founder's pick; not connected says so", async () => {
    m.ensureAdAccounts.mockResolvedValue({ connected: true, accounts: [adv("111"), adv("222")], selected_id: null, needs: "pick", checked_at: "x" });
    expect(await readTiktokAdsEvidence("tenant-a", now)).toMatchObject({ status: "could not read", reason: expect.stringMatching(/Multiple/) });
    expect(m.proxy).not.toHaveBeenCalled();
    m.ensureAdAccounts.mockResolvedValue({ connected: true, accounts: [adv("111"), adv("222")], selected_id: "111", needs: "nothing", checked_at: "x" });
    expect((await readTiktokAdsEvidence("tenant-a", now)).reason).toContain("1 other saved account not read");
    m.ensureAdAccounts.mockResolvedValue({ connected: false, accounts: [], selected_id: null, needs: "nothing", checked_at: null });
    const off = await loadCgoEvidence({ tenant_id: "tenant-a", channelSlugs: ["tiktok_ads"], now, cardClass: "cgo" });
    expect(off.paid).toEqual([{ channel_slug: "tiktok_ads", status: "not connected" }]);
    const { ExpectedToolError } = await import("@/services/tools/types");
    m.honest.mockResolvedValue(new ExpectedToolError("tiktok_ads_connection_stopped", "TikTok Ads connection stopped working on Oct 15. Reconnect it."));
    expect(await readTiktokAdsEvidence("tenant-a", now)).toEqual({ channel_slug: "tiktok_ads", status: "could not read", reason: "TikTok Ads connection stopped working on Oct 15. Reconnect it." });
    m.ensureAdAccounts.mockResolvedValue({ connected: true, accounts: [adv("111")], selected_id: "111", needs: "nothing", checked_at: "x" });
    const comp = await import("@/services/connectors/composio/account");
    const resolve = vi.spyOn(comp, "resolveOwnedComposioAccount").mockResolvedValue(null);
    const cached = await loadCgoEvidence({ tenant_id: "tenant-a", channelSlugs: ["tiktok_ads"], now, cardClass: "cgo" });
    expect(cached.paid).toEqual([{ channel_slug: "tiktok_ads", status: "could not read", reason: "TikTok Ads connection stopped working on Oct 15. Reconnect it." }]);
    resolve.mockRestore();
  });

  it("falls back to UTC for an unknown time zone", () => {
    expect(tiktokWindow(now, "Not/AZone")).toEqual({ from: "2026-10-01", to: "2026-10-07", timezone: "UTC" });
  });

  describe("an Autopilot TikTok raise sees the object's own 7 days", () => {
    const raise = { kind: "ad" as const, exec_class: "tiktok_ads.update_budget", source: { table: "channel_actions" as const, id: "a1", run_id: "r1" },
      payload: { advertiser_id: "111", advertiser_name: "Adv 111", level: "campaign", object_id: "1002", campaign_id: "1002", name: "Spring", rationale: "r", origin: "specialist", expected_current_daily_budget_usd: 50, expected_current_status: "ACTIVE", daily_budget_usd: 60 } };
    const clear: UnattendedFacts = { refsResolved: true, openAdvice: "clear", goal: { present: true, numberTrusted: true }, spendUpUnderBudget: true, channelAutorun: true, trackingOk: null, founderSetBudget: false, zaviRaisedRecently: false };

    it("with evidence, it is judged by the Meta/Google rules", async () => {
      const facts = await loadUnattendedFacts("tenant-a", raise, { now });
      expect(facts.objects).toEqual([expect.objectContaining({ id: "1002", spend7dUsd: 90, conversions7d: 4, lockDays: 0 })]);
      expect(evaluateUnattended(raise, { ...clear, objects: facts.objects })).toEqual({ verdict: "allow", reasons: [], notes: ["tracking_unknown"] });
      expect(evaluateUnattended({ ...raise, payload: { ...raise.payload, daily_budget_usd: 500 } }, { ...clear, objects: facts.objects }).reasons).toContain("raise_over_cgo_step");
      expect(evaluateUnattended(raise, { ...clear, objects: facts.objects, zaviRaisedRecently: true }).reasons).toContain("raised_in_last_day");
    });

    it("with unreadable evidence, it goes to the founder", async () => {
      m.proxy.mockResolvedValue({ ok: false, status: 500, json: null });
      const facts = await loadUnattendedFacts("tenant-a", raise, { now });
      expect(facts.objects).toBeNull();
      expect(evaluateUnattended(raise, { ...clear, objects: facts.objects })).toEqual({ verdict: "ask_founder", reasons: ["ad_facts_unreadable"] });
      expect(evaluateUnattended(raise, facts).verdict).toBe("ask_founder");
    });

    it("a card on an account that is not a saved one, a non-USD account, or a null spend never reads as performance", async () => {
      expect(await loadTiktokObjects("tenant-a", { advertiser_id: "999", level: "campaign", object_id: "1002" }, now)).toBeNull();
      reportRows[1].metrics.spend = null;
      const [o] = (await loadTiktokObjects("tenant-a", { advertiser_id: "111", level: "campaign", object_id: "1002" }, now))!;
      expect(o).toMatchObject({ spend7dUsd: null, conversions7d: 4 });
      expect(evaluateUnattended(raise, { ...clear, objects: [o] })).toMatchObject({ verdict: "ask_founder", reasons: ["performance_unreadable"] });
      m.ensureAdAccounts.mockResolvedValue({ connected: true, accounts: [adv("111", "EUR")], selected_id: "111", needs: "nothing", checked_at: "x" });
      expect((await loadTiktokObjects("tenant-a", { advertiser_id: "111", level: "campaign", object_id: "1002" }, now))![0].spend7dUsd).toBeNull();
    });

    it("an ad-group card reads the ad-group report; an ad group with no row spent nothing", async () => {
      m.proxy.mockImplementation(async ({ endpoint }: { endpoint: string }) => {
        paths.push(endpoint);
        if (endpoint.startsWith("/adgroup/get/")) return ok({ list: [{ adgroup_id: "201", adgroup_name: "Group", campaign_id: "1002", operation_status: "ENABLE", budget: 30, budget_mode: "BUDGET_MODE_DAY" }] });
        if (endpoint.startsWith("/report/integrated/get/")) return ok({ list: [{ dimensions: { adgroup_id: "202" }, metrics: metrics("5", "1") }], page_info: { total_page: 1 } });
        throw new Error(`unexpected ${endpoint}`);
      });
      const objs = await loadTiktokObjects("tenant-a", { advertiser_id: "111", level: "ad_group", object_id: "201" }, now);
      expect(objs).toEqual([expect.objectContaining({ id: "201", spend7dUsd: 0, conversions7d: 0 })]);
      expect(decodeURIComponent(paths.find((p) => p.startsWith("/report/"))!)).toContain('data_level=AUCTION_ADGROUP&dimensions=["adgroup_id"]');
    });
  });
});
