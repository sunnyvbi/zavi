import { describe, it, expect } from "vitest";
import { extractReceipts } from "../receipt-extractor";

describe("extractReceipts", () => {
  it("slack → message ts + permalink", () => {
    const r = extractReceipts(
      "slack__post_message",
      JSON.stringify({ ok: true, ts: "1719859200.123456", permalink: "https://x.slack.com/archives/C/p1" }),
    );
    expect(r).toEqual([
      { type: "slack_message", label: "Slack message 1719859200.123456", url: "https://x.slack.com/archives/C/p1" },
    ]);
  });

  it("github → PR number + html_url", () => {
    const r = extractReceipts(
      "github__open_pr",
      JSON.stringify({ number: 1234, html_url: "https://github.com/o/r/pull/1234" }),
    );
    expect(r).toEqual([{ type: "github_pr", label: "PR #1234", url: "https://github.com/o/r/pull/1234" }]);
  });

  it("stripe SUCCEEDED → payment_intent_id ONLY, NEVER client_secret (E3 money/secret)", () => {
    const r = extractReceipts(
      "stripe__create_payment",
      JSON.stringify({
        payment_intent_id: "pi_123ABC",
        client_secret: "pi_123ABC_secret_SHOULD_NEVER_LEAK",
        status: "succeeded",
      }),
    );
    expect(r).toEqual([{ type: "stripe_payment", label: "Payment pi_123ABC" }]);
    expect(JSON.stringify(r)).not.toContain("client_secret");
    expect(JSON.stringify(r)).not.toContain("SHOULD_NEVER_LEAK");
  });

  it.each([
    ["requires_capture", "authorized but not captured"],
    ["requires_payment_method", "no payment method attached"],
    ["requires_action", "awaiting 3DS/SCA"],
    ["processing", "not yet settled"],
    ["canceled", "terminal failure"],
    ["failed", "terminal failure"],
  ])("stripe status=%s → NO receipt (%s)", (status) => {
    const r = extractReceipts(
      "stripe__create_payment",
      JSON.stringify({ payment_intent_id: "pi_123ABC", status }),
    );
    expect(r).toBeUndefined();
  });

  it("stripe status=already_collected → receipt (idempotent held-fund retry is a real success)", () => {
    const r = extractReceipts(
      "stripe__create_payment",
      JSON.stringify({ payment_intent_id: "ch_777", status: "already_collected" }),
    );
    expect(r).toEqual([{ type: "stripe_payment", label: "Payment ch_777" }]);
  });

  it("stripe with NO status signal → NO receipt (fail closed, never assume success)", () => {
    const r = extractReceipts(
      "stripe__create_payment",
      JSON.stringify({ payment_intent_id: "pi_123ABC" }),
    );
    expect(r).toBeUndefined();
  });

  it("stripe unrecognized status → NO receipt (fail closed)", () => {
    const r = extractReceipts(
      "stripe__create_payment",
      JSON.stringify({ payment_intent_id: "pi_1", status: "some_new_stripe_state" }),
    );
    expect(r).toBeUndefined();
  });

  it("meta_ads → ad-set id from the REAL `{id, daily_budget}` return shape", () => {
    const r = extractReceipts(
      "meta_ads__update_ad_set_budget",
      JSON.stringify({ id: "120210000", daily_budget: 5000 }),
    );
    expect(r).toEqual([{ type: "meta_ad_set", label: "Ad set 120210000" }]);
  });

  it("meta_ads__set_status `{id}` → NO ad-set receipt (id may be a campaign or ad)", () => {
    const r = extractReceipts(
      "meta_ads__set_status",
      JSON.stringify({ id: "120333CAMPAIGN", status: "PAUSED" }),
    );
    expect(r).toBeUndefined();
  });

  it("meta_ads__propose_new_ad_set `{id}` → NO receipt (a proposal is not an applied write)", () => {
    const r = extractReceipts(
      "meta_ads__propose_new_ad_set",
      JSON.stringify({ id: "120555PROPOSAL", decision_id: "d-1" }),
    );
    expect(r).toBeUndefined();
  });

  it("meta_ads__create_ad_set `{id, status}` → receipt (id IS the new ad set)", () => {
    const r = extractReceipts(
      "meta_ads__create_ad_set",
      JSON.stringify({ id: "120210777", status: "PAUSED" }),
    );
    expect(r).toEqual([{ type: "meta_ad_set", label: "Ad set 120210777" }]);
  });

  it("pipedream_meta_ads__update_ad_set_budget → receipt (prefix stripped for the allowlist)", () => {
    const r = extractReceipts(
      "pipedream_meta_ads__update_ad_set_budget",
      JSON.stringify({ id: "120210888", daily_budget: 5000 }),
    );
    expect(r).toEqual([{ type: "meta_ad_set", label: "Ad set 120210888" }]);
  });

  it("meta_ads__set_status WITH an explicit ad_set_id → receipt (unambiguous)", () => {
    const r = extractReceipts(
      "meta_ads__set_status",
      JSON.stringify({ ad_set_id: "120210000", status: "PAUSED" }),
    );
    expect(r).toEqual([{ type: "meta_ad_set", label: "Ad set 120210000" }]);
  });

  it("meta_ads → still accepts an ad_set_id-shaped variant", () => {
    const r = extractReceipts(
      "meta_ads__update_ad_set_budget",
      JSON.stringify({ success: true, ad_set_id: "120210000" }),
    );
    expect(r).toEqual([{ type: "meta_ad_set", label: "Ad set 120210000" }]);
  });

  it("meta_ads success:false → NO receipt", () => {
    const r = extractReceipts(
      "meta_ads__update_ad_set_budget",
      JSON.stringify({ success: false, error: "budget below minimum", id: "120210000" }),
    );
    expect(r).toBeUndefined();
  });

  it("pipedream_stripe__ prefix resolves to the stripe family (still no secret)", () => {
    const r = extractReceipts(
      "pipedream_stripe__create_payment",
      JSON.stringify({ payment_intent_id: "pi_9", client_secret: "leak", status: "succeeded" }),
    );
    expect(r?.[0]).toEqual({ type: "stripe_payment", label: "Payment pi_9" });
    expect(JSON.stringify(r)).not.toContain("leak");
  });

  it("unknown tool → undefined (never fabricate a receipt)", () => {
    expect(extractReceipts("web__search", JSON.stringify({ results: [] }))).toBeUndefined();
  });

  it("tool with no safe id in result → undefined", () => {
    expect(extractReceipts("slack__post_message", JSON.stringify({ ok: false, error: "not_in_channel" }))).toBeUndefined();
  });

  it("non-JSON / malformed result → undefined (no throw)", () => {
    expect(extractReceipts("slack__post_message", "not json")).toBeUndefined();
    expect(extractReceipts("stripe__create_payment", "")).toBeUndefined();
  });
});
