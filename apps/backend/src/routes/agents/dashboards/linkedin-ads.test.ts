import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const w = vi.hoisted(() => ({
  bindings: [] as Array<{ id: string; tenant_id: string }>,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  failing: new Set<string>(),
  scopes: [] as unknown[][],
  managed: [] as string[],
  globalScopes: [] as unknown[][],
  campaign: vi.fn(),
  gone: vi.fn(),
}));

vi.mock("@/services/connectors/linkedin-ads/client", () => ({
  listLinkedInAdAccounts: vi.fn(),
  listLinkedInCampaigns: vi.fn(),
  listLinkedInCampaignGroups: vi.fn(),
  readLinkedInAdAnalytics: vi.fn(),
  readLinkedInAdAnalyticsWithToken: vi.fn(),
  readLinkedInCreatives: vi.fn(),
  readLinkedInCreativesWithToken: vi.fn(),
}));
vi.mock("@/services/ads-wallet/adapters/linkedin", () => ({ linkedinCampaign: w.campaign, goneLinkedinCampaignDates: w.gone }));
const query = (table: string, source: Array<Record<string, unknown>>, log: (f: unknown[]) => void) => {
  let rows = source;
  const result = () => (w.failing.has(table) ? { data: null, error: { message: "down" } } : { data: rows, error: null });
  const q: any = {
    select: () => q,
    order: () => q,
    eq: (field: string, value: unknown) => {
      log([field, value]);
      rows = rows.filter((r) => !(field in r) || r[field] === value);
      return q;
    },
    in: (field: string, values: unknown[]) => {
      log([field, "in", values]);
      rows = rows.filter((r) => values.includes(r[field]));
      return q;
    },
    gte: (field: string, value: string) => {
      rows = rows.filter((r) => String(r[field]) >= value);
      return q;
    },
    lte: (field: string, value: string) => {
      rows = rows.filter((r) => String(r[field]) <= value);
      return q;
    },
    range: async () => result(),
    maybeSingle: async () => {
      const r = result();
      return { ...r, data: r.data ? (r.data[0] ?? null) : null };
    },
  };
  return q;
};
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  globalClient: () => ({
    from: (table: string) =>
      query(
        table,
        [
          ...w.managed.map((provider_account_id) => ({ platform: "linkedin", provider_account_id, credential_source: "platform", credential_tenant_id: null })),
          ...(w.tables[table] ?? []),
        ],
        (f) => w.globalScopes.push([table, ...f]),
      ),
  }),
  tenantClient: (tenant: string) => ({
    from: (table: string) =>
      query(
        table,
        table === "ads_campaign_binding_details"
          ? [...w.bindings.map((b) => ({ platform: "linkedin", funding_source: "wallet", ...b })), ...(w.tables[table] ?? [])]
          : (w.tables[table] ?? []),
        (f) => w.scopes.push([tenant, table, ...f]),
      ),
  }),
}));

import {
  listLinkedInAdAccounts,
  listLinkedInCampaignGroups,
  listLinkedInCampaigns,
  readLinkedInAdAnalytics,
  readLinkedInAdAnalyticsWithToken,
  readLinkedInCreatives,
  readLinkedInCreativesWithToken,
} from "@/services/connectors/linkedin-ads/client";
import { LINKEDIN_ADS_DAILY_LIMIT } from "@/services/connectors/linkedin-ads/http";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { build, type LinkedinAdsPayload } from "./linkedin-ads";

const accounts = vi.mocked(listLinkedInAdAccounts);
const campaigns = vi.mocked(listLinkedInCampaigns);
const analytics = vi.mocked(readLinkedInAdAnalytics);
const walletAnalytics = vi.mocked(readLinkedInAdAnalyticsWithToken);
const adStates = vi.mocked(readLinkedInCreatives);
const groups = vi.mocked(listLinkedInCampaignGroups);
const walletAdStates = vi.mocked(readLinkedInCreativesWithToken);

const ctx = (tenantId: string) =>
  ({ tenantId, rangeDays: 30, refresh: true, meteredRefresh: false }) as Parameters<typeof build>[0];

const row = (campaignId: string, over: Partial<{ spend: number; impressions: number; clicks: number; conversions: number; leads: number }> = {}) => ({
  pivot: `urn:li:sponsoredCampaign:${campaignId}`,
  impressions: 1000,
  clicks: 50,
  spend: 100,
  conversions: 4,
  leads: 0,
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  w.bindings = [];
  w.tables = {};
  w.failing = new Set();
  w.scopes = [];
  w.managed = [MANAGED];
  w.globalScopes = [];
  w.gone.mockResolvedValue(new Map());
});

const MANAGED = "900";
const managedCampaign = (bindingId: string) => {
  const byBinding: Record<string, { id: string; name: string }> = {
    "bind-mine": { id: "111", name: "Mine via wallet" },
    "bind-theirs": { id: "222", name: "Other tenant" },
  };
  const [, acct, n] = bindingId.split("-");
  const c = byBinding[bindingId] ?? { id: `${acct}${n}`, name: `Wallet ${acct}/${n}` };
  return {
    token: "managed-token",
    account: { id: byBinding[bindingId] ? MANAGED : acct, name: "Zavi Managed", currency: "USD", status: "ACTIVE" },
    campaign: { ...c, status: "ACTIVE" },
  };
};
const sharedAccountRows = [
  row("111", { spend: 25, clicks: 10, impressions: 500, conversions: 1 }),
  row("222", { spend: 9000, clicks: 900, impressions: 90000, conversions: 90 }),
];

const adopt = (tenant_id: string, ...ids: string[]) => {
  w.tables.ads_account_binding_details = ids.map((id) => ({ id: `own-${id}`, tenant_id, platform: "linkedin", provider_account_id: id, funding_source: "provider" }));
  w.tables.ads_campaign_binding_details = ids.map((id) => ({ account_binding_id: `own-${id}`, tenant_id, platform: "linkedin", funding_source: "provider" }));
  w.tables.ads_account_selections = [{ account_binding_id: `own-${ids[0]}`, tenant_id, platform: "linkedin" }];
};

