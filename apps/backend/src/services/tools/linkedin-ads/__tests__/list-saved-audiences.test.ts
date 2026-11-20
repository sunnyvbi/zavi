import { beforeEach, describe, expect, it, vi } from "vitest";

const SHARED = "900";
const m = vi.hoisted(() => ({ wallet: false, templates: vi.fn(), campaigns: vi.fn() }));

vi.mock("@/services/tools/linkedin-ads/_wallet", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  linkedinAccountAccess: async (_t: string, account: string) => (m.wallet && account === SHARED ? { kind: "wallet", token: "managed-token", currency: "USD", campaignUrns: [], group: { binding: { provider_account_id: SHARED }, campaignBindingIds: [], campaignIds: [] } } : { kind: "own" }),
}));
vi.mock("@/services/connectors/linkedin-ads/account-reads", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listLinkedInSavedAudiences: (...a: unknown[]) => m.templates(...a),
  readLinkedInCampaignTargeting: (...a: unknown[]) => m.campaigns(...a),
}));

import { canonicalTargeting } from "@/services/connectors/linkedin-ads/account-reads";
import { linkedinAdsListSavedAudiencesTool, mapSavedAudiences } from "../list_saved_audiences";

const ctx = { tenant_id: "t-a", log: () => undefined } as never;
const geo = (urns: string[], titles?: string[]) => ({
  include: { and: [{ or: { "urn:li:adTargetingFacet:locations": urns } }, ...(titles ? [{ or: { "urn:li:adTargetingFacet:titles": titles } }] : [])] },
});
type Out = { usage_available: boolean; audiences: Array<{ id: string; in_use: boolean | null; used_by_campaigns: unknown }>; summary: { unused_ids: string[] | null; in_use: number | null } };

beforeEach(() => {
  m.wallet = false;
  m.templates.mockReset();
  m.campaigns.mockReset();
});

describe("linkedin_ads_list_saved_audiences says which saved audiences nothing uses", () => {
  it("must catch: in_use matches on identical criteria regardless of key or list order, an edited campaign no longer counts, and a failed campaign read leaves in_use null", async () => {
    m.templates.mockResolvedValue([
      { id: 1, name: "US founders", targetingCriteria: geo(["urn:li:geo:103644278", "urn:li:geo:101174742"], ["urn:li:title:1"]), approximateMemberCount: 12000, created: Date.parse("2026-01-01T00:00:00Z"), lastModified: Date.parse("2026-02-01T00:00:00Z") },
      { id: 2, name: "Never used", targetingCriteria: geo(["urn:li:geo:1"]) },
      { id: 3, name: "Edited away", targetingCriteria: geo(["urn:li:geo:2"]) },
    ]);
    m.campaigns.mockResolvedValue([
      { id: 10, name: "Live", status: "ACTIVE", targetingCriteria: { include: { and: [{ or: { "urn:li:adTargetingFacet:titles": ["urn:li:title:1"] } }, { or: { "urn:li:adTargetingFacet:locations": ["urn:li:geo:101174742", "urn:li:geo:103644278"] } }] } } },
      { id: 11, name: "Changed", status: "PAUSED", targetingCriteria: geo(["urn:li:geo:2", "urn:li:geo:3"]) },
      { id: 12, name: "No targeting" },
    ]);
    const out = (await linkedinAdsListSavedAudiencesTool.execute(ctx, { account_id: "500" })) as Out;
    expect(m.campaigns.mock.calls[0]).toEqual(["t-a", "500", ["ACTIVE", "PAUSED", "DRAFT", "COMPLETED"]]);
    expect(out.usage_available).toBe(true);
    expect(out.audiences.map((a) => [a.id, a.in_use])).toEqual([["1", true], ["2", false], ["3", false]]);
    expect(out.audiences[0].used_by_campaigns).toEqual([{ campaign_id: "10", campaign_name: "Live", status: "ACTIVE" }]);
    expect(out.summary).toMatchObject({ in_use: 1, unused_ids: ["2", "3"] });

    m.campaigns.mockRejectedValue(new Error("429"));
    const unread = (await linkedinAdsListSavedAudiencesTool.execute(ctx, { account_id: "500" })) as Out;
    expect(unread.usage_available).toBe(false);
    expect(unread.audiences.every((a) => a.in_use === null && a.used_by_campaigns === null)).toBe(true);
    expect(unread.summary.unused_ids).toBeNull();
  });

  it("must catch: Zavi's shared account is refused, so one workspace never sees another's templates", async () => {
    m.wallet = true;
    await expect(linkedinAdsListSavedAudiencesTool.execute(ctx, { account_id: SHARED })).rejects.toMatchObject({ code: "linkedin_ads_shared_account" });
    expect(m.templates).not.toHaveBeenCalled();
  });

  it("canonical targeting ignores order but not content", () => {
    expect(canonicalTargeting(geo(["a", "b"]))).toBe(canonicalTargeting(geo(["b", "a"])));
    expect(canonicalTargeting(geo(["a"]))).not.toBe(canonicalTargeting(geo(["a", "b"])));
    expect(mapSavedAudiences([{ id: 1, name: "x" }], null)[0]).toMatchObject({ in_use: null, approximate_member_count: null, days_since_modified: null });
  });
});
