import { describe, it, expect } from "vitest";
import { AD_CHANGE_HEADLINE_FIELDS, adCardTitle, adChangeHeadline, isAdChangeHeadlineClass, linkedinLaunchHeadline } from "@zavi/shared";
import { decisionCardTitle } from "../decision-copy";

describe("adChangeHeadline", () => {
  it("the incident's raise reads as a raise of that campaign, not as a vague sentence", () => {
    const body = {
      campaign_id: "24109304360",
      name: "Search A",
      verified_name: "Search A",
      daily_budget_usd: 120,
      expected_current_daily_budget_usd: 110,
      rationale: "x",
      over_cap: true,
      decision_evidence: { headline: "Let the campaign that books spend the extra $10 a day" },
    };
    expect(adChangeHeadline("google_ads.update_campaign_budget_review", body)).toBe("Raise “Search A” from $110 to $120 a day");
  });

  it("a cut says Cut, with both amounts", () => {
    expect(
      adChangeHeadline("google_ads.update_campaign_budget_review", { campaign_id: "1", verified_name: "Search B", daily_budget_usd: 10, expected_current_daily_budget_usd: 20 }),
    ).toBe("Cut “Search B” from $20 to $10 a day");
    expect(adChangeHeadline("meta_ads.update_ad_set_budget_review", { ad_set_id: "9", verified_name: "Search B", daily_budget_usd: 40, expected_current_daily_budget_usd: 50, currency: "USD" })).toBe(
      "Cut “Search B” from $50 to $40 a day",
    );
  });

  it("no name: the object's id; cents and another currency print as money", () => {
    expect(adChangeHeadline("meta_ads.update_campaign_budget", { campaign_id: "1202", daily_budget_usd: 12.5, expected_current_daily_budget_usd: 10 })).toBe(
      "Raise campaign 1202 from $10 to $12.50 a day",
    );
    expect(adChangeHeadline("meta_ads.update_ad_set_budget", { ad_set_id: "77", daily_budget_usd: 600, expected_current_daily_budget_usd: 500, currency: "INR" })).toBe(
      "Raise ad set 77 from ₹500 to ₹600 a day",
    );
  });

  it("the same amount reads as keep", () => {
    expect(adChangeHeadline("google_ads.update_campaign_budget", { campaign_id: "1", daily_budget_usd: 20, expected_current_daily_budget_usd: 20 })).toBe("Keep campaign 1 at $20 a day");
  });

  it("pause and resume use each platform's own status words", () => {
    expect(adChangeHeadline("google_ads.set_status_review", { campaign_id: "1", status: "PAUSED", verified_name: "A" })).toBe("Pause “A”");
    expect(adChangeHeadline("google_ads.set_status_review", { campaign_id: "1", status: "PAUSED", name: "A" })).toBe("Pause “A” (campaign 1)");
    expect(adChangeHeadline("google_ads.set_status_review", { level: "ad_group", campaign_id: "1", ad_group_id: "5", status: "ENABLED" })).toBe("Turn on ad group 5");
    expect(adChangeHeadline("meta_ads.set_status_review", { object_id: "3", level: "adset", status: "ACTIVE" })).toBe("Turn on ad set 3");
    expect(adChangeHeadline("google_ads.set_status_review", { campaign_id: "1", status: "ACTIVE" })).toBeNull();
    expect(adChangeHeadline("meta_ads.set_status_review", { object_id: "3", level: "adset", status: "ENABLED" })).toBeNull();
  });

  it("a long name is cut by characters, never mid-surrogate", () => {
    const name = "🚗".repeat(100);
    const h = adChangeHeadline("google_ads.update_campaign_budget", { campaign_id: "1", verified_name: name, daily_budget_usd: 2, expected_current_daily_budget_usd: 1 })!;
    expect(h.startsWith("Raise “")).toBe(true);
    expect(h).toContain("…” from $1 to $2 a day");
    expect(h).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("must not touch: other classes, unreadable amounts, no name or id", () => {
    expect(adChangeHeadline("google_ads.add_keywords", { campaign_id: "1" })).toBeNull();
    expect(adChangeHeadline("x_ads.update_campaign", { daily_budget_usd: 1, expected_current_daily_budget_usd: 2 })).toBeNull();
    expect(adChangeHeadline("google_ads.update_campaign_budget", { campaign_id: "1", daily_budget_usd: "10", expected_current_daily_budget_usd: 20 })).toBeNull();
    expect(adChangeHeadline("google_ads.update_campaign_budget", { daily_budget_usd: 10, expected_current_daily_budget_usd: 20 })).toBeNull();
    expect(adChangeHeadline(null, {})).toBeNull();
    expect(isAdChangeHeadlineClass("google_ads.update_campaign_budget_review")).toBe(true);
    expect(isAdChangeHeadlineClass("google_ads.create_campaign")).toBe(false);
  });

  it("adCardTitle: the headline for a budget card, the stored title otherwise", () => {
    expect(adCardTitle({ title: "Let it spend more", exec_class: "google_ads.update_campaign_budget_review", exec_payload: { campaign_id: "1", daily_budget_usd: 12, expected_current_daily_budget_usd: 10 } })).toBe(
      "Raise campaign 1 from $10 to $12 a day",
    );
    expect(adCardTitle({ title: "Write a blog post", exec_class: null })).toBe("Write a blog post");
  });
});

describe("linkedinLaunchHeadline", () => {
  const body = { name: "CFO Checklist", total_budget_cents: 50000, currency: "USD", end_time: Date.UTC(2026, 10, 30, 17, 0) };

  it("says which campaign, how much and until when", () => {
    expect(linkedinLaunchHeadline("linkedin_ads.launch_campaign", body)).toBe("Launch “CFO Checklist”: $500 total, ends Nov 30, 2026, 5:00 PM UTC");
  });

  it("prints the advertiser's own currency and Zavi's name tags never reach the founder", () => {
    expect(linkedinLaunchHeadline("linkedin_ads.launch_campaign", { ...body, name: "Zavi · CFO · zvf101c3e846", currency: "INR", total_budget_cents: 123450 })).toBe(
      "Launch “CFO”: ₹1,234.50 total, ends Nov 30, 2026, 5:00 PM UTC",
    );
  });

  it.each([
    ["no name", { name: undefined }],
    ["blank name", { name: "   " }],
    ["no amount", { total_budget_cents: undefined }],
    ["zero amount", { total_budget_cents: 0 }],
    ["negative amount", { total_budget_cents: -500 }],
    ["amount as text", { total_budget_cents: "50000" }],
    ["no currency, which must not print as dollars", { currency: undefined }],
    ["a garbled currency", { currency: "dollars" }],
    ["no end", { end_time: undefined }],
    ["an end as text", { end_time: "2026-11-30" }],
    ["an end Date cannot hold", { end_time: 8.65e15 }],
    ["a zero end", { end_time: 0 }],
  ])("%s gets null rather than a partial sentence", (_label, over) => {
    expect(linkedinLaunchHeadline("linkedin_ads.launch_campaign", { ...body, ...over })).toBeNull();
  });

  it("titles nothing else, and a launch never gets a platform-name stamp", () => {
    expect(linkedinLaunchHeadline("meta_ads.launch_campaign", body)).toBeNull();
    expect(linkedinLaunchHeadline(null, body)).toBeNull();
    expect(adChangeHeadline("meta_ads.launch_campaign", body)).toBeNull();
    expect(isAdChangeHeadlineClass("linkedin_ads.launch_campaign")).toBe(false);
  });

  const HEADLINE = "Launch “CFO Checklist”: $500 total, ends Nov 30, 2026, 5:00 PM UTC";

  it("the one headline every surface reads carries the launch, on both rails", () => {
    expect(adChangeHeadline("linkedin_ads.launch_campaign", body)).toBe(HEADLINE);
    expect(adCardTitle({ title: "Launch the campaign", exec_class: "linkedin_ads.launch_campaign", exec_payload: body })).toBe(HEADLINE);
    expect(decisionCardTitle("linkedin_ads.launch_campaign", body)).toBe(HEADLINE);
  });

  it("a list that projects only the headline fields still gets the whole launch headline", () => {
    const narrow = Object.fromEntries(AD_CHANGE_HEADLINE_FIELDS.flatMap((f) => (f in body ? [[f, body[f as keyof typeof body]]] : [])));
    expect(adCardTitle({ title: "Launch the campaign", exec_class: "linkedin_ads.launch_campaign", exec_payload: narrow })).toBe(HEADLINE);
  });

  it("a launch missing its money or end keeps the caller's title, never a partial sentence", () => {
    expect(adChangeHeadline("linkedin_ads.launch_campaign", { ...body, end_time: undefined })).toBeNull();
    expect(adCardTitle({ title: "Stored title", exec_class: "linkedin_ads.launch_campaign", exec_payload: { name: "X" } })).toBe("Stored title");
  });
});
