
import { describe, it, expect, vi, beforeEach } from "vitest";

const gadsSearch = vi.hoisted(() => vi.fn());
const tenantRow = vi.hoisted(() => ({ value: { display_name: "Crumb Bakery", product_url: "https://crumbbakery.com" } as Record<string, unknown> }));
vi.mock("@/services/tools/google-ads/_client", () => ({ gadsSearch }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => ({ from: () => ({ select: () => ({ limit: async () => ({ data: [tenantRow.value], error: null }) }) }) }),
}));

import { loadGoogleBrandCampaignIds, readGoogleBrandCampaignIds, googleBrandOf, redactError, withGoalMatch, BRAND_SEARCH_CAMPAIGNS_MAX } from "../ad-goal-match";
import type { AdObjectFacts } from "../unattended-policy";

beforeEach(() => {
  gadsSearch.mockReset();
});

describe("readGoogleBrandCampaignIds", () => {
  it("must catch (bakery): a failed Google read returns its error text, and the old reader still says unknown (null)", async () => {
    const fail = Object.assign(new Error("Google Ads search returned more than 10 pages"), { code: "google_ads_query_truncated" });
    gadsSearch.mockImplementation(() => Promise.reject(fail));
    expect(await readGoogleBrandCampaignIds("t1")).toEqual({ error: "Google Ads search returned more than 10 pages" });
    expect(await loadGoogleBrandCampaignIds("t1")).toBeNull();
  });

  it("must not catch (SaaS): a read that works gives the brand campaigns, read per Search campaign with a bound", async () => {
    tenantRow.value = { display_name: "Ledgerly", product_url: "ledgerly.io" };
    const queries: string[] = [];
    gadsSearch.mockImplementation(async (_t: string, q: string) => {
      queries.push(q);
      if (q.includes("FROM campaign ")) return [{ campaign: { id: "11" } }, { campaign: { id: "12" } }];
      if (q.includes("campaign.id = 11")) return [{ campaign: { id: "11" }, adGroupCriterion: { keyword: { text: "ledgerly login" } } }];
      return [{ campaign: { id: "12" }, adGroupCriterion: { keyword: { text: "invoice software" } } }];
    });
    expect(await readGoogleBrandCampaignIds("t2")).toEqual({ ids: new Set(["11"]) });
    expect(queries[0]).toContain("campaign.advertising_channel_type = 'SEARCH'");
    expect(queries.some((q) => q.includes("FROM keyword_view") && !q.includes("campaign.id ="))).toBe(false);
  });

  it("must not catch: product_url as stored ({marketing, api} jsonb) is read, not thrown on", async () => {
    tenantRow.value = { display_name: "Ledgerly", product_url: { marketing: "https://www.ledgerly.io", api: "https://api.ledgerly.io" } };
    gadsSearch.mockImplementation(async (_t: string, q: string) => {
      if (q.includes("FROM campaign ")) return [{ campaign: { id: "21" } }];
      return [{ campaign: { id: "21" }, adGroupCriterion: { keyword: { text: "ledgerly pricing" } } }];
    });
    expect(await readGoogleBrandCampaignIds("t3")).toEqual({ ids: new Set(["21"]) });
    tenantRow.value = { display_name: "Ledgerly", product_url: { api: "https://api.ledgerly.io" } };
    expect(await readGoogleBrandCampaignIds("t3")).toEqual({ ids: new Set(["21"]) });
  });

  it("must catch: a Search campaign whose own keyword list is too long to read whole is held like brand; the others are judged", async () => {
    tenantRow.value = { display_name: "Ledgerly", product_url: "ledgerly.io" };
    gadsSearch.mockImplementation(async (_t: string, q: string) => {
      if (q.includes("FROM campaign ")) return [{ campaign: { id: "21" } }, { campaign: { id: "22" } }];
      if (q.includes("campaign.id = 21")) throw Object.assign(new Error("Google Ads search returned more than 10 pages"), { code: "google_ads_query_truncated" });
      return [{ campaign: { id: "22" }, adGroupCriterion: { keyword: { text: "invoice software" } } }];
    });
    expect(await readGoogleBrandCampaignIds("t3")).toEqual({ ids: new Set(["21"]) });
  });

  it("more Search campaigns than the bound: the read fails (only Search is then held)", async () => {
    tenantRow.value = { display_name: "Ledgerly", product_url: "ledgerly.io" };
    gadsSearch.mockImplementation(async (_t: string, q: string) =>
      q.includes("FROM campaign ") ? Array.from({ length: BRAND_SEARCH_CAMPAIGNS_MAX + 1 }, (_, k) => ({ campaign: { id: String(100 + k) } })) : [],
    );
    expect(await readGoogleBrandCampaignIds("t4")).toEqual({ error: `more than ${BRAND_SEARCH_CAMPAIGNS_MAX} enabled Search campaigns` });
  });

  it("a logged error carries no credential", () => {
    const raw = 'Google Ads search failed: 401 {"error":"invalid_grant","access_token":"ya29.a0AfH6SMBxYz","developer-token: abcdEFGHijklMNOPqrstUVWXyz0123456789abcd"}';
    const clean = redactError(raw);
    expect(clean).toContain("Google Ads search failed: 401");
    expect(clean).not.toMatch(/ya29|abcdEFGHijkl/);
  });
});

describe("the unattended gate's brand flag while the brand read fails", () => {
  const facts = (id: string, channelType: string | null): AdObjectFacts =>
    ({ id, conversionObjective: true, objective: null, learning: null, daysSinceEdit: null, lockDays: 0, spend7dUsd: 100, conversions7d: 3, targetCpaUsd: null, channelType }) as AdObjectFacts;
  it("must catch: a Search campaign (or one of unknown type) stays unknown (held)", () => {
    const out = withGoalMatch([facts("s", "SEARCH"), facts("u", null)], "google", { mode: "native", googleBrand: null, googlePurchaseCampaigns: null });
    expect(out.map((o) => o.brand)).toEqual([null, null]);
  });
  it("must not catch: Performance Max, Demand Gen, Display and Video are never brand", () => {
    for (const t of ["PERFORMANCE_MAX", "DEMAND_GEN", "DISPLAY", "VIDEO"]) expect(googleBrandOf("x", t, null)).toBe(false);
    expect(googleBrandOf("x", "SEARCH", new Set(["x"]))).toBe(true);
  });
});
