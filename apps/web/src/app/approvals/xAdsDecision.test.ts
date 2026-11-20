import { describe, expect, it } from "vitest";
import { decisionConsequence } from "./decisionCopy";
import { decisionTitle, handlerPreview, isHighStakesDecision } from "./approvalsHelpers";
import { parseProposalView } from "@/components/agents/proposalView";
import { isGrowthDecision } from "@/components/workspace/growth/growthReviewScope";

const pause = {
  account_id: "18ce54",
  campaign_id: "c1",
  name: "Spring promo",
  status: "PAUSED",
  currency: "USD",
  daily_budget: 40,
  rationale: "No conversions in 14 days on $560 spent.",
  summary: "Pause Spring promo.",
  exact_change: { rows: [{ item: "Status", before: "Active", after: "Paused" }] },
};
const update = {
  account_id: "18ce54",
  campaign_id: "c1",
  name: "Spring promo",
  currency: "EUR",
  changes: { daily_budget: 60, name: "Spring promo v2" },
  before: { name: "Spring promo", daily_budget: 40, total_budget: null },
  rationale: "CPA is half the account average.",
};
const create = {
  account_id: "18ce54",
  funding_instrument_id: "f1",
  name: "Launch week",
  currency: "USD",
  objective: "WEBSITE_CLICKS",
  daily_budget: 25,
  total_budget: null,
  tweet_ids: ["1", "2"],
  locations: [{ id: "us", name: "United States" }],
  start_time: "2026-10-03T00:00:00Z",
  end_time: null,
  launch: "PAUSED",
  rationale: "These two posts earned the most replies.",
};

describe("x_ads approvals copy", () => {
  it.each([
    ["meta_ads.update_campaign_budget", "campaign c1"],
    ["meta_ads.update_campaign_budget_review", "campaign c1"],
    ["meta_ads.update_ad_set_budget", "ad set a1"],
    ["meta_ads.update_ad_set_budget_review", "ad set a1"],
  ])("preserves the Meta budget preview for %s without a name", (handler, target) => {
    expect(handlerPreview(handler, {
      campaign_id: "c1",
      ad_set_id: "a1",
      currency: "USD",
      expected_current_daily_budget_usd: 10,
      daily_budget_usd: 20,
    })).toBe(`→ Meta · ${target} · $10 → $20/day`);
  });

  it("says what a pause and a resume do, with the daily budget at stake", () => {
    expect(decisionConsequence("x_ads.set_status", "x_ads.set_status", pause).approve).toBe(
      "Pauses “Spring promo” in X Ads. It stops delivering and stops spending ($40/day).",
    );
    const resume = decisionConsequence("x_ads.set_status", "x_ads.set_status", { ...pause, status: "ACTIVE" });
    expect(resume.approve).toContain("back on in X Ads");
    expect(resume.approve).toContain("up to $40/day");
    expect(resume.reject).toContain("stays paused");
  });

  it("lists every edit in the account's currency", () => {
    const c = decisionConsequence("x_ads.update_campaign", "x_ads.update_campaign", update);
    expect(c.approve).toBe("Updates “Spring promo” in X Ads: rename to “Spring promo v2”, daily budget EUR 40 → EUR 60. Nothing else on it changes.");
  });

  it("says a new campaign launches paused, or that it spends right away", () => {
    expect(decisionConsequence("x_ads.create_campaign", "x_ads.create_campaign", create).approve).toBe(
      "Creates “Launch week” in X Ads promoting 2 of your posts with a $25/day budget. It is created PAUSED: no spend until you turn it on.",
    );
    expect(decisionConsequence("x_ads.create_campaign", null, { ...create, launch: "ACTIVE" }).approve).toContain("goes live right away");
  });

  it("titles, previews and ranks the cards as ad-spend writes", () => {
    expect(decisionTitle("x_ads.create_campaign")).toEqual({ agentLabel: "X Ads", verbLabel: "Create campaign" });
    expect(handlerPreview("x_ads.update_campaign", update)).toBe("→ X · Spring promo · rename to “Spring promo v2”, daily budget EUR 40 → EUR 60");
    expect(handlerPreview("x_ads.create_campaign", create)).toBe("→ X · create “Launch week” ($25/day, 2 posts, PAUSED)");
    for (const cls of ["x_ads.set_status", "x_ads.update_campaign", "x_ads.create_campaign"]) {
      expect(isHighStakesDecision(cls, cls, {})).toBe(true);
      expect(isGrowthDecision({ decision_class: cls })).toBe(true);
    }
  });

  it("gives the proposal card an action, a money chip and the before/after rows", () => {
    const v = parseProposalView("x_ads.set_status", "x_ads.set_status", pause);
    expect(v.action).toBe("Pause this X campaign");
    expect(v.target).toBe("X · Spring promo");
    expect(v.chips).toContainEqual({ label: "−$40/day", tone: "neutral" });
    expect(v.fields).toEqual([{ label: "Status", value: "Active → Paused" }]);
    expect(v.about).toBe("Pause Spring promo.");
    expect(parseProposalView("x_ads.update_campaign", "x_ads.update_campaign", update).action).toBe("Raise daily budget");
    expect(parseProposalView("x_ads.create_campaign", null, create).chips).toContainEqual({ label: "$25/day", tone: "neutral" });
  });

  it("never invents an amount the body does not carry", () => {
    const bare = { name: "Spring promo", status: "PAUSED" };
    expect(decisionConsequence("x_ads.set_status", null, bare).approve).toBe("Pauses “Spring promo” in X Ads. It stops delivering and stops spending.");
    expect(parseProposalView("x_ads.set_status", null, bare).chips).toEqual([]);
  });
});
