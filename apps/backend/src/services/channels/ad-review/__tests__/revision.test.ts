import { describe, expect, it, vi } from "vitest";
import { failedWithNothingMade, readAdReview, revisedAd, StaleAdRevision, type ReviewRow } from "../revision";
import { adReviewVersion } from "../version";
import { editFields } from "../adapters";
import { prepareSchema } from "@/services/connectors/reddit-ads/schema";

const media = vi.hoisted(() => ({ failure: null as unknown }));
vi.mock("../media", () => ({ resolveAdReviewMedia: async (_tenant: string, _cls: string, _payload: unknown, review: unknown) => { if (media.failure) throw media.failure; return review; } }));

const payload = { ad_set_id: "12345", headline: "A", primary_text: "Saved text", link_url: "https://example.com", image_url: "https://media.example/a.jpg", source: "library" };
function row(over: Partial<ReviewRow> = {}): ReviewRow {
  return { id: "row", channel_slug: "meta_ads", exec_class: "meta_ads.create_ad", exec_payload: payload, body: {}, status: "pending", exec_status: null, exec_result: null, object_changes: false, approvals: 1, approved_by: null, score: 0, score_inputs: {}, blocking: false, impact: null, impact_reason: null, ...over };
}
const failed = (result: Record<string, unknown>) => row({ exec_status: "failed", approved_by: "user", exec_result: result });

describe("ad review editing gate", () => {
  it("opens only a failure with the dispatcher's proof that nothing was written", async () => {
    const proven = { code: "meta_ads_token_expired", nothing_written: true };
    expect(failedWithNothingMade(failed(proven))).toBe(true);
    expect(failedWithNothingMade(failed({ code: "insufficient_credits", bucket: "needs_founder" }))).toBe(false);
    expect(failedWithNothingMade(failed({ code: "meta_ads_launch_not_live", bucket: "needs_founder" }))).toBe(false);
    expect(failedWithNothingMade(failed({ ...proven, interrupted: true }))).toBe(false);
    expect(failedWithNothingMade(failed({ ...proven, code: "exec_outcome_unknown" }))).toBe(false);
    expect(failedWithNothingMade(failed({ ...proven, bucket: "partial_risk" }))).toBe(false);
    expect(failedWithNothingMade(failed({ ...proven, lease_expired: true }))).toBe(false);
    expect(failedWithNothingMade(failed({ ...proven, created: [{ id: "1" }] }))).toBe(false);
    expect(failedWithNothingMade({ ...failed(proven), object_changes: true })).toBe(false);
    expect(failedWithNothingMade({ ...failed(proven), object_changes: undefined })).toBe(false);
    expect(failedWithNothingMade({ ...failed(proven), approvals: 2 })).toBe(false);
    expect(failedWithNothingMade({ ...failed(proven), approvals: undefined })).toBe(false);
    expect((await readAdReview("t", failed(proven))).editable).toBe(true);
    const uncertain = await readAdReview("t", failed({ code: "meta_ads_launch_not_live", bucket: "needs_founder" }));
    expect(uncertain.editable).toBe(false);
    expect(uncertain.limitations).toContain("This run may have reached the platform, so it can’t be edited here.");
  });

  it("says why a card is locked, including for a member", async () => {
    const member = await readAdReview("t", row(), false, false);
    expect(member).toMatchObject({ editable: false, fields: [] });
    expect(member.limitations).toContain("Only an owner or admin can edit this ad.");
    expect((await readAdReview("t", row({ exec_status: "dispatching", approved_by: "user" }))).limitations[0]).toBe("This ad is being sent to the platform, so it can’t be edited right now.");
  });

  it("revises a clean failure and refuses a stale or running one as stale", () => {
    const version = adReviewVersion("meta_ads.create_ad", payload);
    expect(revisedAd(failed({ code: "meta_ads_token_expired", nothing_written: true }), version, { headline: "B" }).payload).toMatchObject({ headline: "B" });
    expect(() => revisedAd(failed({ code: "insufficient_credits", bucket: "needs_founder" }), version, { headline: "B" })).toThrow(StaleAdRevision);
    expect(() => revisedAd(row({ exec_status: "dispatching" }), version, { headline: "B" })).toThrow(StaleAdRevision);
    expect(() => revisedAd(row(), "b".repeat(64), { headline: "B" })).toThrow(StaleAdRevision);
  });

  it("keeps the original value as before across repeated edits", () => {
    const first = revisedAd(row(), adReviewVersion("meta_ads.create_ad", payload), { headline: "B" });
    const second = revisedAd(row({ exec_payload: first.payload, body: first.body }), adReviewVersion("meta_ads.create_ad", first.payload), { headline: "C" });
    const rows = (second.body.exact_change as { rows: Array<Record<string, unknown>> }).rows.filter((r) => r.review_key === "headline");
    expect(rows).toEqual([expect.objectContaining({ before: "A", after: "C" })]);
    const back = revisedAd(row({ exec_payload: second.payload, body: second.body }), adReviewVersion("meta_ads.create_ad", second.payload), { headline: "A" });
    expect((back.body.exact_change as { rows: Array<Record<string, unknown>> }).rows.filter((r) => r.review_key === "headline")).toEqual([]);
  });

  it("gives a revised Reddit plan a new operation key that a replay repeats", () => {
    const plan = prepareSchema.parse({ ad_account_id: "account", profile_id: "profile", pixel_id: "pixel", operation_key: "operation_123", name: "Traffic test", rationale: "Business goal: qualified visits", objective: "CLICKS", daily_budget_usd: 10, lifetime_cap_usd: 100, start_time: "2099-01-01T09:00:00-08:00", targeting: { geolocations: ["US"] }, creatives: [{ name: "First image", headline: "Plan your next trip", image_url: "https://example.com/image.jpg", destination_url: "https://example.com/trips" }] });
    const reddit = row({ id: "reddit-row", channel_slug: "reddit_ads", exec_class: "reddit_ads.prepare_campaign", exec_payload: plan });
    const version = adReviewVersion("reddit_ads.prepare_campaign", plan);
    const key = (changes: Record<string, string>) => prepareSchema.parse(revisedAd(reddit, version, changes).payload).operation_key;
    const first = key({ start_time: "2099-02-01" });
    expect(first).not.toBe("operation_123");
    expect(key({ start_time: "2099-02-01" })).toBe(first);
    expect(key({ start_time: "2099-03-01" })).not.toBe(first);
  });
});