describe("linkedin_ads dashboard builder", () => {
  it("not connected → connected:false, no error", async () => {
    accounts.mockRejectedValue(new ExpectedToolError("linkedin_ads_not_connected", "x"));
    const p = (await build(ctx("t-disc"))) as LinkedinAdsPayload;
    expect(p.connected).toBe(false);
    expect(p.error_code).toBeNull();
    expect(p.totals).toBeNull();
  });

  it("a founder with no LinkedIn connection whose wallet campaigns cannot be read is told to connect, not shown as connected", async () => {
    accounts.mockRejectedValue(new ExpectedToolError("linkedin_ads_not_connected", "x"));
    w.bindings = [{ id: "bind-mine", tenant_id: "t-nowallet" }];
    w.campaign.mockRejectedValue(new ExpectedToolError("ads_credentials_unavailable", "x"));
    const p = (await build(ctx("t-nowallet"))) as LinkedinAdsPayload;
    expect(p).toMatchObject({ connected: false, own_connected: false, wallet_error_code: "linkedin_ads_wallet_read_failed", totals: null, campaigns: [] });
  });

  it("a founder with no LinkedIn connection whose wallet list read fails outright is told to connect", async () => {
    accounts.mockRejectedValue(new ExpectedToolError("linkedin_ads_not_connected", "x"));
    w.failing.add("ads_campaign_binding_details");
    const p = (await build(ctx("t-nolist"))) as LinkedinAdsPayload;
    expect(p).toMatchObject({ connected: false, own_connected: false, totals: null });
  });

  it("a founder whose own LinkedIn is connected says so alongside wallet campaigns", async () => {
    adopt("t-mine", "559880687");
    accounts.mockResolvedValue([{ id: "559880687", name: "Dev Account", currency: "USD", status: "ACTIVE" }]);
    campaigns.mockResolvedValue([]);
    w.bindings = [{ id: "bind-mine", tenant_id: "t-mine" }];
    w.campaign.mockImplementation(async (_t: string, id: string) => managedCampaign(id));
    walletAnalytics.mockResolvedValue(sharedAccountRows);
    const p = (await build(ctx("t-mine"))) as LinkedinAdsPayload;
    expect(p).toMatchObject({ connected: true, own_connected: true });
  });

  it("other expected error → connected with its code", async () => {
    accounts.mockRejectedValue(new ExpectedToolError("linkedin_ads_forbidden", "x"));
    const p = (await build(ctx("t-403"))) as LinkedinAdsPayload;
    expect(p.connected).toBe(true);
    expect(p.error_code).toBe("linkedin_ads_forbidden");
  });

  it("joins campaigns to analytics by pivot urn and derives ctr/cpc/cpa", async () => {
    adopt("t-live", "559880687");
    accounts.mockResolvedValue([{ id: "559880687", name: "Dev Account", currency: "USD", status: "ACTIVE" }]);
    campaigns.mockResolvedValue([
      { id: "1", name: "Alpha", status: "ACTIVE", objective: null, budget: null, campaign_group_id: null },
      { id: "2", name: "Old", status: "ARCHIVED", objective: null, budget: null, campaign_group_id: null },
    ]);
    analytics
      .mockResolvedValueOnce([row("1")])
      .mockResolvedValueOnce([row("1", { spend: 40, clicks: 20, impressions: 400, conversions: 0 })]);
    const p = (await build(ctx("t-live"))) as LinkedinAdsPayload;
    expect(p.connected).toBe(true);
    expect(p.account).toMatchObject({ id: "559880687", name: "Dev Account", account_count: 1, campaign_count: 1, active_count: 1, currency: "USD" });
    expect(p.campaigns.map((c) => c.id)).toEqual(["1"]);
    expect(p.campaigns[0]).toMatchObject({ spend: 100, impressions: 1000, clicks: 50, conversions: 4, cpa: 25 });
    expect(p.campaigns[0].url).toContain("campaignmanager/accounts/559880687");
    expect(p.totals).toEqual({ spend: 100, impressions: 1000, clicks: 50, conversions: 4, leads: 0, conversion_value: null, ctr: 5, cpc: 2, cpa: 25 });
    expect(p.prev_totals).toMatchObject({ spend: 40, clicks: 20, cpa: null });
  });

  it("counts website conversions only, as Campaign Manager's Conversions column does, so Lead Gen form leads do not inflate conversions or lower cost per conversion", async () => {
    adopt("t-leads", "559880687");
    accounts.mockResolvedValue([{ id: "559880687", name: "Dev Account", currency: "USD", status: "ACTIVE" }]);
    campaigns.mockResolvedValue([
      { id: "1", name: "Lead form", status: "ACTIVE", objective: "LEAD_GENERATION", budget: null, campaign_group_id: null },
      { id: "2", name: "Site", status: "ACTIVE", objective: "WEBSITE_CONVERSION", budget: null, campaign_group_id: null },
    ]);
    analytics
      .mockResolvedValueOnce([
        row("1", { spend: 60, conversions: 0, leads: 6 }),
        row("2", { spend: 40, conversions: 2, leads: 0 }),
      ])
      .mockResolvedValueOnce([row("1", { spend: 30, conversions: 0, leads: 3 })]);
    const p = (await build(ctx("t-leads"))) as LinkedinAdsPayload;
    const lead = p.campaigns.find((c) => c.id === "1")!;
    expect(lead).toMatchObject({ conversions: 0, cpa: null });
    expect(p.campaigns.find((c) => c.id === "2")).toMatchObject({ conversions: 2, cpa: 20 });
    expect(p.totals).toMatchObject({ spend: 100, conversions: 2, cpa: 50 });
    expect(p.prev_totals).toMatchObject({ conversions: 0, cpa: null });
  });

  it("shows only this tenant's wallet-funded campaigns from the shared managed account", async () => {
    accounts.mockRejectedValue(new ExpectedToolError("linkedin_ads_not_connected", "x"));
    w.bindings = [
      { id: "bind-mine", tenant_id: "t-wallet" },
      { id: "bind-theirs", tenant_id: "t-other" },
    ];
    w.campaign.mockImplementation(async (_t: string, id: string) => managedCampaign(id));
    walletAnalytics.mockResolvedValue(sharedAccountRows);
    const p = (await build(ctx("t-wallet"))) as LinkedinAdsPayload;
    expect(p.connected).toBe(true);
    expect(p.own_connected).toBe(false);
    expect(p.error_code).toBeNull();
    expect(p.campaigns.map((c) => c.id)).toEqual(["111"]);
    expect(p.campaigns[0]).toMatchObject({
      name: "Mine via wallet",
      funding_source: "wallet",
      ad_account_id: null,
      url: null,
      spend: 25,
      clicks: 10,
      conversions: 1,
    });
    expect(p.totals).toMatchObject({ spend: 25, clicks: 10, impressions: 500, conversions: 1 });
    expect(p.prev_totals).toMatchObject({ spend: 25 });
    expect(p.account).toMatchObject({ id: null, name: "Zavi ads wallet", account_count: 1, currency: "USD" });
    expect(w.campaign.mock.calls.map((c) => c[1])).toEqual(["bind-mine"]);
    expect(w.campaign.mock.calls.every((c) => c[0] === "t-wallet")).toBe(true);
    expect(w.scopes).toEqual(
      expect.arrayContaining([
        ["t-wallet", "ads_campaign_binding_details", "platform", "linkedin"],
        ["t-wallet", "ads_campaign_binding_details", "funding_source", "wallet"],
      ]),
    );
    expect(walletAnalytics).toHaveBeenCalledTimes(2);
    for (const call of walletAnalytics.mock.calls) {
      expect(call[0]).toBe("managed-token");
      expect(call[1]).toBe(MANAGED);
      expect(call[2].campaigns).toEqual(["urn:li:sponsoredCampaign:111"]);
    }
    expect(campaigns).not.toHaveBeenCalled();
    expect(analytics).not.toHaveBeenCalled();
  });

  it("adds wallet campaigns to the founder's own account in totals and rows", async () => {
    adopt("t-both", "559880687");
    accounts.mockResolvedValue([{ id: "559880687", name: "Dev Account", currency: "USD", status: "ACTIVE" }]);
    campaigns.mockResolvedValue([{ id: "1", name: "Own", status: "ACTIVE", objective: null, budget: null, campaign_group_id: null }]);
    analytics.mockResolvedValueOnce([row("1")]).mockResolvedValueOnce([row("1", { spend: 40 })]);
    w.bindings = [{ id: "bind-mine", tenant_id: "t-both" }];
    w.campaign.mockImplementation(async (_t: string, id: string) => managedCampaign(id));
    walletAnalytics.mockResolvedValue(sharedAccountRows);
    const p = (await build(ctx("t-both"))) as LinkedinAdsPayload;
    expect(p.campaigns.map((c) => [c.id, c.funding_source])).toEqual([
      ["1", "provider"],
      ["111", "wallet"],
    ]);
    expect(p.totals).toMatchObject({ spend: 125, clicks: 60, impressions: 1500, conversions: 5 });
    expect(p.prev_totals).toMatchObject({ spend: 65 });
    expect(p.account).toMatchObject({ id: "559880687", account_count: 2, campaign_count: 2, active_count: 2, currency: "USD" });
  });

  it("names the founder's own account only when there is exactly one, campaigns or not", async () => {
    accounts.mockResolvedValue([{ id: "559880687", name: "Dev Account", currency: "USD", status: "ACTIVE" }]);
    campaigns.mockResolvedValue([]);
    analytics.mockResolvedValue([]);
    adopt("t-empty", "559880687");
    const empty = (await build(ctx("t-empty"))) as LinkedinAdsPayload;
    expect(empty.campaigns).toEqual([]);
    expect(empty.account?.id).toBe("559880687");

    accounts.mockResolvedValue([
      { id: "559880687", name: "Dev Account", currency: "USD", status: "ACTIVE" },
      { id: "559880688", name: "Second", currency: "USD", status: "ACTIVE" },
    ]);
    adopt("t-two", "559880687", "559880688");
    const two = (await build(ctx("t-two"))) as LinkedinAdsPayload;
    expect(two.account).toMatchObject({ account_count: 1, id: "559880687" });
    expect(campaigns.mock.calls.map(([, id]) => id)).not.toContain("559880688");
  });

  it("a wallet campaign that cannot be read drops only that campaign and keeps own and other wallet rows", async () => {
    adopt("t-fail", "559880687");
    accounts.mockResolvedValue([{ id: "559880687", name: "Dev Account", currency: "USD", status: "ACTIVE" }]);
    campaigns.mockResolvedValue([{ id: "1", name: "Own", status: "ACTIVE", objective: null, budget: null, campaign_group_id: null }]);
    analytics.mockResolvedValue([row("1")]);
    w.bindings = [
      { id: "bind-mine", tenant_id: "t-fail" },
      { id: "bind-broken", tenant_id: "t-fail" },
    ];
    w.campaign.mockImplementation(async (_t: string, id: string) => {
      if (id === "bind-broken") throw new ExpectedToolError("ads_credentials_unavailable", "x");
      return managedCampaign(id);
    });
    walletAnalytics.mockResolvedValue(sharedAccountRows);
    const p = (await build(ctx("t-fail"))) as LinkedinAdsPayload;
    expect(p.connected).toBe(true);
    expect(p.error_code).toBeNull();
    expect(p.wallet_error_code).toBe("linkedin_ads_wallet_read_failed");
    expect(p.campaigns.map((c) => [c.id, c.funding_source])).toEqual([
      ["1", "provider"],
      ["111", "wallet"],
    ]);
    expect(p.totals).toMatchObject({ spend: 125, clicks: 60, impressions: 1500 });
  });

  describe("a wallet campaign LinkedIn no longer has", () => {
    const today = new Date();
    const daysAgo = (n: number) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - n)).toISOString().slice(0, 10);
    const spend = (tenant_id: string, object_id: string, ago: number, amount_usd: number | string, account_id: string | null = "901") => ({ tenant_id, platform: "linkedin", source: "api", account_id, object_id, spend_date: daysAgo(ago), amount_usd });

    beforeEach(() => {
      w.bindings = [
        { id: "bind-901-1", tenant_id: "t-gone" },
        { id: "bind-gone", tenant_id: "t-gone" },
      ];
      w.gone.mockResolvedValue(new Map([["bind-gone", daysAgo(2)]]));
      w.campaign.mockImplementation(async (_t: string, id: string) => {
        if (id === "bind-gone") throw new ExpectedToolError("linkedin_ads_http_error", "404", { status: 404 });
        return managedCampaign(id);
      });
      walletAnalytics.mockResolvedValue([row("9011", { spend: 50, clicks: 10, impressions: 100, conversions: 2 })]);
      accounts.mockRejectedValue(new ExpectedToolError("linkedin_ads_not_connected", "x"));
    });

    it("never asks LinkedIn for it, sets no wallet error, and counts its recorded spend in Spend, CPC, CPA and an other-campaigns row alike", async () => {
      w.tables.ad_spend_daily = [spend("t-gone", "bind-gone", 3, "30.50"), spend("t-gone", "bind-gone", 4, 9.5), spend("t-gone", "bind-gone", 40, 7), spend("t-gone", "bind-gone", 90, 1000), spend("t-other", "bind-gone", 3, 500), spend("t-gone", "bind-901-1", 3, 700)];
      const p = (await build(ctx("t-gone"))) as LinkedinAdsPayload;
      expect(w.campaign.mock.calls.map((c) => c[1])).toEqual(["bind-901-1"]);
      expect(p.wallet_error_code).toBeNull();
      expect(p.error_code).toBeNull();
      expect(p.totals).toMatchObject({ spend: 90, clicks: 10, conversions: 2, cpc: 9, cpa: 45 });
      expect(p.prev_totals).toMatchObject({ spend: 57, cpc: 5.7, cpa: 28.5 });
      expect(p.campaigns.map((c) => c.id)).toEqual(["9011"]);
      expect(p.other_campaigns).toEqual([{ kind: "removed", name: "Campaigns no longer in LinkedIn", currency: "USD", spend: 40, impressions: null, clicks: null, conversions: null, leads: null, conversion_value: null, cpa: null }]);
      expect(p.campaigns.reduce((t, c) => t + c.spend, 0) + p.other_campaigns.reduce((t, c) => t + c.spend, 0)).toBe(p.totals?.spend);
      expect((p.totals?.spend ?? 0) / (p.totals?.conversions ?? 1)).toBe(p.totals?.cpa);
    });

    it("only a gone campaign left: the tiles have its recorded spend and there is no error", async () => {
      w.bindings = [{ id: "bind-gone", tenant_id: "t-gone" }];
      w.tables.ad_spend_daily = [spend("t-gone", "bind-gone", 3, 40)];
      const p = (await build(ctx("t-gone"))) as LinkedinAdsPayload;
      expect(p).toMatchObject({ connected: true, error_code: null, wallet_error_code: null, totals: { spend: 40 }, account: { currency: "USD" } });
      expect(walletAnalytics).not.toHaveBeenCalled();
    });

    it("only a gone campaign with no spend in either period: the KPI tiles stay at zero with no error", async () => {
      w.bindings = [{ id: "bind-gone", tenant_id: "t-gone" }];
      const p = (await build(ctx("t-gone"))) as LinkedinAdsPayload;
      expect(p.error_code).toBeNull();
      expect(p.wallet_error_code ?? null).toBeNull();
      expect(w.campaign).not.toHaveBeenCalled();
      expect(p.connected).toBe(true);
      expect(p.totals).toMatchObject({ spend: 0, impressions: 0, clicks: 0 });
      expect(p.prev_totals).toMatchObject({ spend: 0 });
      expect(p.account).toMatchObject({ currency: "USD", campaign_count: 0 });
    });

    describe("its spend is one period row dated the start of the budget month", () => {
      const monthRow = (day: string, usd: number) => ({ tenant_id: "t-gone", platform: "linkedin", source: "api", account_id: "901", object_id: "bind-gone", spend_date: day, amount_usd: usd, provisional: true });
      beforeEach(() => {
        w.bindings = [{ id: "bind-gone", tenant_id: "t-gone" }];
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it.each([
        [7, "2026-10-28", 0, 0, 120, 120],
        [14, "2026-10-28", 0, 0, 120, 120],
        [30, "2026-10-28", 120, 0, 0, 0],
        [7, "2026-10-20", 0, 0, 0, 120],
        [14, "2026-10-20", 0, 0, 120, 120],
        [30, "2026-10-20", 120, 0, 0, 0],
        [7, "2026-10-05", 0, 0, 0, 0],
      ])("a %i day range with the campaign deleted on %s counts the month's total only in a window that holds all of its days, and names what it left out", async (rangeDays, goneOn, now, before, leftNow, leftBefore) => {
        w.gone.mockResolvedValue(new Map([["bind-gone", goneOn]]));
        w.tables.ad_spend_daily = [monthRow("2026-10-01", 120)];
        const p = (await build({ ...ctx("t-gone"), rangeDays, refresh: true })) as LinkedinAdsPayload;
        expect(p.totals?.spend).toBe(now);
        expect(p.prev_totals?.spend).toBe(before);
        expect(p.left_out_spend).toEqual({ now: leftNow, before: leftBefore });
      });

      it("a month's total that straddles the window is left out of both periods rather than dumped into the one holding the stop date", async () => {
        vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
        w.gone.mockResolvedValue(new Map([["bind-gone", "2026-10-30"]]));
        w.tables.ad_spend_daily = [monthRow("2026-10-01", 120), monthRow("2026-11-01", 5)];
        const p = (await build({ ...ctx("t-gone"), rangeDays: 7, refresh: true })) as LinkedinAdsPayload;
        expect(p.totals?.spend).toBe(5);
        expect(p.prev_totals?.spend).toBe(0);
        expect(p.left_out_spend).toEqual({ now: 120, before: 120 });
      });
    });

    it("must catch: a live campaign that really fails still sets the wallet error next to a gone one", async () => {
      w.bindings = [{ id: "bind-gone", tenant_id: "t-gone" }, { id: "bind-broken", tenant_id: "t-gone" }];
      w.campaign.mockRejectedValue(new ExpectedToolError("ads_credentials_unavailable", "x"));
      const p = (await build(ctx("t-gone"))) as LinkedinAdsPayload;
      expect(p.wallet_error_code).toBe("linkedin_ads_wallet_read_failed");
    });

    it("must catch: unreadable gone marks or unreadable recorded spend are a wallet read failure, never a silent drop of money", async () => {
      w.gone.mockRejectedValueOnce(new Error("Campaign operation state is unavailable"));
      expect(((await build(ctx("t-gone"))) as LinkedinAdsPayload).wallet_error_code).toBe("linkedin_ads_wallet_read_failed");
      w.campaign.mockImplementation(async (_t: string, id: string) => managedCampaign(id));
      w.failing = new Set(["ad_spend_daily"]);
      expect(((await build(ctx("t-gone"))) as LinkedinAdsPayload).wallet_error_code).toBe("linkedin_ads_wallet_read_failed");
    });
  });

  describe("an account that spends nothing in the period", () => {
    const acct = (id: string, status: string, currency: string) => ({ id, name: `Account ${id}`, currency, status });
    const USD = "101";
    const EUR = "102";
    beforeEach(() => {
      w.managed = [];
      adopt("t-cur", USD, EUR);
      accounts.mockResolvedValue([acct(USD, "ACTIVE", "USD"), acct(EUR, "CANCELED", "EUR")]);
      campaigns.mockImplementation(async (_t, id) => [{ id: `${id}1`, name: `C ${id}`, status: id === EUR ? "PAUSED" : "ACTIVE", objective: null, budget: null, campaign_group_id: null }]);
    });
    const spending = (now: Record<string, number>, before: Record<string, number> = {}) => {
      analytics.mockImplementation(async (_t, id, opts) => {
        const { start } = opts as { start: { year: number; month: number; day: number } };
        const windowIsNow = Date.UTC(start.year, start.month - 1, start.day) > Date.now() - 31 * 86_400_000;
        const value = (windowIsNow ? now : before)[id];
        return value === undefined ? [] : [row(`${id}1`, { spend: value, clicks: 10, conversions: 2 })];
      });
    };

    it("the account in use names the currency, and a stopped account on the login with this workspace's campaigns on an unselected binding is never read", async () => {
      spending({ [USD]: 100 }, { [USD]: 80 });
      const p = (await build(ctx("t-cur"))) as LinkedinAdsPayload;
      expect(p.account).toMatchObject({ account_count: 1, currency: "USD" });
      expect(p.totals).toMatchObject({ spend: 100, cpc: 10, cpa: 50 });
      expect(p.prev_totals).toMatchObject({ spend: 80 });
      expect(campaigns.mock.calls.map(([, id]) => id)).toEqual([USD]);
    });

    it("must catch: spend on the unselected account in another currency never clouds the single currency", async () => {
      spending({ [USD]: 100, [EUR]: 5 });
      const p = (await build(ctx("t-cur"))) as LinkedinAdsPayload;
      expect(p.account?.currency).toBe("USD");
      expect(p.totals).toMatchObject({ spend: 100 });
      expect(analytics.mock.calls.every(([, id]) => id === USD)).toBe(true);
    });

    it("nobody spent at all: the account in use still names the currency", async () => {
      analytics.mockResolvedValue([]);
      const p = (await build(ctx("t-cur"))) as LinkedinAdsPayload;
      expect(p.account?.currency).toBe("USD");
      expect(p.totals).toMatchObject({ spend: 0 });
    });
  });

  it("a failed analytics read on one managed account keeps own rows and the other account's wallet rows", async () => {
    adopt("t-acct", "559880687");
    accounts.mockResolvedValue([{ id: "559880687", name: "Dev Account", currency: "USD", status: "ACTIVE" }]);
    campaigns.mockResolvedValue([{ id: "1", name: "Own", status: "ACTIVE", objective: null, budget: null, campaign_group_id: null }]);
    analytics.mockResolvedValue([row("1")]);
    w.bindings = [
      { id: "bind-901-1", tenant_id: "t-acct" },
      { id: "bind-902-1", tenant_id: "t-acct" },
    ];
    w.campaign.mockImplementation(async (_t: string, id: string) => managedCampaign(id));
    walletAnalytics.mockImplementation(async (_tok, acct) => {
      if (acct === "902") throw new ExpectedToolError("linkedin_ads_rate_limited", "x");
      return [row("9011", { spend: 7 })];
    });
    const p = (await build(ctx("t-acct"))) as LinkedinAdsPayload;
    expect(p.error_code).toBeNull();
    expect(p.wallet_error_code).toBe("linkedin_ads_wallet_rate_limited");
    expect(p.campaigns.map((c) => c.id).sort()).toEqual(["1", "9011"]);
    expect(p.totals).toMatchObject({ spend: 107 });
  });

  it("a tenant whose own connected account is the managed account never sees another tenant's campaign", async () => {
    accounts.mockResolvedValue([{ id: MANAGED, name: "Zavi Managed", currency: "USD", status: "ACTIVE" }]);
    campaigns.mockResolvedValue([
      { id: "111", name: "Mine via wallet", status: "ACTIVE", objective: null, budget: null, campaign_group_id: null },
      { id: "222", name: "Other tenant", status: "ACTIVE", objective: null, budget: null, campaign_group_id: null },
    ]);
    analytics.mockResolvedValue(sharedAccountRows);
    w.bindings = [
      { id: "bind-mine", tenant_id: "t-same" },
      { id: "bind-theirs", tenant_id: "t-other" },
    ];
    w.campaign.mockImplementation(async (_t: string, id: string) => managedCampaign(id));
    walletAnalytics.mockResolvedValue(sharedAccountRows);
    const p = (await build(ctx("t-same"))) as LinkedinAdsPayload;
    expect(p.campaigns.map((c) => [c.id, c.funding_source])).toEqual([["111", "wallet"]]);
    expect(JSON.stringify(p)).not.toContain("Other tenant");
    expect(p.totals).toMatchObject({ spend: 25, clicks: 10, impressions: 500, conversions: 1 });
    expect(campaigns).not.toHaveBeenCalled();
    expect(analytics).not.toHaveBeenCalled();
    expect(w.globalScopes).toEqual(
      expect.arrayContaining([
        ["ads_provider_accounts", "platform", "linkedin"],
        ["ads_provider_accounts", "provider_account_id", "in", [MANAGED]],
      ]),
    );
  });

  it("a tenant with no wallet bindings whose own account is the managed account sees none of its campaigns", async () => {
    accounts.mockResolvedValue([{ id: MANAGED, name: "Zavi Managed", currency: "USD", status: "ACTIVE" }]);
    campaigns.mockResolvedValue([{ id: "222", name: "Other tenant", status: "ACTIVE", objective: null, budget: null, campaign_group_id: null }]);
    analytics.mockResolvedValue(sharedAccountRows);
    w.bindings = [{ id: "bind-theirs", tenant_id: "t-other" }];
    const p = (await build(ctx("t-nobind"))) as LinkedinAdsPayload;
    expect(p.connected).toBe(true);
    expect(p.campaigns).toEqual([]);
    expect(p.totals).toBeNull();
    expect(JSON.stringify(p)).not.toContain("Other tenant");
  });

  it("the change stamp reads are scoped to the tenant asking", async () => {
    adopt("t-stamp-scope", "559880687");
    accounts.mockResolvedValue([]);
    await build(ctx("t-stamp-scope"));
    for (const table of ["ads_campaign_lifecycle", "ads_campaign_operations", "channel_actions"]) {
      expect(w.scopes).toEqual(expect.arrayContaining([["t-stamp-scope", table, "tenant_id", "t-stamp-scope"]]));
    }
  });

  it("many wallet bindings make one analytics call per managed account and period", async () => {
    accounts.mockRejectedValue(new ExpectedToolError("linkedin_ads_not_connected", "x"));
    w.bindings = [
      ...Array.from({ length: 25 }, (_, i) => ({ id: `bind-901-${i}`, tenant_id: "t-many" })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `bind-902-${i}`, tenant_id: "t-many" })),
    ];
    w.campaign.mockImplementation(async (_t: string, id: string) => managedCampaign(id));
    walletAnalytics.mockImplementation(async (_tok, acct, opts) =>
      (opts.campaigns ?? []).map((u) => ({ ...row(u.split(":").pop()!, { spend: 1 }), pivot: u })),
    );
    const p = (await build(ctx("t-many"))) as LinkedinAdsPayload;
    expect(walletAnalytics).toHaveBeenCalledTimes(4);
    const byAcct = new Map<string, number>();
    for (const [, acct, opts] of walletAnalytics.mock.calls) byAcct.set(acct, opts.campaigns!.length);
    expect(Object.fromEntries(byAcct)).toEqual({ "901": 25, "902": 5 });
    expect(p.campaigns).toHaveLength(30);
    expect(p.totals).toMatchObject({ spend: 30 });
    expect(p.wallet_error_code).toBeNull();
  });

  it("an own ad account with no campaigns at all asks LinkedIn for no analytics on any poll, and the unselected account beside it is not read instead", async () => {
    adopt("t-no-campaigns", "559880687", "559880688");
    accounts.mockResolvedValue([
      { id: "559880687", name: "Dev Account", currency: "USD", status: "ACTIVE" },
      { id: "559880688", name: "Second", currency: "USD", status: "ACTIVE" },
    ]);
    campaigns.mockImplementation(async (_t, accountId) => accountId === "559880688" ? [{ id: "1", name: "Alpha", status: "ACTIVE", objective: null, budget: null, campaign_group_id: null }] : []);
    analytics.mockResolvedValue([row("1")]);
    const p = (await build(ctx("t-no-campaigns"))) as LinkedinAdsPayload;
    expect(analytics).not.toHaveBeenCalled();
    expect(campaigns.mock.calls.every(([, accountId]) => accountId === "559880687")).toBe(true);
    expect(p.totals).toMatchObject({ spend: 0 });
    expect(p.account).toMatchObject({ account_count: 1, campaign_count: 0, id: "559880687" });
  });

  it("connected but zero ad accounts → connected:true, empty", async () => {
    accounts.mockResolvedValue([]);
    const p = (await build(ctx("t-empty"))) as LinkedinAdsPayload;
    expect(p.connected).toBe(true);
    expect(p.error_code).toBeNull();
    expect(p.campaigns).toEqual([]);
  });

  describe("which visible ad accounts are this workspace's", () => {
    const TENANT = "t-own";
    const acct = (id: string, status: string, currency = "USD", name = `Account ${id}`) => ({ id, name, currency, status });
    const SPEND: Record<string, number> = { "101": 10, "102": 20, "103": 4000, "104": 800, "105": 160, "106": 320 };
    const providerBinding = (id: string, provider_account_id: string, tenant_id = TENANT) => ({ id, tenant_id, platform: "linkedin", provider_account_id, funding_source: "provider" });
    const campaignBinding = (account_binding_id: string, tenant_id = TENANT) => ({ account_binding_id, tenant_id, platform: "linkedin", funding_source: "provider" });
    const claim = (provider_account_id: string, credential_tenant_id: string) => ({ platform: "linkedin", provider_account_id, credential_source: "tenant_connector", credential_tenant_id });

    beforeEach(() => {
      w.managed = [];
      campaigns.mockImplementation(async (_t, accountId) => [{ id: `${accountId}1`, name: `Campaign of ${accountId}`, status: "ACTIVE", objective: null, budget: null, campaign_group_id: null }]);
      analytics.mockImplementation(async (_t, accountId) => [row(`${accountId}1`, { spend: SPEND[accountId] ?? 1, clicks: 1, impressions: 10, conversions: 0 })]);
    });

    it("sums only the selected account, never another workspace's, a canceled or an unselected one, even one holding this workspace's campaigns", async () => {
      accounts.mockResolvedValue([
        acct("101", "ACTIVE"),
        acct("102", "CANCELED"),
        acct("103", "ACTIVE", "EUR", "Other workspace's account"),
        acct("104", "CANCELED"),
        acct("105", "ACTIVE"),
        acct("106", "ACTIVE"),
      ]);
      w.tables = {
        ads_provider_accounts: [claim("101", TENANT), claim("102", TENANT), claim("103", "t-other"), claim("106", TENANT)],
        ads_account_binding_details: [
          providerBinding("b-101", "101"),
          providerBinding("b-102", "102"),
          providerBinding("b-106", "106"),
          providerBinding("b-other-103", "103", "t-other"),
        ],
        ads_account_selections: [{ account_binding_id: "b-101", tenant_id: TENANT, platform: "linkedin" }],
        ads_campaign_binding_details: [campaignBinding("b-102"), campaignBinding("b-other-103", "t-other")],
        ads_account_binding_status: [{ account_binding_id: "b-106", disabled_at: "2026-10-01T00:00:00Z" }],
      };
      const p = (await build(ctx(TENANT))) as LinkedinAdsPayload;
      expect(p.error_code).toBeNull();
      expect(p.campaigns.map((c) => c.ad_account_id).sort()).toEqual(["101"]);
      expect(p.totals).toMatchObject({ spend: 10, clicks: 1, impressions: 10 });
      expect(p.account).toMatchObject({ account_count: 1, id: "101", currency: "USD", name: "Account 101" });
      expect(campaigns.mock.calls.map(([, id]) => id).sort()).toEqual(["101"]);
      expect(analytics.mock.calls.map(([, id]) => id).sort()).toEqual(["101", "101"]);
      expect(JSON.stringify(p)).not.toContain("Other workspace");
      expect(w.globalScopes).toEqual(expect.arrayContaining([["ads_provider_accounts", "provider_account_id", "in", ["101", "102", "103", "104", "105", "106"]]]));
    });

    it("a selected account that was stopped for new campaigns is left out, and an unselected bound one does not take its place", async () => {
      accounts.mockResolvedValue([acct("101", "ACTIVE"), acct("102", "ACTIVE")]);
      w.tables = {
        ads_provider_accounts: [claim("101", TENANT), claim("102", TENANT)],
        ads_account_binding_details: [providerBinding("b-101", "101"), providerBinding("b-102", "102")],
        ads_account_selections: [{ account_binding_id: "b-101", tenant_id: TENANT, platform: "linkedin" }],
        ads_campaign_binding_details: [campaignBinding("b-102")],
        ads_account_binding_status: [{ account_binding_id: "b-101", disabled_at: "2026-10-01T00:00:00Z" }],
      };
      const p = (await build(ctx(TENANT))) as LinkedinAdsPayload;
      expect(p.connected).toBe(true);
      expect(p.account).toBeNull();
      expect(p.totals).toBeNull();
      expect(p.campaigns).toEqual([]);
      expect(campaigns).not.toHaveBeenCalled();
      expect(analytics).not.toHaveBeenCalled();
    });

    it("must catch: with no Zavi bindings and no selection it sums no account the login happens to see, and asks LinkedIn nothing about any of them", async () => {
      accounts.mockResolvedValue([acct("101", "ACTIVE"), acct("105", "ACTIVE", "EUR"), acct("107", "ACTIVE")]);
      w.tables = { ads_provider_accounts: [claim("101", TENANT)] };
      const p = (await build(ctx(TENANT))) as LinkedinAdsPayload;
      expect(p.connected).toBe(true);
      expect(p.error_code).toBeNull();
      expect(p.totals).toBeNull();
      expect(p.account).toBeNull();
      expect(p.campaigns).toEqual([]);
      expect(campaigns).not.toHaveBeenCalled();
      expect(analytics).not.toHaveBeenCalled();
    });

    it("must catch: with no own bindings, a wallet workspace shows only its wallet campaigns, never the login's other accounts", async () => {
      w.managed = [MANAGED];
      accounts.mockResolvedValue([acct("101", "ACTIVE"), acct(MANAGED, "ACTIVE")]);
      w.bindings = [{ id: "bind-mine", tenant_id: TENANT }];
      w.campaign.mockImplementation(async (_tenant: string, bindingId: string) => managedCampaign(bindingId));
      walletAnalytics.mockResolvedValue([row("111", { spend: 25, clicks: 10, impressions: 500, conversions: 1 })]);
      const p = (await build(ctx(TENANT))) as LinkedinAdsPayload;
      expect(p.campaigns.map((c) => c.id)).toEqual(["111"]);
      expect(p.totals).toMatchObject({ spend: 25 });
      expect(campaigns).not.toHaveBeenCalled();
      expect(analytics).not.toHaveBeenCalled();
    });

    it("a selection this workspace made counts even with no campaign yet, and an unselected binding does not", async () => {
      accounts.mockResolvedValue([acct("101", "ACTIVE"), acct("102", "ACTIVE")]);
      w.tables = {
        ads_account_binding_details: [providerBinding("b-101", "101"), providerBinding("b-102", "102")],
        ads_account_selections: [{ account_binding_id: "b-102", tenant_id: TENANT, platform: "linkedin" }],
      };
      const p = (await build(ctx(TENANT))) as LinkedinAdsPayload;
      expect(p.account).toMatchObject({ id: "102", account_count: 1 });
      expect(campaigns.mock.calls.map(([, id]) => id)).toEqual(["102"]);
    });

    it("a canceled selected account is reported closed, and neither a claimed account nor an unselected bound one is shown in its place", async () => {
      accounts.mockResolvedValue([acct("101", "ACTIVE"), acct("103", "ACTIVE", "USD", "Other workspace's account"), acct("104", "CANCELED", "GBP"), acct("105", "ACTIVE", "EUR")]);
      w.tables = {
        ads_provider_accounts: [claim("103", "t-other")],
        ads_account_binding_details: [providerBinding("b-101", "101"), providerBinding("b-103", "103"), providerBinding("b-104", "104"), providerBinding("b-105", "105")],
        ads_account_selections: [{ account_binding_id: "b-104", tenant_id: TENANT, platform: "linkedin" }],
        ads_campaign_binding_details: [campaignBinding("b-101"), campaignBinding("b-103"), campaignBinding("b-105")],
      };
      const p = (await build(ctx(TENANT))) as LinkedinAdsPayload;
      expect(p.campaigns).toEqual([]);
      expect(p.own_error_code).toBe("linkedin_ads_account_closed");
      expect(p.account).toMatchObject({ id: "104", account_count: 1, campaign_count: 0 });
      expect(campaigns).not.toHaveBeenCalled();
      expect(JSON.stringify(p)).not.toContain("Other workspace");
    });

    it("an account claimed by another workspace stays out even when only it is visible", async () => {
      accounts.mockResolvedValue([acct("103", "ACTIVE", "USD", "Other workspace's account")]);
      w.tables = { ads_provider_accounts: [claim("103", "t-other")] };
      const p = (await build(ctx(TENANT))) as LinkedinAdsPayload;
      expect(p.connected).toBe(true);
      expect(p.totals).toBeNull();
      expect(campaigns).not.toHaveBeenCalled();
      expect(analytics).not.toHaveBeenCalled();
    });

    it("cannot tell which accounts are claimed, so it shows nothing and says the read failed", async () => {
      accounts.mockResolvedValue([acct("101", "ACTIVE")]);
      w.failing.add("ads_provider_accounts");
      const p = (await build(ctx(TENANT))) as LinkedinAdsPayload;
      expect(p.error_code).toBe("linkedin_ads_read_failed");
      expect(p.totals).toBeNull();
      expect(analytics).not.toHaveBeenCalled();
    });
  });
});

