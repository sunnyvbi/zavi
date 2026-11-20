
import { describe, it, expect } from "vitest";
import { defaultUpgradeTier, tierSelectable, planSummaryLine } from "../BillingCreditsPanel";

describe("defaultUpgradeTier", () => {
  it("free (or unknown) opens on Starter", () => {
    expect(defaultUpgradeTier("free")).toBe("starter");
    expect(defaultUpgradeTier(null)).toBe("starter");
  });
  it("opens on the next tier up", () => {
    expect(defaultUpgradeTier("starter")).toBe("growth");
    expect(defaultUpgradeTier("growth")).toBe("pro");
  });
  it("Pro has nothing to upgrade to", () => {
    expect(defaultUpgradeTier("pro")).toBeNull();
  });
});

describe("tierSelectable", () => {
  it("never offers the current tier or a lower one", () => {
    expect(tierSelectable("starter", "growth")).toBe(false);
    expect(tierSelectable("growth", "growth")).toBe(false);
    expect(tierSelectable("pro", "growth")).toBe(true);
    expect(tierSelectable("starter", "pro")).toBe(false);
  });
  it("an unknown tier is treated as free", () => {
    expect(tierSelectable("starter", null)).toBe(true);
  });
});

describe("planSummaryLine", () => {
  it("marks an unshipped channel instead of inlining the wire suffix", () => {
    const line = planSummaryLine(["Meta Ads", "ChatGPT Ads - Coming soon"]);
    expect(line).toBe("Meta Ads \u00b7 ChatGPT Ads (soon)");
    expect(line).not.toContain("- Coming soon");
  });

  it("drops the heading line rather than printing it as a feature", () => {
    expect(planSummaryLine(["Everything in Growth, plus:", "Meta Ads"])).toBe("Meta Ads");
  });
});
