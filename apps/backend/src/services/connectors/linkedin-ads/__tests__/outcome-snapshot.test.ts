import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ get: vi.fn(), binding: vi.fn(), walletCampaign: vi.fn() }));
vi.mock("@/services/connectors/linkedin-ads/http", async (orig) => ({ ...(await orig<Record<string, unknown>>()), linkedinAdsGet: (...a: unknown[]) => m.get(...a) }));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({ withLinkedInAdsToken: async (_t: string, call: (tok: string) => Promise<unknown>) => call("own-token") }));
vi.mock("@/services/ads-wallet/bindings", () => ({ findCampaignBinding: (...a: unknown[]) => m.binding(...a) }));
vi.mock("@/services/ads-wallet/adapters/linkedin", () => ({ linkedinCampaign: (...a: unknown[]) => m.walletCampaign(...a) }));

import { readLinkedInSnapshot } from "../outcome-snapshot";

beforeEach(() => {
  for (const f of [m.get, m.binding, m.walletCampaign]) f.mockReset();
  m.binding.mockResolvedValue(null);
});

describe("readLinkedInSnapshot", () => {
  it("must catch: reads one campaign's whole window with the owner's token, sums website conversions and leads, and says no_data instead of $0 when LinkedIn has no row", async () => {
    m.get.mockResolvedValueOnce({ elements: [{ costInLocalCurrency: "40.504", impressions: 900, externalWebsiteConversions: 2, oneClickLeads: 1, conversionValueInLocalCurrency: "81.01" }] });
    const snap = await readLinkedInSnapshot("t-a", "123", "2026-10-20", "2026-11-03");
    expect(snap).toEqual({ spend: 40.5, roas: 2, conversions: 3, purchase_value: 81.01, impressions: 900 });
    const [token, path, params, raw, opts] = m.get.mock.calls[0] as [string, string, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    expect(token).toBe("own-token");
    expect(path).toBe("adAnalytics");
    expect(params).toMatchObject({ pivot: "CAMPAIGN", timeGranularity: "ALL", campaigns: ["urn:li:sponsoredCampaign:123"], dateRange: { start: { year: 2026, month: 10, day: 20 }, end: { year: 2026, month: 11, day: 3 } } });
    expect(params.accounts).toBeUndefined();
    expect(String(raw.fields)).toMatch(/costInLocalCurrency/);
    expect(opts).toEqual({ fresh: true });
    m.get.mockResolvedValueOnce({ elements: [] });
    expect(await readLinkedInSnapshot("t-a", "123", "2026-10-20", "2026-11-03")).toBeNull();
    expect(await readLinkedInSnapshot("t-a", "urn:li:sponsoredCampaign:123", "2026-10-20", "2026-11-03")).toBeNull();
    expect(m.get).toHaveBeenCalledTimes(2);
  });

  it("a wallet campaign reads with Zavi's managed token for that binding, never the founder's login", async () => {
    m.binding.mockResolvedValue({ id: "cb-1", funding_source: "wallet" });
    m.walletCampaign.mockResolvedValue({ token: "managed-token", campaign: {} });
    m.get.mockResolvedValueOnce({ elements: [{ costInLocalCurrency: "1", impressions: 1 }] });
    await readLinkedInSnapshot("t-a", "555", "2026-10-20", "2026-11-03");
    expect(m.walletCampaign.mock.calls[0].slice(0, 2)).toEqual(["t-a", "cb-1"]);
    expect(m.get.mock.calls[0][0]).toBe("managed-token");
  });
});
