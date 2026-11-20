import { describe, expect, it } from "vitest";
import { toActionView } from "../channel-actions";
import { MUTATE_NOT_ALLOWED } from "./exec-failure.fixtures";

const row = (over: Record<string, unknown>) =>
  ({
    id: "ca-1", channel_slug: "meta_ads", run_id: "run-1", position: 1, run_of: 1, blocking: false,
    action_type: "update_ad", title: "Raise the budget", body: {}, status: "pending", note: null,
    snoozed_until: null, impact: null, impact_reason: null, proposed_at: "2026-09-30T00:00:00Z",
    repeat_of: null, redo_of: null, ...over,
  }) as never;

describe("exec_bucket on the wire", () => {
  it("needs_founder serves the fix in words", () => {
    const v = toActionView(row({ exec_class: "meta_ads.update_ad_set_budget", exec_status: "failed", exec_result: { error: "x", code: "meta_ads_token_expired" } }), 1, {});
    expect(v).toMatchObject({ exec_bucket: "needs_founder", exec_fix_text: "reconnect Meta Ads in Settings", exec_code: "meta_ads_token_expired" });
  });
  it("a stamped verdict wins over re-classifying", () => {
    const v = toActionView(row({ exec_class: "google_ads.set_status", exec_status: "failed", exec_result: { error: "socket hang up", bucket: "needs_founder", fix: "billing" } }), 1, {});
    expect(v).toMatchObject({ exec_bucket: "needs_founder", exec_fix_text: "fix billing in Google Ads" });
  });
  it("a legacy blocked row is classified; no fix text; the raw error never reaches the wire", () => {
    const v = toActionView(row({ exec_class: "google_ads.create_campaign", exec_status: "failed", exec_result: { error: MUTATE_NOT_ALLOWED } }), 1, {});
    expect(v).toMatchObject({ exec_bucket: "blocked_on_us", exec_fix_text: null });
    expect(JSON.stringify(v)).not.toContain("MUTATE_NOT_ALLOWED");
  });
  it("an executed or never-run row serves nothing", () => {
    expect(toActionView(row({ exec_class: "meta_ads.set_status", exec_status: "executed", exec_result: { notice: null } }), 1, {})).toMatchObject({ exec_bucket: null, exec_fix_text: null });
    expect(toActionView(row({}), 1, {})).toMatchObject({ exec_bucket: null, exec_fix_text: null });
  });
  it("a founder hold is not a failure bucket", () => {
    expect(toActionView(row({ exec_class: "meta_ads.set_status", exec_status: "failed", exec_result: { error: "held", held_for_founder: true } }), 1, {})).toMatchObject({ exec_bucket: null });
  });
  it("a creator hire that fell back to Checkout serves its Stripe Checkout link, and nothing else that looks like one", () => {
    const url = "https://checkout.stripe.com/c/pay/cs_test_abc#frag";
    const fell = toActionView(row({ channel_slug: "ugc", exec_class: "creator.hire", exec_status: "failed", exec_result: { error: "Nothing was charged yet. Pay with the link on this card to hire the creator.", code: "creator_hire_checkout", bucket: "temporary", checkout_url: url } }), 1, {});
    expect(fell).toMatchObject({ exec_code: "creator_hire_checkout", exec_checkout_url: url });
    const forged = toActionView(row({ channel_slug: "ugc", exec_class: "creator.hire", exec_status: "failed", exec_result: { error: "x", code: "creator_hire_checkout", checkout_url: "https://evil.example/checkout.stripe.com/" } }), 1, {});
    expect(forged).toMatchObject({ exec_checkout_url: null });
    const done = toActionView(row({ channel_slug: "ugc", exec_class: "creator.hire", exec_status: "executed", exec_result: { checkout_url: url } }), 1, {});
    expect(done).toMatchObject({ exec_checkout_url: null });
  });
  it("a LinkedIn pause serves what the executor actually found, and only once executed", () => {
    const notice = 'LinkedIn shows "Spring" already ended, so there was nothing to pause.';
    expect(toActionView(row({ channel_slug: "linkedin_ads", exec_class: "linkedin_ads.set_status", exec_status: "executed", exec_result: { notice } }), 1, {})).toMatchObject({ exec_notice: notice });
    expect(toActionView(row({ channel_slug: "linkedin_ads", exec_class: "linkedin_ads.set_status", exec_status: "failed", exec_result: { notice, code: "x" } }), 1, {}).exec_notice).toBeUndefined();
    expect(toActionView(row({ exec_class: "meta_ads.set_status", exec_status: "executed", exec_result: { notice } }), 1, {}).exec_notice).toBeUndefined();
  });
});

describe("a LinkedIn campaign in Zavi's shared wallet account", () => {
  it("serves exec_managed only on a failed row whose result says Zavi manages the account", () => {
    const failed = toActionView(row({ channel_slug: "linkedin_ads", exec_class: "linkedin_ads.create_campaign_bundle", exec_status: "failed", exec_result: { code: "exec_partial", error: "x", managed: true } }), 1, {});
    expect(failed).toMatchObject({ exec_managed: true, exec_bucket: "partial_risk" });
    expect(toActionView(row({ channel_slug: "linkedin_ads", exec_class: "linkedin_ads.create_campaign_bundle", exec_status: "failed", exec_result: { code: "exec_partial", error: "x" } }), 1, {}).exec_managed).toBeUndefined();
    expect(toActionView(row({ channel_slug: "linkedin_ads", exec_class: "linkedin_ads.create_campaign_bundle", exec_status: "executed", exec_result: { managed: true } }), 1, {}).exec_managed).toBeUndefined();
  });
});
