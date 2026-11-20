import { beforeEach, describe, expect, it, vi } from "vitest";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SHARED = "900";

const m = vi.hoisted(() => ({
  campaignBindings: [] as Array<Record<string, unknown>>,
  connected: false,
  analytics: vi.fn(),
  ownAnalytics: vi.fn(),
  ownList: vi.fn(),
  states: vi.fn(),
  campaignReads: [] as string[],
  inUse: new Map<string, Set<string>>(),
}));

vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: () => {
      const q: Record<string, unknown> = { select: () => q, eq: () => q, order: () => q, range: async () => ({ data: m.campaignBindings, error: null }) };
      return q;
    },
  }),
}));
vi.mock("@/services/ads-wallet/bindings", () => ({
  getAccountBinding: async (tenant: string, id: string) => ({
    id,
    tenant_id: tenant,
    platform: "linkedin",
    provider_account_id: SHARED,
    currency: "USD",
    funding_source: "wallet",
    credential_source: "platform",
    credential_tenant_id: null,
    credential_ref: "linkedin_ads_managed_main",
  }),
}));
vi.mock("@/services/ads-wallet/adapters/linkedin-account", () => ({
  resolveLinkedinAccount: async () => ({ token: "managed-token", account: { id: SHARED, currency: "USD", status: "ACTIVE" } }),
}));
vi.mock("@/services/ads-wallet/adapters/linkedin", () => ({
  goneLinkedinCampaignIds: async () => new Set<string>(),
  linkedinCampaign: async (_t: string, bindingId: string) => {
    const b = m.campaignBindings.find((x) => x.id === bindingId)!;
    m.campaignReads.push(String(b.provider_campaign_id));
    return { token: "managed-token", campaign: { id: String(b.provider_campaign_id), name: `Campaign ${b.provider_campaign_id}`, status: "ACTIVE", account: `urn:li:sponsoredAccount:${SHARED}` } };
  },
}));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", () => ({
  ownLinkedinAccounts: async (_t: string, listed: unknown[]) => listed,
  linkedinAccountInUse: async (t: string, id: string) => m.inUse.get(t)?.has(id) ?? false,
}));
vi.mock("@/services/connectors/linkedin-ads/client", async (orig) => {
  const { ExpectedToolError } = await import("@/services/tools/types");
  const notConnected = () => new ExpectedToolError("linkedin_ads_not_connected", "LinkedIn Ads is not connected.");
  return {
    toAdCampaign: (await orig<{ toAdCampaign: unknown }>()).toAdCampaign,
    listLinkedInAdAccounts: async () => {
      if (!m.connected) throw notConnected();
      return [{ id: "500", name: "Own", currency: "EUR", status: "ACTIVE" }];
    },
    listLinkedInCampaigns: (...a: unknown[]) => m.ownList(...a),
    readLinkedInAdAnalytics: (...a: unknown[]) => m.ownAnalytics(...a),
    readLinkedInAdAnalyticsWithToken: (...a: unknown[]) => m.analytics(...a),
    readLinkedInAdStates: vi.fn(async () => []),
    readLinkedInAdStatesWithToken: (...a: unknown[]) => m.states(...a),
  };
});

import { linkedinAdsListAccountsTool } from "../list_accounts";
import { linkedinAdsListCampaignsTool } from "../list_campaigns";
import { linkedinAdsReadAnalyticsTool } from "../read_analytics";

const ctx = (tenant_id: string) => ({ tenant_id, log: () => undefined }) as never;
const row = (id: string, spend: number) => ({ pivot: `urn:li:sponsoredCampaign:${id}`, impressions: 100, clicks: 5, spend, conversions: 1, leads: 0, missing_metrics: [] });

beforeEach(() => {
  m.campaignBindings = [
    { id: "cb-A1", tenant_id: A, account_binding_id: "ab-A", provider_campaign_id: "111" },
    { id: "cb-B1", tenant_id: B, account_binding_id: "ab-B", provider_campaign_id: "222" },
  ];
  m.connected = false;
  m.campaignReads = [];
  m.inUse = new Map([[A, new Set(["500"])]]);
  m.analytics.mockReset();
  m.analytics.mockImplementation(async () => [row("111", 40), row("222", 9000)]);
  m.ownAnalytics.mockReset();
  m.ownAnalytics.mockResolvedValue([]);
  m.ownList.mockReset();
  m.ownList.mockResolvedValue([]);
  m.states.mockReset();
  m.states.mockResolvedValue([]);
});

