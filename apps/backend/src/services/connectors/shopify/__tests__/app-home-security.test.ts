import { describe, expect, it } from "vitest";
import { oneClickApprovalAllowed } from "../app-home";
import { shopifyChargeUsd } from "../app-billing";
import { sixMonthUsd } from "@/services/billing/plans";
import { TIER_PRICE_USD } from "@/services/billing/tiers";

describe("Shopify App Home rights", () => {
  it("lets linked members complete an explicitly allowed manual step but never viewers", () => {
    const ordinary = { decisionClass: "channel.recipe_step", body: {} };
    expect(oneClickApprovalAllowed({ role: "member", ...ordinary })).toBe(true);
    expect(oneClickApprovalAllowed({ role: "viewer", ...ordinary })).toBe(false);
  });

  it("sends every unlisted, edited-publish, red-ship and money action to full review", () => {
    const spend = { decisionClass: "meta_ads.update_ad_set_budget", body: { daily_budget_usd: 50, expected_current_daily_budget_usd: 20 } };
    expect(oneClickApprovalAllowed({ role: "member", ...spend })).toBe(false);
    expect(oneClickApprovalAllowed({ role: "owner", ...spend })).toBe(false);
    expect(oneClickApprovalAllowed({ role: "owner", decisionClass: "stripe.create_payment", body: {} })).toBe(false);
    expect(oneClickApprovalAllowed({ role: "admin", decisionClass: "composio.write", body: {} })).toBe(false);
    expect(oneClickApprovalAllowed({ role: "owner", decisionClass: "social.publish.v2", body: { post_draft: { text: "edited" } } })).toBe(false);
    expect(oneClickApprovalAllowed({ role: "owner", decisionClass: "engineer.ship-pr", body: { approval_class: "ship_red" } })).toBe(false);
    expect(oneClickApprovalAllowed({ role: "owner", decisionClass: "new.irreversible.action", body: {} })).toBe(false);
  });
});

describe("Shopify plan prices", () => {
  it("uses the canonical monthly price and doubles the canonical six-month total for annual", () => {
    expect(shopifyChargeUsd("starter", "monthly")).toBe(TIER_PRICE_USD.starter);
    expect(shopifyChargeUsd("starter", "annual")).toBe(sixMonthUsd("starter") * 2);
    expect(shopifyChargeUsd("pro", "annual")).toBe(sixMonthUsd("pro") * 2);
  });
});
