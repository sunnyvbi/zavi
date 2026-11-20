import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const w = vi.hoisted(() => ({
  bindings: [] as Array<{ id: string; tenant_id: string }>,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  campaign: vi.fn(),
}));

vi.mock("@/services/connectors/linkedin-ads/client", () => ({
  listLinkedInAdAccounts: vi.fn(),
  listLinkedInCampaigns: vi.fn(),
  listLinkedInCampaignGroups: vi.fn(),
  readLinkedInCampaignGroupsByIdWithToken: vi.fn(),
  readLinkedInAdAnalytics: vi.fn(),
  readLinkedInAdAnalyticsWithToken: vi.fn(),
  readLinkedInCreatives: vi.fn(),
  readLinkedInCreativesWithToken: vi.fn(),
}));
vi.mock("@/services/ads-wallet/adapters/linkedin", () => ({ linkedinCampaign: w.campaign, goneLinkedinCampaignDates: async () => new Map() }));
const query = (table: string, source: Array<Record<string, unknown>>) => {
  let rows = source;
  const q: any = {
    select: () => q,
    order: () => q,
    eq: (field: string, value: unknown) => {
      rows = rows.filter((r) => !(field in r) || r[field] === value);
      return q;
    },
    in: (field: string, values: unknown[]) => {
      rows = rows.filter((r) => values.includes(r[field]));
      return q;
    },
    gte: () => q,
    lte: () => q,
    range: async () => ({ data: rows, error: null }),
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
  };
  return q;
};
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  globalClient: () => ({
    from: (table: string) => query(table, [{ platform: "linkedin", provider_account_id: MANAGED, credential_source: "platform", credential_tenant_id: null }, ...(w.tables[table] ?? [])]),
  }),
  tenantClient: () => ({
    from: (table: string) =>
      query(table, table === "ads_campaign_binding_details" ? [...w.bindings.map((b) => ({ platform: "linkedin", funding_source: "wallet", ...b })), ...(w.tables[table] ?? [])] : (w.tables[table] ?? [])),
  }),
}));

import {
  listLinkedInAdAccounts,
  listLinkedInCampaignGroups,
  readLinkedInCampaignGroupsByIdWithToken,
  listLinkedInCampaigns,
  readLinkedInAdAnalytics,
  readLinkedInAdAnalyticsWithToken,
  readLinkedInCreatives,
  readLinkedInCreativesWithToken,
} from "@/services/connectors/linkedin-ads/client";
import { build, type LinkedinAdsPayload } from "../linkedin-ads";

const MANAGED = "900";
const OWN = "559880687";
const accounts = vi.mocked(listLinkedInAdAccounts);
const campaigns = vi.mocked(listLinkedInCampaigns);
const groups = vi.mocked(listLinkedInCampaignGroups);
const walletGroups = vi.mocked(readLinkedInCampaignGroupsByIdWithToken);
const analytics = vi.mocked(readLinkedInAdAnalytics);
const walletAnalytics = vi.mocked(readLinkedInAdAnalyticsWithToken);
const creatives = vi.mocked(readLinkedInCreatives);
const walletCreatives = vi.mocked(readLinkedInCreativesWithToken);

const ctx = (tenantId: string) => ({ tenantId, rangeDays: 30, refresh: true, meteredRefresh: false }) as Parameters<typeof build>[0];
const group = (id: string, name: string, status = "ACTIVE") => ({ id, name, status, total_budget: null, run_start_at: null, run_end_at: null, last_modified_at: null, is_default: false });
const campaign = (id: string, campaign_group_id: string | null, name = `C${id}`) => ({ id, name, status: "ACTIVE", objective: null, budget: null, campaign_group_id });
const row = (id: string, over: Partial<{ spend: number; clicks: number; conversions: number; leads: number; conversion_value: number | null; missing_metrics: string[] }> = {}) => ({
  pivot: `urn:li:sponsoredCampaign:${id}`,
  impressions: 1000,
  clicks: 10,
  spend: 20,
  conversions: 1,
  leads: 2,
  conversion_value: 50,
  ...over,
});
const adopt = (tenant_id: string) => {
  w.tables.ads_account_binding_details = [{ id: `own-${OWN}`, tenant_id, platform: "linkedin", provider_account_id: OWN, funding_source: "provider" }];
  w.tables.ads_campaign_binding_details = [{ account_binding_id: `own-${OWN}`, tenant_id, platform: "linkedin", funding_source: "provider" }];
  w.tables.ads_account_selections = [{ account_binding_id: `own-${OWN}`, tenant_id, platform: "linkedin" }];
};

