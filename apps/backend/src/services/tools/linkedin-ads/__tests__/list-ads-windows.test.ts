import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdAnalyticsRow, LinkedInCreative } from "@/services/connectors/linkedin-ads/client";

const SHARED = "900";
const m = vi.hoisted(() => ({
  wallet: false,
  ownList: vi.fn(),
  ownCreatives: vi.fn(),
  walletCreatives: vi.fn(),
  ownAnalytics: vi.fn(),
  walletAnalytics: vi.fn(),
  daily: vi.fn(),
  ownDaily: vi.fn(),
}));

vi.mock("@/services/tools/linkedin-ads/_wallet", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  linkedinAccountAccess: async (_t: string, account: string) =>
    m.wallet && account === SHARED
      ? { kind: "wallet", token: "managed-token", currency: "EUR", campaignUrns: ["urn:li:sponsoredCampaign:111"], group: { binding: { provider_account_id: SHARED }, campaignBindingIds: ["cb-1"], campaignIds: ["111"] } }
      : { kind: "own" },
}));
vi.mock("@/services/tools/linkedin-ads/list_campaigns", () => ({
  walletCampaigns: async () => [{ id: "111", name: "Mine", status: "ACTIVE", objective: "LEAD_GENERATION", budget: null, campaign_group_id: "77" }],
}));
vi.mock("@/services/connectors/linkedin-ads/client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listLinkedInCampaigns: (...a: unknown[]) => m.ownList(...a),
  listLinkedInAdAccounts: async () => [{ id: "500", name: "Own", currency: "INR", status: "ACTIVE" }],
  readLinkedInCreatives: (...a: unknown[]) => m.ownCreatives(...a),
  readLinkedInCreativesWithToken: (...a: unknown[]) => m.walletCreatives(...a),
  readLinkedInAdAnalytics: (...a: unknown[]) => m.ownAnalytics(...a),
  readLinkedInAdAnalyticsWithToken: (...a: unknown[]) => m.walletAnalytics(...a),
}));
vi.mock("@/services/connectors/linkedin-ads/daily", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLinkedInDailyAnalyticsWithToken: (...a: unknown[]) => m.daily(...a),
  readLinkedInDailyAnalytics: (...a: unknown[]) => m.ownDaily(...a),
}));

import { fatigueOf, fetchLinkedInAds, linkedinAdWindows, linkedinAdsListAdsTool, type LinkedInAdRow } from "../list_ads";

const creative = (id: string, campaign_id: string, over: Partial<LinkedInCreative> = {}): LinkedInCreative => ({
  id,
  name: `Ad ${id}`,
  campaign_id,
  intended_status: "ACTIVE",
  is_serving: true,
  hold_reasons: [],
  review_status: "APPROVED",
  created_at: "2026-10-01T00:00:00.000Z",
  last_modified_at: "2026-10-20T00:00:00.000Z",
  ...over,
});
const row = (id: string, over: Partial<AdAnalyticsRow> = {}): AdAnalyticsRow => ({
  pivot: `urn:li:sponsoredCreative:${id}`,
  impressions: 1800,
  reach: 900,
  clicks: 18,
  spend: 90,
  conversions: 1,
  leads: 1,
  missing_metrics: [],
  ...over,
});
const NOW = new Date("2026-11-04T10:00:00Z");
const ctx = { tenant_id: "t-a", log: () => undefined } as never;
type Out = { ads: LinkedInAdRow[]; fatigued: Array<{ ad_id: string }>; currency: string | null };

beforeEach(() => {
  m.wallet = false;
  for (const f of [m.ownList, m.ownCreatives, m.walletCreatives, m.ownAnalytics, m.walletAnalytics, m.daily, m.ownDaily]) f.mockReset();
  m.ownList.mockResolvedValue([
    { id: "1", name: "Healthy", status: "ACTIVE", objective: "WEBSITE_CONVERSIONS", budget: null, campaign_group_id: "9" },
    { id: "2", name: "Other", status: "ACTIVE", objective: "WEBSITE_CONVERSIONS", budget: null, campaign_group_id: "9" },
  ]);
  m.daily.mockResolvedValue({ rows: [], truncated: false, read_through: null, partial_reason: null });
  m.ownDaily.mockResolvedValue({ rows: [], truncated: false, read_through: null, partial_reason: null });
});

