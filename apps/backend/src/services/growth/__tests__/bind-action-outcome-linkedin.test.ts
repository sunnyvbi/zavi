import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/growth/action-outcomes", async (orig) => {
  const actual = await orig<typeof import("@/services/growth/action-outcomes")>();
  return { targetKindForClass: actual.targetKindForClass, recordActionOutcome: vi.fn(), enrichBaseline: vi.fn(), readMetaSnapshot: vi.fn(), readGoogleSnapshot: vi.fn() };
});
vi.mock("@/services/connectors/linkedin-ads/outcome-snapshot", () => ({ readLinkedInSnapshot: vi.fn() }));

import { bindActionOutcome } from "../bind-action-outcome";
import { enrichBaseline, readGoogleSnapshot, readMetaSnapshot, recordActionOutcome, targetKindForClass } from "@/services/growth/action-outcomes";
import { readLinkedInSnapshot } from "@/services/connectors/linkedin-ads/outcome-snapshot";

const record = vi.mocked(recordActionOutcome);
const enrich = vi.mocked(enrichBaseline);
const li = vi.mocked(readLinkedInSnapshot);
const DEC = "11111111-1111-1111-1111-111111111111";
const TEN = "22222222-2222-2222-2222-222222222222";
const SNAP = { spend: 40.5, roas: null, conversions: 3, purchase_value: null, impressions: 900 };
const bind = (decisionClass: string, body: unknown, decisionOutcome: "approved" | "rejected" = "approved") => bindActionOutcome({ decisionId: DEC, tenantId: TEN, decisionClass, decisionOutcome, body });

beforeEach(() => {
  vi.clearAllMocks();
  record.mockResolvedValue(9);
  li.mockResolvedValue(SNAP);
});

describe("bindActionOutcome: LinkedIn joins the scoreboard", () => {
  it("must catch: a pause, a restart and a budget change each bind to the LinkedIn campaign and read their baseline from LinkedIn, never Meta or Google", async () => {
    await bind("linkedin_ads.set_status", { campaign_id: "123", account_id: "500", status: "PAUSED", name: "x", rationale: "waste" });
    await bind("linkedin_ads.resume_campaign", { campaign_id: "124", account_id: "500", name: "y", rationale: "winner" });
    await bind("linkedin_ads.update_campaign_budget", { campaign_id: "125", account_id: "500", name: "z", kind: "daily", expected_current: { amount: "20.00", currency: "USD" }, proposed: { amount: "26.00", currency: "USD" }, rationale: "scale" });
    expect(record.mock.calls.map((c) => [c[0].actionClass, c[0].subjectId, c[0].subjectType, c[0].measurementWindowDays])).toEqual([
      ["linkedin_ads.set_status", "123", "campaign", 14],
      ["linkedin_ads.resume_campaign", "124", "campaign", 14],
      ["linkedin_ads.update_campaign_budget", "125", "campaign", 14],
    ]);
    expect(li.mock.calls.map((c) => [c[0], c[1]])).toEqual([[TEN, "123"], [TEN, "124"], [TEN, "125"]]);
    expect(vi.mocked(readMetaSnapshot)).not.toHaveBeenCalled();
    expect(vi.mocked(readGoogleSnapshot)).not.toHaveBeenCalled();
    expect(enrich).toHaveBeenLastCalledWith({ id: 9, status: "enriched", baselineMetrics: SNAP });
    for (const cls of ["linkedin_ads.set_status", "linkedin_ads.resume_campaign", "linkedin_ads.update_campaign_budget"]) expect(targetKindForClass(cls)).toBe("linkedin_object");
    expect(targetKindForClass("meta_ads.set_status")).toBe("meta_object");
  });

  it("a launch and a bundle are not measured here, a malformed body binds nothing, and a no-data baseline is said so", async () => {
    await bind("linkedin_ads.launch_campaign", { campaign_binding_id: DEC, rationale: "ten chars long" });
    await bind("linkedin_ads.create_campaign_bundle", { group: {} });
    await bind("linkedin_ads.set_status", { campaign_id: "urn:li:sponsoredCampaign:1", status: "PAUSED" });
    expect(record).not.toHaveBeenCalled();
    li.mockResolvedValueOnce(null);
    await bind("linkedin_ads.set_status", { campaign_id: "77", status: "PAUSED" }, "rejected");
    expect(record.mock.calls[0][0]).toMatchObject({ decisionOutcome: "rejected", subjectId: "77" });
    expect(enrich).toHaveBeenCalledWith({ id: 9, status: "no_data" });
  });
});
