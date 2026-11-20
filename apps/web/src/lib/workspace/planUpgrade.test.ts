import { describe, it, expect } from "vitest";
import {
  isPlanUpgradeRefusal,
  lockedTierOf,
  planBadgeLabel,
  planUpgradeMessage,
  requiredTierFromBody,
} from "./planUpgrade";

describe("planUpgrade", () => {
  it("reads locked_tier defensively", () => {
    expect(lockedTierOf({ slug: "engineer", locked_tier: "pro" })).toBe("pro");
    expect(lockedTierOf({ slug: "operator", locked_tier: null })).toBeNull();
    expect(lockedTierOf({ slug: "operator" })).toBeNull();
    expect(lockedTierOf({ locked_tier: "free" })).toBeNull();
    expect(lockedTierOf({ locked_tier: "gold" })).toBeNull();
    expect(lockedTierOf(null)).toBeNull();
  });

  it("labels the badge", () => {
    expect(planBadgeLabel("growth")).toBe("Growth plan");
  });

  it("reads required_tier from the 403 body", () => {
    expect(requiredTierFromBody({ error: { code: "plan_upgrade_required", required_tier: "starter" } })).toBe("starter");
    expect(requiredTierFromBody({ error: { code: "x" } })).toBeNull();
    expect(requiredTierFromBody("nope")).toBeNull();
  });

  it("prefers the server message, falls back to the tier", () => {
    expect(planUpgradeMessage("Meta Ads needs the Pro plan.", "pro")).toBe("Meta Ads needs the Pro plan.");
    expect(planUpgradeMessage(null, "pro")).toBe("This needs the Pro plan. Upgrade to use it.");
    expect(planUpgradeMessage("", null)).toMatch(/Upgrade/);
    expect(planUpgradeMessage(null, "pro")).not.toMatch(/—/);
  });

  it("matches the refusal by code", () => {
    expect(isPlanUpgradeRefusal(403, "plan_upgrade_required")).toBe(true);
    expect(isPlanUpgradeRefusal(402, "insufficient_credits")).toBe(false);
  });
});