describe("linkedin_ads_list_ads finds the tired ad inside a healthy campaign", () => {
  it("must catch: frequency is each window's own impressions / reach from a whole-window creative read, never summed daily reach, and the tired ad is named while its campaign's CTR holds", async () => {
    m.ownCreatives.mockResolvedValue([creative("a1", "1"), creative("a2", "1", { name: null })]);
    m.ownAnalytics.mockImplementation(async (_t: string, _a: string, o: { start: { day: number }; end: { day: number } }) =>
      o.end.day === 4
        ? [row("a1", { impressions: 1800, reach: 900, clicks: 9 }), row("a2", { impressions: 1800, reach: 1800, clicks: 27 })]
        : [row("a1", { impressions: 1800, reach: 1500, clicks: 18 }), row("a2", { impressions: 1800, reach: 1800, clicks: 18 })],
    );
    const out = await fetchLinkedInAds("t-a", { account_id: "500", campaign_id: "1", recent_days: 7 }, NOW);
    expect(out.windows).toEqual({ recent: { since: "2026-10-29", until: "2026-11-04" }, prior: { since: "2026-10-22", until: "2026-10-28" } });
    expect(m.ownAnalytics).toHaveBeenCalledTimes(2);
    for (const call of m.ownAnalytics.mock.calls) expect(call[2]).toMatchObject({ pivot: "CREATIVE", reach: true, campaigns: ["urn:li:sponsoredCampaign:1"] });
    expect(m.ownDaily).not.toHaveBeenCalled();
    expect(m.daily).not.toHaveBeenCalled();
    const a1 = out.ads.find((a) => a.ad_id === "a1")!;
    expect(a1.windows.recent).toMatchObject({ frequency: 2, ctr_percent: 0.5, reach: 900 });
    expect(a1.windows.prior).toMatchObject({ frequency: 1.2, ctr_percent: 1, reach: 1500 });
    expect(a1.fatigue).toMatchObject({ verdict: "fatigued", ctr_change_percent: -50, impressions_change_percent: 0, frequency_change_percent: 66.67 });
    expect(a1.ad_name).toBe("Ad a1");
    const a2 = out.ads.find((a) => a.ad_id === "a2")!;
    expect(a2.ad_name).toBe("a2");
    expect(a2.fatigue.verdict).toBe("not_fatigued");
    expect(out.campaigns).toHaveLength(1);
    expect(out.campaigns[0]).toMatchObject({ campaign_id: "1", ads: 2, ctr_change_percent: 0 });
    expect(out.campaigns[0].windows.recent.ctr_percent).toBe(1);
    expect(out.currency).toBe("INR");
  });

  it("must catch: a shared wallet account is read with the managed token and only this workspace's creatives, never the founder's login", async () => {
    m.wallet = true;
    m.walletCreatives.mockResolvedValue([creative("w1", "111"), creative("x9", "222")]);
    m.walletAnalytics.mockResolvedValue([row("w1"), row("x9", { spend: 9000 })]);
    const out = (await linkedinAdsListAdsTool.execute(ctx, { account_id: SHARED, campaign_group_id: "77" })) as Out;
    expect(m.walletCreatives.mock.calls[0].slice(0, 3)).toEqual(["managed-token", SHARED, ["111"]]);
    expect(m.walletAnalytics).toHaveBeenCalledTimes(2);
    for (const call of m.walletAnalytics.mock.calls) {
      expect(call[0]).toBe("managed-token");
      expect(call[2]).toMatchObject({ campaigns: ["urn:li:sponsoredCampaign:111"] });
    }
    expect(m.ownList).not.toHaveBeenCalled();
    expect(m.ownCreatives).not.toHaveBeenCalled();
    expect(m.ownAnalytics).not.toHaveBeenCalled();
    expect(out.ads.map((a) => a.ad_id)).toEqual(["w1"]);
    expect(out.currency).toBe("EUR");
    expect(JSON.stringify(out)).not.toMatch(/lastModifiedBy|modified_by|urn:li:person/);
  });

  it("a window LinkedIn left reach out of has null frequency and the verdict is insufficient, never a number made from zero", async () => {
    m.ownCreatives.mockResolvedValue([creative("a1", "1")]);
    m.ownAnalytics.mockImplementation(async (_t: string, _a: string, o: { end: { day: number } }) => (o.end.day === 4 ? [row("a1", { reach: null, missing_metrics: ["reach"] })] : [row("a1")]));
    const out = await fetchLinkedInAds("t-a", { account_id: "500", campaign_id: "1", recent_days: 7 }, NOW);
    expect(out.ads[0].windows.recent).toMatchObject({ reach: null, frequency: null, missing_metrics: ["reach"] });
    expect(out.ads[0].fatigue.verdict).toBe("insufficient");
    expect(out.ads[0].fatigue.frequency_change_percent).toBeNull();
  });

  it("fatigue needs both signals: falling CTR on rising frequency, and thin delivery or a missing window is insufficient", () => {
    const w = (impressions: number, reach: number, clicks: number) => ({ since: "", until: "", spend: 1, impressions, reach, frequency: impressions / reach, clicks, ctr_percent: (clicks / impressions) * 100, conversions: 0, leads: 0, missing_metrics: [] });
    expect(fatigueOf(w(2000, 1000, 10), w(2000, 1000, 20)).verdict).toBe("not_fatigued");
    expect(fatigueOf(w(2000, 800, 10), w(2000, 1000, 20)).verdict).toBe("fatigued");
    expect(fatigueOf(w(1000, 400, 10), w(2000, 1000, 20)).verdict).toBe("not_fatigued");
    expect(fatigueOf(w(500, 200, 1), w(2000, 1000, 20)).verdict).toBe("insufficient");
    expect(fatigueOf(w(2000, 800, 10), null).verdict).toBe("insufficient");
    expect(linkedinAdWindows(3, NOW)).toEqual({ recent: { since: "2026-11-02", until: "2026-11-04" }, prior: { since: "2026-10-30", until: "2026-11-01" } });
  });

  it("refuses an unscoped read of every ad in the account", async () => {
    await expect(linkedinAdsListAdsTool.execute(ctx, { account_id: "500" })).rejects.toThrow(/campaign_id or campaign_group_id/);
    expect(m.ownAnalytics).not.toHaveBeenCalled();
  });
});
