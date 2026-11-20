import { beforeEach, describe, expect, it, vi } from "vitest";

const SHARED = "900";
const m = vi.hoisted(() => ({ wallet: false, tags: vi.fn(), domains: vi.fn(), conversions: vi.fn(), walletConversions: vi.fn(), ownList: vi.fn() }));

vi.mock("@/services/tools/linkedin-ads/_wallet", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  linkedinAccountAccess: async (_t: string, account: string) =>
    m.wallet && account === SHARED
      ? { kind: "wallet", token: "managed-token", currency: "USD", campaignUrns: ["urn:li:sponsoredCampaign:111"], group: { binding: { provider_account_id: SHARED }, campaignBindingIds: ["cb-1"], campaignIds: ["111"] } }
      : { kind: "own" },
}));
vi.mock("@/services/tools/linkedin-ads/list_campaigns", () => ({
  walletCampaigns: async () => [{ id: "111", name: "Mine", status: "ACTIVE", objective: "LEAD_GENERATION", budget: null, campaign_group_id: "77", last_modified_at: null }],
}));
vi.mock("@/services/connectors/linkedin-ads/client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listLinkedInCampaigns: (...a: unknown[]) => m.ownList(...a),
}));
vi.mock("@/services/connectors/linkedin-ads/account-reads", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readLinkedInInsightTags: (...a: unknown[]) => m.tags(...a),
  readLinkedInInsightTagDomains: (...a: unknown[]) => m.domains(...a),
  readLinkedInConversions: (...a: unknown[]) => m.conversions(...a),
  readLinkedInConversionsWithToken: (...a: unknown[]) => m.walletConversions(...a),
}));

import { gradeLinkedInMeasurement, linkedinAdsMeasurementHealthTool } from "../measurement_health";

const NOW = new Date("2026-11-05T12:00:00Z");
const daysAgo = (d: number) => NOW.getTime() - d * 86_400_000;
const ctx = { tenant_id: "t-a", log: () => undefined } as never;
const campaign = (id: string, objective: string) => ({ id, name: `C${id}`, status: "ACTIVE", objective, budget: null, campaign_group_id: "9", last_modified_at: null, created_at: null, schedule_end_at: null });
type Out = { overall_status: string; reasons: string[]; campaign_coverage: Array<{ campaign_id: string; event_covered: string }>; conversions: Array<{ id: string; campaign_ids: string[] }>; insight_tag: { present: boolean | null; domains: unknown[] }; shared_account: boolean };

beforeEach(() => {
  m.wallet = false;
  for (const f of [m.tags, m.domains, m.conversions, m.walletConversions, m.ownList]) f.mockReset();
  vi.useRealTimers();
});