const cgPayload = {
  name: "Renters", currency: "USD", origin: "user_initiated_chat", daily_budget_usd: 25, top_up_authorized: false,
  bundle: { summary: "Test renters", rationale: "Find relevant renters", campaign: {
    name: "Renters", daily_budget_micros: 25e6, bidding_type: "clicks",
    start_time: Date.parse("2026-10-23T14:03:27Z") / 1000, end_time: Date.parse("2026-10-24T14:03:27Z") / 1000,
    targeting: { locations: { countries: ["US"] } },
  }, group: { name: "Intent", strategy: "maximize_clicks", context_hints: ["Rent a car"] },
  ads: [{ name: "First", title: "Local cars", body: "Find a car near you", target_url: "https://example.com", image_url: "https://example.com/car.jpg" }],
  },
};
const cgRow = () => row({ channel_slug: "chatgpt_ads", exec_class: "chatgpt_ads.create_and_launch", exec_payload: cgPayload, body: { change_sentence: "Old schedule", step: { body: "Old schedule" } } });
it("projects the current nested ChatGPT payload with image, cost and exact schedule", async () => {
  const review = await readAdReview("t", cgRow());
  expect(review).toMatchObject({ editable: true, review: { cost: "25 USD a day", creatives: [{ title: "Local cars", image_url: "https://example.com/car.jpg" }], schedule: { start: "2026-10-23T14:03:27.000Z", end: "2026-10-24T14:03:27.000Z" } } });
  expect(review.fields).toContainEqual({ key: "bundle.campaign.end_time", label: "Ends (UTC)", kind: "datetime", optional: false, value: "2026-10-24T14:03:27" });
});
it("shortens the precise UTC schedule without changing consent, budgets or creative", () => {
  const result = revisedAd(cgRow(), adReviewVersion(cgRow().exec_class!, cgPayload), { "bundle.campaign.end_time": "2026-10-23T18:03:27" });
  expect(result.payload).toEqual({ ...cgPayload, bundle: { ...cgPayload.bundle, campaign: { ...cgPayload.bundle.campaign, end_time: Date.parse("2026-10-23T18:03:27Z") / 1000 } } });
  expect(result.body.change_sentence).toContain("2026-10-23T18:03:27.000Z");
  expect(result.body.step).toMatchObject({ body: result.body.change_sentence });
  const copyOnly = revisedAd(cgRow(), adReviewVersion(cgRow().exec_class!, cgPayload), { "bundle.ads.0.title": "Other title" });
  expect((copyOnly.payload as typeof cgPayload).bundle.campaign).toEqual(cgPayload.bundle.campaign);
});
it.each(["2026-10-23T13:00:00", "2026-02-30T18:00:00", "2026-10-23", "2026-10-23T18:00:00+05:30", "2027-10-23T18:00:00"])("refuses invalid or unsafe schedule %s", end => {
  expect(() => revisedAd(cgRow(), adReviewVersion(cgRow().exec_class!, cgPayload), { "bundle.campaign.end_time": end })).toThrow();
});
it.each(["top_up_authorized", "bundle.campaign.daily_budget_micros", "currency"])("does not expose %s through the editor", key => {
  expect(() => revisedAd(cgRow(), adReviewVersion(cgRow().exec_class!, cgPayload), { [key]: "true" })).toThrow(/cannot be edited/);
});
it.each([{ status: "rejected" }, { approved_by: "u" }, { exec_status: "queued" }, { exec_status: "executed" }])("keeps a closed or approved ChatGPT card locked", async extra => {
  expect((await readAdReview("t", { ...cgRow(), ...extra })).editable).toBe(false);
  expect(() => revisedAd({ ...cgRow(), ...extra }, adReviewVersion(cgRow().exec_class!, cgPayload), { "bundle.ads.0.title": "Other" })).toThrow(StaleAdRevision);
});

