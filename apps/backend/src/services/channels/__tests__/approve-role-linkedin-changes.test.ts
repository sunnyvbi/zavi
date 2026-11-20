import { describe, expect, it } from "vitest";
import { channelActionNeedsAdmin, channelActionRaisesSpend } from "../approve-role";
import { channelApproveForbiddenMessage } from "../approve-needs-admin";
import { buildLinkedInBudgetCardBody, buildLinkedInResumeCardBody, buildLinkedInTargetingCardBody } from "@/services/tools/linkedin-ads/_change-bodies";

const cut = { campaign_id: "22", account_id: "11", name: "Spring", kind: "daily", expected_current: { amount: "40.00", currency: "USD" }, proposed: { amount: "30.00", currency: "USD" }, rationale: "r" };
const raise = { ...cut, proposed: { amount: "52.00", currency: "USD" }, funded_by: { campaign_id: "23", name: "Loser" } };

describe("who may approve a LinkedIn change card", () => {
  it("a restart and a location change are owner/admin, whatever the payload", () => {
    expect(channelActionNeedsAdmin("linkedin_ads.resume_campaign", {}, "linkedin_ads")).toBe(true);
    expect(channelActionNeedsAdmin("linkedin_ads.update_targeting", {}, "linkedin_ads")).toBe(true);
  });
  it("a raise is owner/admin; a cut is any member's; an unreadable budget card is treated as a raise", () => {
    expect(channelActionNeedsAdmin("linkedin_ads.update_campaign_budget", raise, "linkedin_ads")).toBe(true);
    expect(channelActionNeedsAdmin("linkedin_ads.update_campaign_budget", cut, "linkedin_ads")).toBe(false);
    expect(channelActionRaisesSpend("linkedin_ads.update_campaign_budget", { ...cut, proposed: { amount: "40.01", currency: "USD" } })).toBe(true);
    expect(channelActionRaisesSpend("linkedin_ads.update_campaign_budget", { campaign_id: "22" })).toBe(true);
    expect(channelActionRaisesSpend("linkedin_ads.set_status", { status: "PAUSED" })).toBe(false);
  });
  it("tells a member what they cannot do in plain words", () => {
    expect(channelApproveForbiddenMessage("linkedin_ads.resume_campaign")).toMatch(/restart a LinkedIn campaign/);
    expect(channelApproveForbiddenMessage("linkedin_ads.update_campaign_budget")).toMatch(/raise a LinkedIn budget/);
    expect(channelApproveForbiddenMessage("linkedin_ads.update_targeting")).toMatch(/where a LinkedIn campaign shows/);
  });
});

describe("the cards say exactly what changes and what does not", () => {
  it("a budget card names both amounts, the direction, the paired cut it does not wait for, and the drift rule", () => {
    const c = buildLinkedInBudgetCardBody(raise as never);
    expect(c.title).toBe('Raise the daily budget of LinkedIn campaign "Spring" to $52.00');
    expect(c.card.change_sentence).toMatch(/from \$40\.00 to \$52\.00/);
    expect(c.card.change_sentence).toMatch(/\$12\.00 more a day/);
    expect(c.card.change_sentence).toMatch(/approved separately.*does not wait for the cut/);
    expect(c.card.change_sentence).not.toMatch(/approve that cut first/);
    expect(c.card.change_sentence).toMatch(/different current budget.*nothing changes/);
    expect((c.card.exact_change as { rows: unknown[] }).rows).toEqual([
      { item: 'Daily budget of "Spring"', before: "$40.00", after: "$52.00" },
      { item: "Paired with", before: 'Cut to "Loser" (separate card)', after: "Approved on its own" },
    ]);
    expect(buildLinkedInBudgetCardBody(cut as never).title).toMatch(/^Lower the daily budget/);
  });
  it("a restart card of a completed campaign names the new end date and says the budget is untouched", () => {
    const c = buildLinkedInResumeCardBody({ campaign_id: "22", account_id: "11", name: "Spring", rationale: "r", expected_status: "COMPLETED", run_start_at: null, run_end_at: "2099-02-28T23:59:59.000Z", budget: { kind: "daily", amount: "40", currency: "USD" } });
    expect(c.card.change_sentence).toMatch(/new end date of Feb 28, 2099 UTC/);
    expect(c.card.change_sentence).toMatch(/\$40\.00 a day again/);
    const total = buildLinkedInResumeCardBody({ campaign_id: "22", account_id: "11", name: "Spring", rationale: "r", expected_status: "PAUSED", run_start_at: null, run_end_at: null, budget: { kind: "total", amount: "400", currency: "USD" } });
    expect(total.card.change_sentence).toMatch(/whatever is left of its \$400\.00 total budget/);
    expect(total.card.change_sentence).not.toMatch(/in total again/);
    expect((c.card.exact_change as { rows: Array<{ item: string }> }).rows.map((r) => r.item)).toEqual(['Campaign "Spring"', "End date", "Budget"]);
    expect(c.card.link).toBe("https://www.linkedin.com/campaignmanager/accounts/11/campaigns/22/summary");
  });
  it("a location card lists what is added, what is removed and how to undo it", () => {
    const c = buildLinkedInTargetingCardBody({ campaign_id: "22", account_id: "11", name: "Spring", before_fingerprint: "x", before_criteria: null, after_criteria: null, places_before: ["United States", "Mexico"], places_after: ["United States", "Canada"], rationale: "r" });
    expect(c.card.change_sentence).toMatch(/adds Canada; removes Mexico/);
    expect(c.card.change_sentence).toMatch(/set the locations back to United States, Mexico/);
  });
});