describe("an ACTIVE campaign reports what its ads are doing, not only its own status", () => {
  const ad = (campaign_id: string, over: Partial<{ intended_status: string | null; is_serving: boolean | null; hold_reasons: string[]; review_status: string | null }> = {}) => ({
    id: null,
    name: null,
    created_at: null,
    last_modified_at: null,
    campaign_id,
    intended_status: "ACTIVE",
    is_serving: true,
    hold_reasons: [],
    review_status: "APPROVED",
    ...over,
  });
  const ownAccount = (tenant: string, rows: Array<{ id: string; status: string }>) => {
    adopt(tenant, "559880687");
    accounts.mockResolvedValue([{ id: "559880687", name: "Dev Account", currency: "USD", status: "ACTIVE" }]);
    campaigns.mockResolvedValue(rows.map((r) => ({ id: r.id, name: `C${r.id}`, status: r.status, objective: null, budget: null, campaign_group_id: null })));
    analytics.mockResolvedValue([]);
  };
  const delivery = (p: LinkedinAdsPayload) => p.campaigns.map((c) => [c.id, c.status, c.ad_delivery, c.ads_not_running]);

  it.each([
    ["a rejected review", { is_serving: false, review_status: "REJECTED" }, "rejected"],
    ["a rejected hold reason with no review field", { is_serving: false, review_status: null, hold_reasons: ["REJECTED"] }, "rejected"],
    ["a pending review", { is_serving: false, review_status: "PENDING" }, "in_review"],
    ["an under-review hold while LinkedIn still calls it serving", { is_serving: true, review_status: null, hold_reasons: ["UNDER_REVIEW"] }, "in_review"],
    ["a form hold on an approved ad", { is_serving: false, hold_reasons: ["FORM_HOLD"] }, "held"],
    ["a campaign total budget hold on an approved ad", { is_serving: false, hold_reasons: ["CAMPAIGN_TOTAL_BUDGET_HOLD"] }, "out_of_budget"],
    ["an account total budget hold on an ad LinkedIn still calls serving", { is_serving: true, hold_reasons: ["ACCOUNT_TOTAL_BUDGET_HOLD"] }, "out_of_budget"],
    ["an approved ad that is not serving", { is_serving: false }, "held"],
    ["a switched-off ad", { intended_status: "PAUSED" }, "no_ads"],
  ])("%s stops the campaign counting as active while its raw status stays ACTIVE", async (_label, over, expected) => {
    ownAccount(`t-ad-${expected}-${String(_label).length}`, [{ id: "1", status: "ACTIVE" }]);
    adStates.mockResolvedValue([ad("1", over)]);
    const p = (await build(ctx(`t-ad-${expected}-${String(_label).length}`))) as LinkedinAdsPayload;
    expect(p.campaigns[0]).toMatchObject({ status: "ACTIVE", ad_delivery: expected });
    expect(p.account?.active_count).toBe(0);
  });

  it("a spent campaign with a rejected ad beside it reads as out of budget: approving the ad would not bring it back", async () => {
    ownAccount("t-ad-spent", [{ id: "1", status: "ACTIVE" }]);
    adStates.mockResolvedValue([ad("1", { is_serving: false, review_status: "REJECTED" }), ad("1", { is_serving: false, hold_reasons: ["CAMPAIGN_TOTAL_BUDGET_HOLD"] })]);
    const p = (await build(ctx("t-ad-spent"))) as LinkedinAdsPayload;
    expect(delivery(p)).toEqual([["1", "ACTIVE", "out_of_budget", 2]]);
    expect(p.account?.active_count).toBe(0);
  });

  it("must catch: an active campaign with no ad at all is not delivering", async () => {
    ownAccount("t-ad-none", [{ id: "1", status: "ACTIVE" }]);
    adStates.mockResolvedValue([]);
    const p = (await build(ctx("t-ad-none"))) as LinkedinAdsPayload;
    expect(delivery(p)).toEqual([["1", "ACTIVE", "no_ads", 0]]);
    expect(p.account?.active_count).toBe(0);
  });

  it("one ad serving beside a rejected one stays active and counts the ad that is not running", async () => {
    ownAccount("t-ad-mixed", [{ id: "1", status: "ACTIVE" }]);
    adStates.mockResolvedValue([ad("1"), ad("1", { is_serving: false, review_status: "REJECTED" }), ad("1", { intended_status: "PAUSED", review_status: "REJECTED" })]);
    const p = (await build(ctx("t-ad-mixed"))) as LinkedinAdsPayload;
    expect(delivery(p)).toEqual([["1", "ACTIVE", "serving", 1]]);
    expect(p.account?.active_count).toBe(1);
  });

  it("non-regression guard: a draft ad under a paused campaign is not read and marks nothing, whatever its review", async () => {
    ownAccount("t-ad-draft-paused", [{ id: "1", status: "PAUSED" }]);
    adStates.mockClear();
    adStates.mockResolvedValue([ad("1", { intended_status: "DRAFT", is_serving: false, review_status: null })]);
    const p = (await build(ctx("t-ad-draft-paused"))) as LinkedinAdsPayload;
    expect(delivery(p)).toEqual([["1", "PAUSED", null, 0]]);
    expect(adStates).not.toHaveBeenCalled();
  });

  it("non-regression guard: a campaign on with only a draft ad is no ad running, never serving, in review, on hold or rejected", async () => {
    ownAccount("t-ad-draft-on", [{ id: "1", status: "ACTIVE" }]);
    adStates.mockResolvedValue([ad("1", { intended_status: "DRAFT", is_serving: false, review_status: null, hold_reasons: [] })]);
    const p = (await build(ctx("t-ad-draft-on"))) as LinkedinAdsPayload;
    expect(delivery(p)).toEqual([["1", "ACTIVE", "no_ads", 0]]);
  });

  it("non-regression guard: a draft ad beside a serving ad is not counted as an ad that stopped", async () => {
    ownAccount("t-ad-draft-beside", [{ id: "1", status: "ACTIVE" }]);
    adStates.mockResolvedValue([ad("1"), ad("1", { intended_status: "DRAFT", is_serving: false, review_status: null })]);
    const p = (await build(ctx("t-ad-draft-beside"))) as LinkedinAdsPayload;
    expect(delivery(p)).toEqual([["1", "ACTIVE", "serving", 0]]);
  });

  it("must catch: one campaign's rejected ad never marks a sibling campaign", async () => {
    ownAccount("t-ad-sibling", [{ id: "1", status: "ACTIVE" }, { id: "2", status: "ACTIVE" }]);
    adStates.mockResolvedValue([ad("1"), ad("2", { is_serving: false, review_status: "REJECTED" })]);
    const p = (await build(ctx("t-ad-sibling"))) as LinkedinAdsPayload;
    expect(Object.fromEntries(p.campaigns.map((c) => [c.id, c.ad_delivery]))).toEqual({ "1": "serving", "2": "rejected" });
    expect(p.account?.active_count).toBe(1);
  });

  it("must catch: ads answering with neither serving nor review state are unread, never serving", async () => {
    ownAccount("t-ad-blank", [{ id: "1", status: "ACTIVE" }]);
    adStates.mockResolvedValue([ad("1", { is_serving: null, review_status: null })]);
    const p = (await build(ctx("t-ad-blank"))) as LinkedinAdsPayload;
    expect(delivery(p)).toEqual([["1", "ACTIVE", "unread", 0]]);
  });

  it("asks LinkedIn only about ACTIVE campaigns, and not at all when none is ACTIVE", async () => {
    ownAccount("t-ad-scope", [{ id: "1", status: "ACTIVE" }, { id: "2", status: "PAUSED" }]);
    adStates.mockResolvedValue([ad("1")]);
    await build(ctx("t-ad-scope"));
    expect(adStates).toHaveBeenCalledTimes(1);
    expect(adStates).toHaveBeenCalledWith("t-ad-scope", "559880687", ["1"]);
    adStates.mockClear();
    ownAccount("t-ad-scope-2", [{ id: "2", status: "PAUSED" }]);
    const p = (await build(ctx("t-ad-scope-2"))) as LinkedinAdsPayload;
    expect(adStates).not.toHaveBeenCalled();
    expect(delivery(p)).toEqual([["2", "PAUSED", null, 0]]);
  });

  it("a failed ad read keeps the row and totals, says unread, and is not cached over the next poll", async () => {
    ownAccount("t-ad-fail", [{ id: "1", status: "ACTIVE" }]);
    analytics.mockResolvedValue([row("1")]);
    adStates.mockRejectedValueOnce(new Error("linkedin down"));
    const polled = { ...ctx("t-ad-fail"), refresh: false };
    const first = (await build(polled)) as LinkedinAdsPayload;
    expect(first.error_code).toBeNull();
    expect(first.totals).toMatchObject({ spend: 100 });
    expect(delivery(first)).toEqual([["1", "ACTIVE", "unread", 0]]);
    expect(first.account?.active_count).toBe(1);
    adStates.mockResolvedValueOnce([ad("1", { is_serving: false, review_status: "REJECTED" })]);
    const second = (await build(polled)) as LinkedinAdsPayload;
    expect(delivery(second)).toEqual([["1", "ACTIVE", "rejected", 1]]);
  });

  it("must catch: a failed campaign-group read keeps the rows, leaves them ungrouped, and is not cached over the next poll", async () => {
    ownAccount("t-group-fail", [{ id: "1", status: "ACTIVE" }]);
    campaigns.mockResolvedValue([{ id: "1", name: "C1", status: "ACTIVE", objective: null, budget: null, campaign_group_id: "5" }]);
    analytics.mockResolvedValue([row("1")]);
    adStates.mockResolvedValue([ad("1")]);
    groups.mockRejectedValueOnce(new Error("linkedin down"));
    const polled = { ...ctx("t-group-fail"), refresh: false, sb: tenantClient(asTenantId("t-group-fail")) } as Parameters<typeof build>[0];
    const first = (await build(polled)) as LinkedinAdsPayload;
    expect(first.error_code).toBeNull();
    expect(first.campaigns.map((c) => [c.id, c.campaign_group])).toEqual([["1", null]]);
    groups.mockResolvedValueOnce([{ id: "5", name: "Spring launch", status: "ACTIVE", total_budget: null, run_start_at: null, run_end_at: null, last_modified_at: null, is_default: false }]);
    const second = (await build(polled)) as LinkedinAdsPayload;
    expect(second.campaigns.map((c) => [c.id, c.campaign_group])).toEqual([["1", { id: "5", name: "Spring launch" }]]);
    const third = (await build(polled)) as LinkedinAdsPayload;
    expect(third.campaigns[0].campaign_group).toEqual({ id: "5", name: "Spring launch" });
    expect(groups).toHaveBeenCalledTimes(2);
  });

  it("a wallet campaign reads its ads with the managed token on the managed account, never the tenant's own", async () => {
    accounts.mockResolvedValue([]);
    w.bindings = [{ id: "bind-mine", tenant_id: "t-ad-wallet" }];
    w.campaign.mockImplementation(async (_t: string, id: string) => managedCampaign(id));
    walletAnalytics.mockResolvedValue([]);
    walletAdStates.mockResolvedValue([ad("111", { is_serving: false, review_status: "REJECTED" })]);
    const p = (await build(ctx("t-ad-wallet"))) as LinkedinAdsPayload;
    expect(walletAdStates).toHaveBeenCalledWith("managed-token", MANAGED, ["111"]);
    expect(adStates).not.toHaveBeenCalled();
    expect(delivery(p)).toEqual([["111", "ACTIVE", "rejected", 1]]);
  });
});