beforeEach(() => {
  vi.resetAllMocks();
  w.bindings = [];
  w.tables = {};
  accounts.mockResolvedValue([{ id: OWN, name: "Dev Account", currency: "USD", status: "ACTIVE" }]);
});

describe("the LinkedIn Ads dashboard groups ad sets under their campaign group", () => {
  it("must catch: every ad set carries its LinkedIn campaign group, and the group's numbers are the sum of its ad sets", async () => {
    adopt("t-groups");
    campaigns.mockResolvedValue([campaign("1", "5"), campaign("2", "5"), campaign("3", "6")]);
    groups.mockResolvedValue([group("5", "Spring launch"), group("6", "Always on")]);
    analytics.mockResolvedValue([row("1", { spend: 10, clicks: 4, conversions: 1, leads: 1, conversion_value: 30 }), row("2", { spend: 15, clicks: 6, conversions: 0, leads: 3, conversion_value: 20 }), row("3")]);
    const p = (await build(ctx("t-groups"))) as LinkedinAdsPayload;
    expect(p.campaigns.map((c) => [c.id, c.campaign_group?.id, c.campaign_group?.name])).toEqual([
      ["3", "6", "Always on"],
      ["2", "5", "Spring launch"],
      ["1", "5", "Spring launch"],
    ]);
    const spring = p.campaigns.filter((c) => c.campaign_group?.id === "5");
    const sum = (k: "spend" | "clicks" | "conversions" | "leads") => spring.reduce((t, c) => t + c[k], 0);
    expect([sum("spend"), sum("clicks"), sum("conversions"), sum("leads")]).toEqual([25, 10, 1, 4]);
    expect(spring.reduce((t, c) => t + (c.conversion_value ?? 0), 0)).toBe(50);
    expect(p.totals).toMatchObject({ spend: 45, clicks: 20, conversions: 2, leads: 6, conversion_value: 100 });
    expect(groups).toHaveBeenCalledWith("t-groups", OWN, 500);
    expect(analytics.mock.calls.every(([, , o]) => o.value === true)).toBe(true);
  });

  it("must catch: an ad set carries LinkedIn's daily budget, never a lifetime budget or one in another currency", async () => {
    adopt("t-budget");
    campaigns.mockResolvedValue([
      { ...campaign("1", "5"), budget: { amount: 25.5, currency: "USD", kind: "daily" as const } },
      { ...campaign("2", "5"), budget: { amount: 900, currency: "USD", kind: "lifetime" as const } },
      { ...campaign("3", "5"), budget: { amount: 30, currency: "EUR", kind: "daily" as const } },
      campaign("4", "5"),
    ]);
    groups.mockResolvedValue([group("5", "Spring launch")]);
    analytics.mockResolvedValue([row("1"), row("2"), row("3"), row("4")]);
    const p = (await build(ctx("t-budget"))) as LinkedinAdsPayload;
    expect(Object.fromEntries(p.campaigns.map((c) => [c.id, c.daily_budget]))).toEqual({ "1": 25.5, "2": null, "3": null, "4": null });
  });

  it("must catch: an ad set whose group is archived, unknown or unreadable has no group, so the page files it under Other", async () => {
    adopt("t-other");
    campaigns.mockResolvedValue([campaign("1", "5"), campaign("2", "7"), campaign("3", null)]);
    groups.mockResolvedValue([group("5", "Old push", "ARCHIVED")]);
    analytics.mockResolvedValue([row("1"), row("2"), row("3")]);
    const p = (await build(ctx("t-other"))) as LinkedinAdsPayload;
    expect(p.campaigns.map((c) => c.campaign_group)).toEqual([null, null, null]);
    expect(JSON.stringify(p)).not.toContain("Old push");
    groups.mockRejectedValue(new ExpectedToolError("linkedin_ads_rate_limited", "x"));
    const unread = (await build(ctx("t-other"))) as LinkedinAdsPayload;
    expect(unread.error_code).toBeNull();
    expect(unread.account_errors).toEqual([]);
    expect(unread.campaigns.map((c) => c.campaign_group)).toEqual([null, null, null]);
    expect(unread.totals).toMatchObject({ spend: 60 });
  });

  it("must catch: a conversion value LinkedIn left out stays unknown on the row and in the totals, never a zero", async () => {
    adopt("t-value");
    campaigns.mockResolvedValue([campaign("1", "5"), campaign("2", "5")]);
    groups.mockResolvedValue([group("5", "Spring launch")]);
    analytics.mockResolvedValue([row("1", { conversion_value: null, missing_metrics: ["conversion_value"] }), row("2", { conversion_value: 12.5 })]);
    const p = (await build(ctx("t-value"))) as LinkedinAdsPayload;
    expect(p.campaigns.find((c) => c.id === "1")?.conversion_value).toBeNull();
    expect(p.campaigns.find((c) => c.id === "2")?.conversion_value).toBe(12.5);
    expect(p.totals?.conversion_value).toBeNull();
    expect(p.totals?.leads).toBe(4);
  });

  it("must catch: wallet ad sets read their group names with the managed token on the managed account, and another workspace's group never shows", async () => {
    accounts.mockRejectedValue(new ExpectedToolError("linkedin_ads_not_connected", "x"));
    w.bindings = [{ id: "bind-mine", tenant_id: "t-wallet" }];
    w.campaign.mockImplementation(async (_t: string, id: string) => ({
      token: "managed-token",
      account: { id: MANAGED, name: "Zavi Managed", currency: "USD", status: "ACTIVE" },
      campaign: { id: id === "bind-mine" ? "111" : "222", name: "Mine via wallet", status: "ACTIVE", campaignGroup: "urn:li:sponsoredCampaignGroup:41" },
    }));
    walletGroups.mockImplementation(async (_t: string, _a: string, ids: readonly string[]) => [group("41", "My wallet group"), group("42", "Other tenant's group")].filter((g) => ids.includes(g.id)));
    walletAnalytics.mockResolvedValue([row("111", { spend: 25 }), row("222", { spend: 9000 })]);
    const p = (await build(ctx("t-wallet"))) as LinkedinAdsPayload;
    expect(walletGroups).toHaveBeenCalledTimes(1);
    expect(walletGroups).toHaveBeenCalledWith("managed-token", MANAGED, ["41"]);
    expect(groups).not.toHaveBeenCalled();
    expect(p.campaigns.map((c) => [c.id, c.campaign_group])).toEqual([["111", { id: "41", name: "My wallet group" }]]);
    expect(JSON.stringify(p)).not.toContain("Other tenant");
    expect(walletAnalytics.mock.calls.every(([, , o]) => o.value === true)).toBe(true);
    expect(p.totals).toMatchObject({ spend: 25, leads: 2, conversion_value: 50 });
  });

  it("must catch: the payload lists the account's campaign groups with their ad set counts and default flag, and the ads of its running ad sets from the one creatives read, never a wallet account's", async () => {
    adopt("t-rows");
    campaigns.mockResolvedValue([campaign("1", "5"), campaign("2", "5"), { ...campaign("3", "6"), status: "PAUSED" }, campaign("4", "8")]);
    groups.mockResolvedValue([
      { ...group("5", "Spring launch"), total_budget: { amount: 500, currency: "USD" }, run_end_at: "2026-12-31T23:59:59.000Z", is_default: false },
      { ...group("6", "Default Campaign Group", "PAUSED"), is_default: true },
      { ...group("8", "Old push", "ARCHIVED"), is_default: false },
    ]);
    analytics.mockResolvedValue([row("1"), row("2"), row("3"), row("4")]);
    creatives.mockResolvedValue([
      { id: "701", name: "Hero post", campaign_id: "1", intended_status: "ACTIVE", is_serving: true, hold_reasons: [], review_status: "APPROVED", created_at: null, last_modified_at: null },
      { id: "702", name: null, campaign_id: "1", intended_status: "PAUSED", is_serving: false, hold_reasons: ["CAMPAIGN_TOTAL_BUDGET_HOLD"], review_status: "PENDING", created_at: null, last_modified_at: null },
      { id: null, name: "No id", campaign_id: "2", intended_status: "ACTIVE", is_serving: true, hold_reasons: [], review_status: null, created_at: null, last_modified_at: null },
    ]);
    const p = (await build(ctx("t-rows"))) as LinkedinAdsPayload;
    expect(creatives).toHaveBeenCalledTimes(1);
    expect(creatives).toHaveBeenCalledWith("t-rows", OWN, ["1", "2", "4"]);
    expect(p.groups).toEqual([
      { id: "5", ad_account_id: OWN, name: "Spring launch", status: "ACTIVE", total_budget: { amount: 500, currency: "USD" }, run_end_at: "2026-12-31T23:59:59.000Z", is_default: false, campaign_count: 2 },
      { id: "6", ad_account_id: OWN, name: "Default Campaign Group", status: "PAUSED", total_budget: null, run_end_at: null, is_default: true, campaign_count: 1 },
    ]);
    expect(p.ads).toEqual([
      { id: "701", campaign_id: "1", ad_account_id: OWN, name: "Hero post", intended_status: "ACTIVE", is_serving: true, review_status: "APPROVED", hold_reasons: [] },
      { id: "702", campaign_id: "1", ad_account_id: OWN, name: "Ad 702", intended_status: "PAUSED", is_serving: false, review_status: "PENDING", hold_reasons: ["CAMPAIGN_TOTAL_BUDGET_HOLD"] },
    ]);
    expect(p.campaigns.find((c) => c.id === "1")).toMatchObject({ ad_delivery: "serving", ads_not_running: 0 });
    expect(p.campaigns.find((c) => c.id === "2")).toMatchObject({ ad_delivery: "serving" });
    expect(p.campaigns.find((c) => c.id === "4")).toMatchObject({ ad_delivery: "no_ads" });
  });

  it("must catch: a failed creatives read leaves the ads list empty and the delivery unread, and wallet ad sets add no group or ad rows", async () => {
    adopt("t-unread");
    campaigns.mockResolvedValue([campaign("1", "5")]);
    groups.mockResolvedValue([{ ...group("5", "Spring launch"), is_default: false }]);
    analytics.mockResolvedValue([row("1")]);
    creatives.mockRejectedValue(new Error("creatives read failed"));
    w.bindings = [{ id: "bind-mine", tenant_id: "t-unread" }];
    w.campaign.mockResolvedValue({
      token: "managed-token",
      account: { id: MANAGED, name: "Zavi Managed", currency: "USD", status: "ACTIVE" },
      campaign: { id: "111", name: "Mine via wallet", status: "ACTIVE", campaignGroup: "urn:li:sponsoredCampaignGroup:41" },
    });
    walletGroups.mockResolvedValue([{ ...group("41", "My wallet group"), is_default: false }]);
    walletAnalytics.mockResolvedValue([row("111")]);
    walletCreatives.mockResolvedValue([{ id: "901", name: "Wallet ad", campaign_id: "111", intended_status: "ACTIVE", is_serving: true, hold_reasons: [], review_status: "APPROVED", created_at: null, last_modified_at: null }]);
    const p = (await build(ctx("t-unread"))) as LinkedinAdsPayload;
    expect(p.campaigns.find((c) => c.id === "1")?.ad_delivery).toBe("unread");
    expect(p.campaigns.find((c) => c.id === "111")?.ad_delivery).toBe("serving");
    expect(p.ads).toEqual([]);
    expect(p.groups.map((g) => g.id)).toEqual(["5"]);
    expect(JSON.stringify(p.ads)).not.toContain("Wallet ad");
  });
});
