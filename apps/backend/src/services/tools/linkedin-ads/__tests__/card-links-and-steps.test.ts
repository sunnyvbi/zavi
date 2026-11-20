import { describe, expect, it } from "vitest";
import {
  buildLinkedInAdStatusCardBody,
  buildLinkedInArchiveCardBody,
  buildLinkedInBudgetCardBody,
  buildLinkedInCreateAdCardBody,
  buildLinkedInCreateCampaignCardBody,
  buildLinkedInDuplicateCardBody,
  buildLinkedInGroupEditCardBody,
  buildLinkedInResumeCardBody,
  buildLinkedInSwapAdCardBody,
  linkedinManagerLink,
} from "../_change-bodies";

const CM = "https://www.linkedin.com/campaignmanager/accounts/508412345";
const SUMMARY = `${CM}/campaigns/900111/summary`;
const ORG = "urn:li:organization:42";
const body = (c: { card: Record<string, unknown> }) => (c.card.step as { body: string }).body;

describe("LinkedIn card links: straight to the campaign where LinkedIn has a page for it", () => {
  it("a campaign id builds the campaign's summary page; anything that is not a plain number never reaches the URL", () => {
    expect(linkedinManagerLink("508412345", "900111")).toBe(SUMMARY);
    expect(linkedinManagerLink("508412345", null)).toBe(`${CM}/campaigns`);
    expect(linkedinManagerLink("508412345", "900111/../../billing")).toBe(`${CM}/campaigns`);
    expect(linkedinManagerLink("508412345", "")).toBe(`${CM}/campaigns`);
  });

  it("budget, restart, ad on/off, new ad and ad swap cards open the campaign's own page", () => {
    const budget = buildLinkedInBudgetCardBody({ campaign_id: "900111", account_id: "508412345", name: "Q4", kind: "daily", expected_current: { amount: "50.00", currency: "USD" }, proposed: { amount: "75.00", currency: "USD" }, rationale: "Caps by noon." });
    const resume = buildLinkedInResumeCardBody({ campaign_id: "900111", account_id: "508412345", name: "Q4", rationale: "It worked.", expected_status: "PAUSED", run_start_at: null, run_end_at: null, budget: null });
    const adOff = buildLinkedInAdStatusCardBody({ creative_id: "77", campaign_id: "900111", account_id: "508412345", campaign_name: "Q4", ad_name: "Hero", expected_status: "ACTIVE", status: "PAUSED", rationale: "Weak CTR." });
    const newAd = buildLinkedInCreateAdCardBody({ campaign_id: "900111", account_id: "508412345", campaign_name: "Q4", campaign_status: "ACTIVE", associated_entity: ORG, source: { kind: "post", post_urn: "urn:li:share:1" }, go_live: false, expected_ad_count: 1, rationale: "Fresh copy." } as never);
    const swap = buildLinkedInSwapAdCardBody({ campaign_id: "900111", account_id: "508412345", campaign_name: "Q4", associated_entity: ORG, old_creative_id: "77", old_ad_name: "Hero", source: { kind: "post", post_urn: "urn:li:share:1" }, rationale: "Fatigue." } as never);
    for (const c of [budget, resume, adOff, newAd, swap]) expect(c.card.link).toBe(SUMMARY);
  });
});

describe("LinkedIn card steps: where no link reaches the thing, the card says where to look", () => {
  it("an ad card names the campaign the link opens and the ad to find in it, since LinkedIn has no per-ad link", () => {
    const c = buildLinkedInAdStatusCardBody({ creative_id: "77", campaign_id: "900111", account_id: "508412345", campaign_name: "Q4", ad_name: "Hero", expected_status: "ACTIVE", status: "PAUSED", rationale: "Weak CTR." });
    expect(body(c)).toContain('Where to find it in LinkedIn: the link opens the campaign "Q4". Find the ad "Hero" in its ads.');
    expect(c.card.where).toBeTruthy();
  });

  it("a campaign group card opens the Campaigns tab and explains LinkedIn's renamed levels", () => {
    const c = buildLinkedInGroupEditCardBody({ group_id: "600", account_id: "508412345", name: "Brand", rationale: "End it.", last_modified_at: null, changes: { status: { before: "ACTIVE", after: "PAUSED" } } });
    expect(c.card.link).toBe(`${CM}/campaign-groups`);
    expect(body(c)).toContain('Open "Brand" there.');
    expect(body(c)).toContain('LinkedIn now calls a campaign group a "Campaign" and a campaign an "Ad set".');
  });

  it("archiving a group opens the Campaigns tab and says to filter by Archived; deleting says it is gone from every list", () => {
    const archive = buildLinkedInArchiveCardBody({ target: "campaign_group", id: "600", account_id: "508412345", campaign_id: null, name: "Brand", expected_status: "PAUSED", mode: "archive", rationale: "Done." });
    const del = buildLinkedInArchiveCardBody({ target: "creative", id: "77", account_id: "508412345", campaign_id: "900111", name: "Hero", expected_status: "PAUSED", mode: "delete", rationale: "Done." });
    expect(archive.card.link).toBe(`${CM}/campaign-groups`);
    expect(body(archive)).toContain("set the status filter to Archived");
    expect(del.card.link).toBe(SUMMARY);
    expect(body(del)).toContain("once deleted it no longer shows in any list");
    expect(body(del)).not.toContain("Archived");
  });

  it("a new campaign or a copy, which has no id yet, says what to look for and where", () => {
    const create = buildLinkedInCreateCampaignCardBody({ account_id: "508412345", group_id: "600", group_name: "Brand", expected_group_status: "ACTIVE", name: "CTOs US", daily_budget: { amount: "40.00", currency: "USD" }, unit_cost: { amount: "8.00", currency: "USD" }, geo_urns: ["urn:li:geo:103644278"], country: "US", language: "en", associated_entity: ORG, objective_type: null, post_urn: null, places: ["United States"], rationale: "Test." });
    const groupCopy = buildLinkedInDuplicateCardBody({ target: "campaign_group", source_id: "600", account_id: "508412345", source_name: "Brand", new_name: "Brand copy", group_id: null, campaign_id: null, copy_ads: false, source_last_modified_at: null, rationale: "Test." });
    expect(create.card.link).toBe(`${CM}/campaigns`);
    expect(body(create)).toContain('Find the paused campaign "CTOs US" there once created; it sits under "Brand".');
    expect(groupCopy.card.link).toBe(`${CM}/campaign-groups`);
    expect(body(groupCopy)).toContain('Find the paused copy "Brand copy" there once created.');
  });

  it("a card whose link already opens the thing carries no steps", () => {
    const c = buildLinkedInBudgetCardBody({ campaign_id: "900111", account_id: "508412345", name: "Q4", kind: "daily", expected_current: { amount: "50.00", currency: "USD" }, proposed: { amount: "75.00", currency: "USD" }, rationale: "Caps by noon." });
    expect(c.card.where).toBeUndefined();
    expect(body(c)).not.toContain("Where to find it");
  });
});