describe("one part of the LinkedIn read failing", () => {
  const own = (tenant: string, ...ids: string[]) => {
    adopt(tenant, ...ids);
    accounts.mockResolvedValue(ids.map((id, i) => ({ id, name: i === 0 ? "Main account" : `Account ${id}`, currency: "USD", status: "ACTIVE" })));
    campaigns.mockImplementation(async (_t, accountId) => [{ id: `${accountId}1`, name: `Campaign of ${accountId}`, status: "ACTIVE", objective: null, budget: null, campaign_group_id: null }]);
  };
  const withWallet = (tenant: string) => {
    w.bindings = [{ id: "bind-mine", tenant_id: tenant }];
    w.campaign.mockImplementation(async (_t: string, id: string) => managedCampaign(id));
    walletAnalytics.mockResolvedValue(sharedAccountRows);
  };

  it.each([
    ["expired or revoked", () => accounts.mockRejectedValue(new ExpectedToolError("linkedin_ads_token_revoked", "x")), "linkedin_ads_token_revoked"],
    ["at its daily limit", () => analytics.mockRejectedValue(new ExpectedToolError("linkedin_ads_http_error", LINKEDIN_ADS_DAILY_LIMIT)), "linkedin_ads_daily_limit"],
    ["refused", () => accounts.mockRejectedValue(new ExpectedToolError("linkedin_ads_forbidden", "x")), "linkedin_ads_forbidden"],
  ])("the founder's own LinkedIn %s still shows every shared-wallet campaign, and names the own-account problem apart", async (_label, breakOwn, code) => {
    own("t-own-broken", "559880687");
    withWallet("t-own-broken");
    breakOwn();
    const p = (await build(ctx("t-own-broken"))) as LinkedinAdsPayload;
    expect(p).toMatchObject({ connected: true, own_connected: true, error_code: null, wallet_error_code: null, own_error_code: code });
    expect(p.campaigns.map((c) => [c.id, c.funding_source])).toEqual([["111", "wallet"]]);
    expect(p.totals).toMatchObject({ spend: 25, clicks: 10, impressions: 500, conversions: 1 });
    expect(p.account).toMatchObject({ id: null, account_count: 1, campaign_count: 1, active_count: 1 });
  });

  it("non-regression guard: the founder's own LinkedIn failing with no wallet campaign keeps the whole-page error", async () => {
    own("t-own-only", "559880687");
    accounts.mockRejectedValue(new ExpectedToolError("linkedin_ads_token_revoked", "x"));
    const p = (await build(ctx("t-own-only"))) as LinkedinAdsPayload;
    expect(p).toMatchObject({ connected: true, own_connected: true, error_code: "linkedin_ads_token_revoked", totals: null, campaigns: [] });
  });

  it("only the account in use is read, so an unselected account LinkedIn will not read is neither shown nor named as failed", async () => {
    own("t-one-bad", "101", "102", "103");
    analytics.mockImplementation(async (_t, accountId) => {
      if (accountId === "102") throw new ExpectedToolError("linkedin_ads_forbidden", "HTTP 403 ACCESS_DENIED");
      return [row(`${accountId}1`, { spend: accountId === "101" ? 10 : 30, clicks: 1, impressions: 10, conversions: 0 })];
    });
    const p = (await build(ctx("t-one-bad"))) as LinkedinAdsPayload;
    expect(p.error_code).toBeNull();
    expect(p.campaigns.map((c) => c.ad_account_id)).toEqual(["101"]);
    expect(p.totals).toMatchObject({ spend: 10, clicks: 1 });
    expect(p.account_errors).toEqual([]);
    expect(analytics.mock.calls.every(([, id]) => id === "101")).toBe(true);
  });

  it("the account in use at the daily limit is the whole page's limit error; the unselected account is not read in its place", async () => {
    own("t-one-limit", "101", "102");
    campaigns.mockImplementation(async (_t, accountId) => {
      if (accountId === "101") throw new ExpectedToolError("linkedin_ads_http_error", LINKEDIN_ADS_DAILY_LIMIT);
      return [{ id: `${accountId}1`, name: "Live", status: "ACTIVE", objective: null, budget: null, campaign_group_id: null }];
    });
    analytics.mockResolvedValue([row("1021", { spend: 7 })]);
    const p = (await build(ctx("t-one-limit"))) as LinkedinAdsPayload;
    expect(p).toMatchObject({ error_code: "linkedin_ads_daily_limit", campaigns: [], totals: null });
    expect(campaigns.mock.calls.map(([, id]) => id)).toEqual(["101"]);
  });

  it("non-regression guard: every ad account failing still says the read failed for the whole page", async () => {
    own("t-all-bad", "101", "102");
    analytics.mockRejectedValue(new ExpectedToolError("linkedin_ads_forbidden", "x"));
    const p = (await build(ctx("t-all-bad"))) as LinkedinAdsPayload;
    expect(p).toMatchObject({ error_code: "linkedin_ads_forbidden", campaigns: [], totals: null });
  });
});