describe("a sponsored LinkedIn post whose Create failed part way", () => {
  const liPayload = { account_id: "11", group: { name: "First test" }, campaign: { name: "Pilot", daily_budget: { amount: "18", currency: "USD" }, unit_cost: { amount: "6", currency: "USD" }, geo_urns: ["urn:li:geo:103644278"], country: "US", language: "en", associated_entity: "urn:li:organization:42" }, creative: { post_urn: "urn:li:share:7001" } };
  const partial = { code: "linkedin_ads_creation_incomplete", bucket: "temporary", created: { campaign_group: "urn:li:sponsoredCampaignGroup:1", campaign: "urn:li:sponsoredCampaign:2" } };
  const liFailed = (id: string) => row({ id, channel_slug: "linkedin_ads", exec_class: "linkedin_ads.create_campaign_bundle", exec_payload: liPayload, exec_status: "failed", approved_by: "user", exec_result: partial, object_changes: true });
  const unreadable = Object.assign(new Error("LinkedIn refused the post read"), { code: "linkedin_ads_http_403" });

  it("adds no locked, editing or missing-media note beside the failure the card already shows", async () => {
    media.failure = unreadable;
    try {
      const read = await readAdReview("t", liFailed("li-partial"), true);
      expect(editFields("linkedin_ads.create_campaign_bundle", liPayload)).toEqual([]);
      expect(read.editable).toBe(false);
      expect(read.fields).toEqual([]);
      expect(read.limitations).toEqual([]);
      expect(read.connection_blocker).toBeNull();
      expect(read.review?.creatives).toEqual([{ target_url: "https://www.linkedin.com/feed/update/urn:li:share:7001/", source: "An existing company post" }]);
    } finally { media.failure = null; }
  });

  it("still asks for a reconnect when LinkedIn stopped accepting Zavi's access", async () => {
    media.failure = Object.assign(new Error("expired"), { code: "linkedin_ads_not_connected" });
    try {
      const read = await readAdReview("t", liFailed("li-revoked"), true);
      expect(read.connection_blocker).toEqual({ message: "reconnect LinkedIn Ads to publish this ad" });
      expect(read.limitations).toEqual([]);
    } finally { media.failure = null; }
  });

  it("never says the media of a pending sponsored post could not be read", async () => {
    media.failure = unreadable;
    try {
      const read = await readAdReview("t", row({ id: "li-pending", channel_slug: "linkedin_ads", exec_class: "linkedin_ads.create_campaign_bundle", exec_payload: liPayload }), true);
      expect(read.editable).toBe(false);
      expect(read.limitations).not.toContain("Some source media could not be read. Retry the preview or check your platform connection.");
      expect(read.limitations).toEqual([]);
    } finally { media.failure = null; }
  });

  describe("helper text on a LinkedIn work item", () => {
    const li = (over: Partial<ReviewRow> = {}) => row({ id: `li-${JSON.stringify(over)}`, channel_slug: "linkedin_ads", exec_class: "linkedin_ads.create_campaign_bundle", exec_payload: liPayload, ...over });
    const x = (over: Partial<ReviewRow> = {}) => row({ id: `x-${JSON.stringify(over)}`, channel_slug: "x_ads", exec_class: "x_ads.create_campaign", exec_payload: { tweet_ids: ["1"], start_time: "2026-11-01" }, ...over });
    const states: Array<[string, Partial<ReviewRow>]> = [
      ["no longer pending", { status: "rejected" }],
      ["already ran", { exec_status: "executed", approved_by: "user" }],
      ["being sent", { exec_status: "dispatching", approved_by: "user" }],
      ["approved and waiting", { approved_by: "user" }],
    ];

    it.each(states)("%s: the card status says it, so no note is added", async (_, over) => {
      expect((await readAdReview("t", li(over))).limitations).toEqual([]);
    });

    it("says nothing on an open draft, and offers no field that swaps the promoted post past the post check", async () => {
      const read = await readAdReview("t", li());
      expect(read).toMatchObject({ editable: false, fields: [], limitations: [] });
      const version = adReviewVersion("linkedin_ads.create_campaign_bundle", liPayload);
      expect(() => revisedAd(li(), version, { "creative.post_urn": "urn:li:share:2" })).toThrow(/cannot be edited/);
    });

    it("drops the notes on a LinkedIn class with no editable fields too", async () => {
      const read = await readAdReview("t", li({ exec_class: "linkedin_ads.pause_campaign", exec_payload: {} }));
      expect(read.limitations).toEqual([]);
    });

    it("adds no role note, because a member could not change anything here either", async () => {
      expect((await readAdReview("t", li(), false, false)).limitations).toEqual([]);
    });

    it("still refuses the edit itself once the proposal is locked: only the note went away", () => {
      const version = adReviewVersion("linkedin_ads.create_campaign_bundle", liPayload);
      for (const [, over] of states) expect(() => revisedAd(li(over), version, { "creative.post_urn": "urn:li:share:2" })).toThrow(StaleAdRevision);
    });

    it("non-regression guard: X keeps the source-post note, word for word", async () => {
      expect((await readAdReview("t", x())).limitations).toContain("Changing the source post selects a different existing post. Edit the post’s original copy on its platform.");
    });

    it("non-regression guard: another channel keeps all four lock notes", async () => {
      expect((await readAdReview("t", row({ status: "rejected" }))).limitations[0]).toBe("This proposal is no longer pending, so it can’t be edited.");
      expect((await readAdReview("t", row({ exec_status: "executed", approved_by: "user" }))).limitations[0]).toBe("This ad already ran, so it can’t be edited.");
      expect((await readAdReview("t", row({ exec_status: "dispatching", approved_by: "user" }))).limitations[0]).toBe("This ad is being sent to the platform, so it can’t be edited right now.");
      expect((await readAdReview("t", row({ approved_by: "user" }))).limitations[0]).toBe("This ad is approved and waiting to run, so it can’t be edited.");
    });

    it("non-regression guard: another channel keeps the executor and creative notes", async () => {
      const read = await readAdReview("t", row({ exec_class: "meta_ads.pause", exec_payload: {} }));
      expect(read.limitations).toEqual(["This proposal’s executor does not support schedule revisions.", "This proposal does not support inline creative revisions. Existing source posts must be edited on their platform."]);
    });
  });

  it("keeps the locked and missing-media notes for a part-way failure on another channel", async () => {
    media.failure = unreadable;
    try {
      const read = await readAdReview("t", failed({ code: "meta_ads_launch_not_live", bucket: "needs_founder", created: [{ id: "1" }] }), true);
      expect(read.limitations[0]).toBe("This run may have reached the platform, so it can’t be edited here.");
      expect(read.limitations.at(-1)).toBe("Some source media could not be read. Retry the preview or check your platform connection.");
    } finally { media.failure = null; }
  });
});