describe("linkedin_ads_measurement_health grades the tag and the rules, never the results", () => {
  it("must catch: a tag that stopped firing is degraded even with thousands of past callbacks, and a conversion campaign with no firing rule is uncovered while a reach campaign needs none", () => {
    const g = gradeLinkedInMeasurement(
      {
        tags: [{ id: 1 }],
        domains: [{ domainName: "example.com", lastCallbackAt: daysAgo(10) }],
        conversions: [
          { id: 5, name: "Lead", type: "LEAD", enabled: true, lastCallbackAt: daysAgo(12), associatedCampaigns: [{ campaign: "urn:li:sponsoredCampaign:1" }] },
          { id: 6, name: "Signup", type: "SIGN_UP", enabled: true, lastCallbackAt: daysAgo(1), associatedCampaigns: ["urn:li:sponsoredCampaign:2"] },
        ],
        campaigns: [campaign("1", "LEAD_GENERATION"), campaign("2", "WEBSITE_CONVERSIONS"), campaign("3", "BRAND_AWARENESS"), campaign("4", "WEBSITE_CONVERSIONS")],
        lookback_days: 7,
        shared_account: false,
      },
      NOW,
    );
    expect(g.overall_status).toBe("degraded");
    expect(g.reasons[0]).toMatch(/no domain within the last 7 days/);
    expect(Object.fromEntries(g.coverage.map((c) => [c.campaign_id, c.event_covered]))).toEqual({ "1": "no", "2": "yes", "3": "not_needed", "4": "no" });
    expect(g.coverage.find((c) => c.campaign_id === "4")?.note).toMatch(/no conversion rule is attached/);
    expect(g.conversions.map((c) => c.firing_in_window)).toEqual([false, true]);
    expect(g.domains[0]).toMatchObject({ last_callback_age_days: 10, firing_in_window: false });
  });

  it("no tag at all is no_tag; a tag that fires with a firing rule is healthy; an unreadable domain list does not fake a status", () => {
    const base = { conversions: [{ id: 1, type: "LEAD", enabled: true, lastCallbackAt: daysAgo(2), associatedCampaigns: [] }], campaigns: [], lookback_days: 7, shared_account: false };
    expect(gradeLinkedInMeasurement({ ...base, tags: [], domains: [] }, NOW).overall_status).toBe("no_tag");
    expect(gradeLinkedInMeasurement({ ...base, tags: [{ id: 1 }], domains: [{ domainName: "a.com" }] }, NOW).overall_status).toBe("no_tag");
    expect(gradeLinkedInMeasurement({ ...base, tags: [{ id: 1 }], domains: [{ domainName: "a.com", lastCallbackAt: daysAgo(1) }] }, NOW).overall_status).toBe("healthy");
    const unread = gradeLinkedInMeasurement({ ...base, tags: [{ id: 1 }], domains: null }, NOW);
    expect(unread.overall_status).toBe("healthy");
    expect(unread.reasons[0]).toMatch(/could not be read/);
    const blind = gradeLinkedInMeasurement({ ...base, conversions: [], tags: [{ id: 1 }], domains: null }, NOW);
    expect(blind.overall_status).toBe("degraded");
    expect(blind.reasons[0]).toMatch(/nothing shows the tag working/);
    expect(gradeLinkedInMeasurement({ ...base, conversions: [{ ...base.conversions[0], lastCallbackAt: undefined }], tags: [{ id: 1 }], domains: null }, NOW).overall_status).toBe("degraded");
    expect(gradeLinkedInMeasurement({ ...base, conversions: [{ ...base.conversions[0], enabled: false }], tags: [{ id: 1 }], domains: [{ domainName: "a.com", lastCallbackAt: daysAgo(1) }] }, NOW).overall_status).toBe("degraded");
  });

  it("must catch: a wallet account never reads Zavi's shared tag or domains, and only conversion rules attached solely to this workspace's campaigns come back; a rule shared with another tenant's campaign is dropped, since its callbacks are not this workspace's", async () => {
    m.wallet = true;
    m.walletConversions.mockResolvedValue([
      { id: 1, type: "LEAD", enabled: true, lastCallbackAt: Date.now() - 3600_000, associatedCampaigns: [{ campaign: "urn:li:sponsoredCampaign:111" }, { campaign: "urn:li:sponsoredCampaign:222" }] },
      { id: 2, type: "SIGN_UP", enabled: true, lastCallbackAt: Date.now() - 3600_000, associatedCampaigns: ["urn:li:sponsoredCampaign:333"] },
      { id: 3, type: "LEAD", enabled: true, lastCallbackAt: Date.now() - 3600_000, associatedCampaigns: [{ campaign: "urn:li:sponsoredCampaign:111" }] },
    ]);
    const out = (await linkedinAdsMeasurementHealthTool.execute(ctx, { account_id: SHARED })) as Out;
    expect(m.tags).not.toHaveBeenCalled();
    expect(m.domains).not.toHaveBeenCalled();
    expect(m.conversions).not.toHaveBeenCalled();
    expect(m.ownList).not.toHaveBeenCalled();
    expect(m.walletConversions.mock.calls[0]).toEqual(["managed-token", SHARED]);
    expect(out.shared_account).toBe(true);
    expect(out.insight_tag).toMatchObject({ present: null, domains: [] });
    expect(out.conversions.map((c) => [c.id, c.campaign_ids])).toEqual([["3", ["111"]]]);
    expect(JSON.stringify(out)).not.toMatch(/222|333/);
    expect(out.overall_status).toBe("healthy");
  });

  it("an own account reads all three lists and refuses a non-numeric account id", async () => {
    m.ownList.mockResolvedValue([campaign("1", "LEAD_GENERATION")]);
    m.tags.mockResolvedValue([{ id: 1 }]);
    m.domains.mockRejectedValue(new Error("boom"));
    m.conversions.mockResolvedValue([{ id: 9, type: "LEAD", enabled: true, lastCallbackAt: Date.now() - 1000, associatedCampaigns: ["urn:li:sponsoredCampaign:1"] }]);
    const out = (await linkedinAdsMeasurementHealthTool.execute(ctx, { account_id: "500", lookback_days: 3 })) as Out & { insight_tag: { domains_readable: boolean } };
    expect(out.insight_tag.domains_readable).toBe(false);
    expect(out.campaign_coverage).toEqual([expect.objectContaining({ campaign_id: "1", event_covered: "yes" })]);
    await expect(linkedinAdsMeasurementHealthTool.execute(ctx, { account_id: "urn:li:sponsoredAccount:500" })).rejects.toThrow();
  });
});