describe("which campaigns the table lists", () => {
  const fakeLinkedIn = (all: Array<{ id: string; status: string }>) =>
    campaigns.mockImplementation(async (_t, _a, limit = 100, statuses?: readonly string[]) =>
      all
        .filter((c) => !statuses || statuses.includes(c.status))
        .slice(0, limit)
        .map((c) => ({ id: c.id, name: `C${c.id}`, status: c.status, objective: null, budget: null, campaign_group_id: null })),
    );

  it("live campaigns behind more than 200 archived and canceled ones are all listed and counted active", async () => {
    adopt("t-archive-heavy", "101");
    accounts.mockResolvedValue([{ id: "101", name: "Busy", currency: "USD", status: "ACTIVE" }]);
    const old = Array.from({ length: 250 }, (_, i) => ({ id: `9${i}`, status: i % 2 ? "ARCHIVED" : "CANCELED" }));
    const live = Array.from({ length: 30 }, (_, i) => ({ id: `1${i}`, status: i < 20 ? "ACTIVE" : "PAUSED" }));
    fakeLinkedIn([...old, ...live]);
    analytics.mockResolvedValue(live.map((c) => row(c.id, { spend: 1 })));
    adStates.mockResolvedValue(live.filter((c) => c.status === "ACTIVE").map((c) => ({ id: null, name: null, created_at: null, last_modified_at: null, campaign_id: c.id, intended_status: "ACTIVE", is_serving: true, hold_reasons: [], review_status: "APPROVED" })));
    const p = (await build(ctx("t-archive-heavy"))) as LinkedinAdsPayload;
    expect(p.campaigns).toHaveLength(30);
    expect(p.account).toMatchObject({ campaign_count: 30, active_count: 20 });
    expect(campaigns).toHaveBeenCalledTimes(1);
    expect(campaigns.mock.calls[0][3]).toEqual(expect.not.arrayContaining(["ARCHIVED"]));
  });

  it("an account holding only archived campaigns still reads its spend into the totals", async () => {
    adopt("t-archived-only", "101");
    accounts.mockResolvedValue([{ id: "101", name: "Done", currency: "USD", status: "ACTIVE" }]);
    fakeLinkedIn([{ id: "77", status: "ARCHIVED" }]);
    analytics.mockResolvedValueOnce([row("77", { spend: 55 })]).mockResolvedValueOnce([]);
    const p = (await build(ctx("t-archived-only"))) as LinkedinAdsPayload;
    expect(p.campaigns).toEqual([]);
    expect(p.totals).toMatchObject({ spend: 55 });
  });

  it("an account with no campaign of any kind asks for one extra short list and no analytics", async () => {
    adopt("t-bare", "101");
    accounts.mockResolvedValue([{ id: "101", name: "New", currency: "USD", status: "ACTIVE" }]);
    fakeLinkedIn([]);
    await build(ctx("t-bare"));
    expect(campaigns.mock.calls.map(([, , limit]) => limit)).toEqual([200, 1]);
    expect(analytics).not.toHaveBeenCalled();
  });
});

