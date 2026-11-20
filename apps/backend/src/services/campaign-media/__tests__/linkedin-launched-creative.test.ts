import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ get: vi.fn(), batch: vi.fn(), tables: {} as Record<string, unknown[]> }));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({
  withLinkedInAdsToken: async (_tenant: string, run: (token: string) => Promise<unknown>) => run("tok"),
  listLinkedInAdAccountsRaw: async () => [{ id: "558561881" }],
}));
vi.mock("@/services/connectors/linkedin-ads/http", () => ({
  linkedinAdsGet: m.get,
  linkedinAdsBatchGet: m.batch,
  linkedinCreativePath: (account: string, creative: string) => `adAccounts/${account}/creatives/${encodeURIComponent(`urn:li:sponsoredCreative:${creative}`)}`,
}));
vi.mock("@/services/connectors/linkedin-ads/post-link", () => ({ readPublicPostImage: async () => null }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantClient: () => ({
    from: (table: string) => {
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => (filters.push((r) => r[k] === undefined || r[k] === v), q),
        in: (k: string, v: unknown[]) => (filters.push((r) => v.includes(r[k])), q),
        range: async () => ({ data: (m.tables[table] ?? []).filter((r) => filters.every((f) => f(r as Record<string, unknown>))), error: null }),
      };
      return q;
    },
  }),
}));

import { linkedinCampaignMedia } from "../linkedin";

const T = "tenant-a";
const SHARE = "urn:li:share:7521456406189867008";
const IMG = "urn:li:image:D5610AQ";
const URL = "https://media.licdn.com/dms/image/ad.png";
const CREATIVE_PATH = `adAccounts/510000001/creatives/${encodeURIComponent("urn:li:sponsoredCreative:1617946754")}`;

beforeEach(() => {
  m.get.mockReset();
  m.batch.mockReset();
  m.tables = {
    ads_account_binding_details: [{ id: "ab1", tenant_id: T, provider_account_id: "510000001", platform: "linkedin", funding_source: "provider" }],
    ads_campaign_binding_details: [
      { id: "cb1", tenant_id: T, account_binding_id: "ab1", provider_campaign_id: "906064844", platform: "linkedin", funding_source: "provider" },
      { id: "cb2", tenant_id: "tenant-b", account_binding_id: "ab9", provider_campaign_id: "906064845", platform: "linkedin", funding_source: "provider" },
    ],
    ads_campaign_lifecycle: [
      { tenant_id: T, campaign_binding_id: "cb1", provider_creative_ids: ["1617946754", "1617946755"] },
      { tenant_id: "tenant-b", campaign_binding_id: "cb2", provider_creative_ids: ["999"] },
    ],
  };
  m.get.mockImplementation(async (_t: string, path: string) => {
    if (path === CREATIVE_PATH) return { id: "urn:li:sponsoredCreative:1617946754", campaign: "urn:li:sponsoredCampaign:906064844", intendedStatus: "DRAFT", content: { reference: SHARE } };
    return { elements: [], metadata: {} };
  });
  m.batch.mockImplementation(async (_t: string, resource: string) => {
    if (resource === "posts") return { [SHARE]: { content: { media: { id: IMG } } } };
    if (resource === "images") return { [IMG]: { downloadUrl: URL } };
    return {};
  });
});

describe("the first ad of a campaign Zavi launched, when LinkedIn's creative search leaves it out", () => {
  it("must catch: a draft ad the search skips still gives its ad set the image, read by the creative id Zavi stored at launch", async () => {
    await expect(linkedinCampaignMedia(T, ["906064844"])).resolves.toEqual({ "906064844": [URL] });
    const direct = m.get.mock.calls.filter((c) => String(c[1]).includes("/creatives/"));
    expect(direct.map((c) => c[1])).toEqual([CREATIVE_PATH]);
  });

  it("does not read another tenant's launched creative, and skips the direct read when the search already found the ad", async () => {
    await expect(linkedinCampaignMedia(T, ["906064845"])).resolves.toEqual({ "906064845": [] });
    expect(m.get.mock.calls.some((c) => String(c[1]).includes("/creatives/"))).toBe(false);
    m.get.mockImplementation(async (_t: string, path: string) =>
      path === CREATIVE_PATH ? {} : { elements: [{ campaign: "urn:li:sponsoredCampaign:906064844", content: { reference: SHARE } }], metadata: {} });
    await expect(linkedinCampaignMedia(T, ["906064844"])).resolves.toEqual({ "906064844": [URL] });
    expect(m.get.mock.calls.some((c) => String(c[1]).includes("/creatives/"))).toBe(false);
  });

  it("a revoked token on the direct read surfaces as revoked, any other failure leaves the thumbnail empty", async () => {
    m.get.mockImplementation(async (_t: string, path: string) => {
      if (path === CREATIVE_PATH) throw Object.assign(new Error("gone"), { code: "linkedin_ads_not_found" });
      return { elements: [], metadata: {} };
    });
    await expect(linkedinCampaignMedia(T, ["906064844"])).resolves.toEqual({ "906064844": [] });
    m.get.mockImplementation(async (_t: string, path: string) => {
      if (path === CREATIVE_PATH) throw Object.assign(new Error("revoked"), { code: "linkedin_ads_token_revoked" });
      return { elements: [], metadata: {} };
    });
    await expect(linkedinCampaignMedia(T, ["906064844"])).rejects.toMatchObject({ code: "linkedin_ads_token_revoked" });
  });
});