describe("shared-wallet LinkedIn campaigns are visible to chat and the run, scoped to this workspace", () => {
  it("must-catch: a wallet-only founder sees the Zavi ads wallet account instead of 'not connected'", async () => {
    const out = (await linkedinAdsListAccountsTool.execute(ctx(A), {})) as { count: number; accounts: Array<Record<string, unknown>> };
    expect(out.count).toBe(1);
    expect(out.accounts[0]).toMatchObject({ id: SHARED, name: "Zavi ads wallet", currency: "USD", funding: "zavi_wallet" });
  });

  it("a founder with neither a login nor a wallet campaign is still told LinkedIn Ads is not connected", async () => {
    m.campaignBindings = [];
    await expect(linkedinAdsListAccountsTool.execute(ctx(A), {})).rejects.toMatchObject({ code: "linkedin_ads_not_connected" });
  });

  it("a founder with both lists their own account and the wallet account", async () => {
    m.connected = true;
    const out = (await linkedinAdsListAccountsTool.execute(ctx(A), {})) as { accounts: Array<{ id: string; funding: string }> };
    expect(out.accounts.map((a) => [a.id, a.funding])).toEqual([["500", "own"], [SHARED, "zavi_wallet"]]);
  });

  it("must-catch: list_campaigns on the shared wallet account returns only this workspace's campaigns, read with Zavi's managed login", async () => {
    const out = (await linkedinAdsListCampaignsTool.execute(ctx(A), { account_id: SHARED })) as { campaigns: Array<{ id: string }> };
    expect(out.campaigns.map((c) => c.id)).toEqual(["111"]);
    expect(m.campaignReads).toEqual(["111"]);
    expect(m.ownList).not.toHaveBeenCalled();
    expect(m.states).toHaveBeenCalledWith("managed-token", SHARED, ["111"]);
    expect(JSON.stringify(out)).not.toContain("222");
  });

  it("must-catch: read_analytics on the shared wallet account counts only this workspace's campaigns, even if LinkedIn returns another workspace's row", async () => {
    const out = (await linkedinAdsReadAnalyticsTool.execute(ctx(A), { account_id: SHARED, pivot: "ACCOUNT", lookback_days: 30 })) as {
      pivot: string;
      currency: string;
      totals: { spend: number };
      rows: Array<{ pivot: string }>;
    };
    expect(out.rows.map((r) => r.pivot)).toEqual(["urn:li:sponsoredCampaign:111"]);
    expect(out.totals.spend).toBe(40);
    expect(out.currency).toBe("USD");
    expect(out.pivot).toBe("CAMPAIGN");
    for (const [token, account, opts] of m.analytics.mock.calls) {
      expect(token).toBe("managed-token");
      expect(account).toBe(SHARED);
      expect(opts).toMatchObject({ pivot: "CAMPAIGN", campaigns: ["urn:li:sponsoredCampaign:111"] });
    }
    expect(m.ownAnalytics).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain("222");
  });

  it("must-catch: another workspace's wallet campaigns stay out of B's view too", async () => {
    const out = (await linkedinAdsReadAnalyticsTool.execute(ctx(B), { account_id: SHARED, pivot: "CAMPAIGN", lookback_days: 7 })) as { totals: { spend: number }; rows: Array<{ pivot: string }> };
    expect(out.rows.map((r) => r.pivot)).toEqual(["urn:li:sponsoredCampaign:222"]);
    expect(out.totals.spend).toBe(9000);
  });

  it.each([
    ["read_analytics", () => linkedinAdsReadAnalyticsTool.execute(ctx(B), { account_id: "500", pivot: "CAMPAIGN", lookback_days: 7 })],
    ["list_campaigns", () => linkedinAdsListCampaignsTool.execute(ctx(B), { account_id: "500" })],
  ])("must-catch: %s refuses an account this workspace does not use, before any LinkedIn call", async (_name, run) => {
    m.connected = true;
    await expect(run()).rejects.toMatchObject({ code: "linkedin_ads_account_not_in_use" });
    expect(m.ownAnalytics).not.toHaveBeenCalled();
    expect(m.ownList).not.toHaveBeenCalled();
    expect(m.analytics).not.toHaveBeenCalled();
  });

  it("must-not-touch: the workspace's own account still reads through the founder's login", async () => {
    m.connected = true;
    await linkedinAdsReadAnalyticsTool.execute(ctx(A), { account_id: "500", pivot: "ACCOUNT", lookback_days: 7 });
    expect(m.ownAnalytics).toHaveBeenCalledWith(A, "500", expect.objectContaining({ pivot: "ACCOUNT" }));
    expect(m.analytics).not.toHaveBeenCalled();
  });
});