describe("a chosen ad account LinkedIn has not switched on", () => {
  const TENANT = "t-chosen";
  const choose = (status: string) => {
    w.managed = [];
    accounts.mockResolvedValue([{ id: "101", name: "Fresh account", currency: "USD", status }]);
    w.tables = {
      ads_account_binding_details: [{ id: "b-101", tenant_id: TENANT, platform: "linkedin", provider_account_id: "101", funding_source: "provider" }],
      ads_account_selections: [{ account_binding_id: "b-101", tenant_id: TENANT, platform: "linkedin" }],
    };
  };

  it("says the account is chosen but not active yet, instead of saying none was chosen", async () => {
    choose("DRAFT");
    const p = (await build(ctx(TENANT))) as LinkedinAdsPayload;
    expect(p).toMatchObject({ connected: true, error_code: null, own_error_code: "linkedin_ads_account_not_active", totals: null, campaigns: [] });
    expect(p.account).toMatchObject({ id: "101", name: "Fresh account", account_count: 1, active_count: 0 });
    expect(campaigns).not.toHaveBeenCalled();
    expect(analytics).not.toHaveBeenCalled();
  });

  it("a chosen account LinkedIn closed says closed, not waiting for a payment method", async () => {
    choose("CANCELED");
    const p = (await build(ctx(TENANT))) as LinkedinAdsPayload;
    expect(p.own_error_code).toBe("linkedin_ads_account_closed");
    expect(p.account?.id).toBe("101");
  });

  it("non-regression guard: an active chosen account carries no account problem", async () => {
    choose("ACTIVE");
    campaigns.mockResolvedValue([]);
    const p = (await build(ctx(TENANT))) as LinkedinAdsPayload;
    expect(p.own_error_code).toBeNull();
    expect(p.account?.id).toBe("101");
  });
});

describe("Review 31 dashboard fixes", () => {
  const busy = (retryAt: string) => new ExpectedToolError("linkedin_ads_http_error", "LinkedIn Ads is busy right now. Try again in a few minutes.", { status: 429, http_status: 429, retry_at: retryAt });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("P4/P6: archived, canceled and unlisted campaigns with spend get one other-campaigns row, and rows add up to the totals", async () => {
    adopt("t-ended", "559880687");
    accounts.mockResolvedValue([{ id: "559880687", name: "Dev Account", currency: "USD", status: "ACTIVE" }]);
    campaigns.mockImplementation(async (_t, _a, _n, statuses) => (statuses?.includes("ARCHIVED") ? [] : [{ id: "1", name: "Live", status: "ACTIVE", objective: null, budget: null, campaign_group_id: null }]));
    analytics.mockResolvedValue([row("1", { spend: 60, clicks: 6, conversions: 3, impressions: 600 }), row("77", { spend: 40, clicks: 4, conversions: 1, impressions: 400 }), row("78", { spend: 0, clicks: 0, conversions: 0, impressions: 0 })]);
    adStates.mockResolvedValue([]);
    const p = (await build(ctx("t-ended"))) as LinkedinAdsPayload;
    expect(p.campaigns.map((c) => c.id)).toEqual(["1"]);
    expect(p.other_campaigns).toEqual([{ kind: "ended", name: "Archived, canceled and older campaigns", currency: "USD", spend: 40, impressions: 400, clicks: 4, conversions: 1, leads: 0, conversion_value: null, cpa: 40 }]);
    const all = [...p.campaigns, ...p.other_campaigns];
    expect(all.reduce((t, c) => t + c.spend, 0)).toBe(p.totals?.spend);
    expect(all.reduce((t, c) => t + (c.clicks ?? 0), 0)).toBe(p.totals?.clicks);
    expect(all.reduce((t, c) => t + (c.conversions ?? 0), 0)).toBe(p.totals?.conversions);
    expect(p.totals).toMatchObject({ spend: 100, conversions: 4, cpa: 25, cpc: 10 });
    expect(p.account?.campaign_count).toBe(1);
  });

  it("P6: an account whose only campaigns are archived still shows their spend in a row, so the table is never empty under a non-zero Spend tile", async () => {
    adopt("t-archived", "559880687");
    accounts.mockResolvedValue([{ id: "559880687", name: "Dev Account", currency: "USD", status: "ACTIVE" }]);
    campaigns.mockImplementation(async (_t, _a, _n, statuses) => (statuses?.includes("ARCHIVED") ? [{ id: "77", name: "Old", status: "ARCHIVED", objective: null, budget: null, campaign_group_id: null }] : []));
    analytics.mockResolvedValue([row("77", { spend: 40 })]);
    const p = (await build(ctx("t-archived"))) as LinkedinAdsPayload;
    expect(p.totals?.spend).toBe(40);
    expect(p.campaigns).toEqual([]);
    expect(p.other_campaigns.map((o) => [o.kind, o.spend])).toEqual([["ended", 40]]);
  });

  it("P5: a throttled own-account read sets the rate-limit code and the time Zavi will read again", async () => {
    accounts.mockRejectedValue(busy("2026-11-03T10:24:00.000Z"));
    const p = (await build(ctx("t-throttled"))) as LinkedinAdsPayload;
    expect(p.error_code).toBe("linkedin_ads_rate_limited");
    expect(p.retry_at).toBe("2026-11-03T10:24:00.000Z");
  });

  it("P5: own accounts throttled next to wallet rows set own_error_code to the rate-limit code with the real wait", async () => {
    accounts.mockRejectedValue(busy("2026-11-03T10:24:00.000Z"));
    w.bindings = [{ id: "bind-mine", tenant_id: "t-own-throttled" }];
    w.campaign.mockImplementation(async (_t: string, id: string) => managedCampaign(id));
    walletAnalytics.mockResolvedValue(sharedAccountRows);
    walletAdStates.mockResolvedValue([]);
    const p = (await build(ctx("t-own-throttled"))) as LinkedinAdsPayload;
    expect(p).toMatchObject({ error_code: null, own_error_code: "linkedin_ads_rate_limited", wallet_error_code: null, retry_at: "2026-11-03T10:24:00.000Z" });
  });

  it("P5: a throttled account that is not the one in use is never read, so it neither sets a wait nor a reason", async () => {
    adopt("t-one-throttled", "559880687", "559880688");
    accounts.mockResolvedValue([
      { id: "559880687", name: "Dev Account", currency: "USD", status: "ACTIVE" },
      { id: "559880688", name: "Second", currency: "USD", status: "ACTIVE" },
    ]);
    campaigns.mockResolvedValue([{ id: "1", name: "Live", status: "ACTIVE", objective: null, budget: null, campaign_group_id: null }]);
    analytics.mockImplementation(async (_t, acct) => {
      if (acct === "559880688") throw busy("2026-11-03T10:16:00.000Z");
      return [row("1")];
    });
    adStates.mockResolvedValue([]);
    const p = (await build(ctx("t-one-throttled"))) as LinkedinAdsPayload;
    expect(p.retry_at).toBeNull();
    expect(p.account_errors).toEqual([]);
    expect(analytics.mock.calls.every(([, id]) => id === "559880687")).toBe(true);
  });

  it("P5: a throttled wallet read gets its own wallet rate-limit code and wait time", async () => {
    accounts.mockRejectedValue(new ExpectedToolError("linkedin_ads_not_connected", "x"));
    w.bindings = [{ id: "bind-mine", tenant_id: "t-wallet-throttled" }];
    w.campaign.mockRejectedValue(busy("2026-11-03T10:05:00.000Z"));
    const p = (await build(ctx("t-wallet-throttled"))) as LinkedinAdsPayload;
    expect(p).toMatchObject({ wallet_error_code: "linkedin_ads_wallet_rate_limited", retry_at: "2026-11-03T10:05:00.000Z" });
  });

  it("P9: the shared wallet login's daily limit gets the wallet code, and own_error_code stays clear", async () => {
    adopt("t-wallet-day", "559880687");
    accounts.mockResolvedValue([{ id: "559880687", name: "Dev Account", currency: "USD", status: "ACTIVE" }]);
    campaigns.mockResolvedValue([{ id: "1", name: "Own", status: "ACTIVE", objective: null, budget: null, campaign_group_id: null }]);
    analytics.mockResolvedValue([row("1")]);
    adStates.mockResolvedValue([]);
    w.bindings = [{ id: "bind-mine", tenant_id: "t-wallet-day" }];
    w.campaign.mockRejectedValue(new ExpectedToolError("linkedin_ads_http_error", LINKEDIN_ADS_DAILY_LIMIT, { status: 429, http_status: 429 }));
    const p = (await build(ctx("t-wallet-day"))) as LinkedinAdsPayload;
    expect(p).toMatchObject({ error_code: null, own_error_code: null, wallet_error_code: "linkedin_ads_wallet_daily_limit" });
  });

  it("P9: a wallet-only founder whose shared login is out of daily allowance is not told their own connection is", async () => {
    accounts.mockRejectedValue(new ExpectedToolError("linkedin_ads_not_connected", "x"));
    w.bindings = [{ id: "bind-mine", tenant_id: "t-wallet-only-day" }];
    w.campaign.mockRejectedValue(new ExpectedToolError("linkedin_ads_http_error", LINKEDIN_ADS_DAILY_LIMIT, { status: 429, http_status: 429 }));
    const p = (await build(ctx("t-wallet-only-day"))) as LinkedinAdsPayload;
    expect(p.wallet_error_code).toBe("linkedin_ads_wallet_daily_limit");
    expect(p.error_code).not.toBe("linkedin_ads_daily_limit");
  });
});
