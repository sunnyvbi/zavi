// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  PENDING_PLAN_KEY,
  clearPendingPlan,
  isUpgradeHash,
  parsePlanChoice,
  parseUpgradeHash,
  readPendingPlan,
  savePendingPlan,
  upgradeHash,
} from "./pendingPlan";

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => window.localStorage.clear());

describe("parsePlanChoice (the /start?plan=&term= gate)", () => {
  it("accepts a paid tier with a known term", () => {
    expect(parsePlanChoice("growth", "6mo")).toEqual({ tier: "growth", term: "6mo" });
    expect(parsePlanChoice("starter", "monthly")).toEqual({ tier: "starter", term: "monthly" });
  });
  it("rejects free, unknown tiers, unknown or missing terms", () => {
    expect(parsePlanChoice("free", "monthly")).toBeNull();
    expect(parsePlanChoice("enterprise", "monthly")).toBeNull();
    expect(parsePlanChoice("pro", "yearly")).toBeNull();
    expect(parsePlanChoice("pro", null)).toBeNull();
    expect(parsePlanChoice(null, null)).toBeNull();
  });
});

describe("pending plan stash", () => {
  it("round-trips under one key while fresh", () => {
    const now = 1_000_000_000_000;
    savePendingPlan({ tier: "growth", term: "6mo" }, now);
    expect(JSON.parse(window.localStorage.getItem(PENDING_PLAN_KEY)!)).toEqual({
      tier: "growth",
      term: "6mo",
      at: now,
    });
    expect(readPendingPlan(now + 6 * DAY)).toEqual({ tier: "growth", term: "6mo" });
  });
  it("expires after 7 days", () => {
    const now = 1_000_000_000_000;
    savePendingPlan({ tier: "pro", term: "monthly" }, now);
    expect(readPendingPlan(now + 7 * DAY + 1)).toBeNull();
  });
  it("ignores garbage and clears", () => {
    window.localStorage.setItem(PENDING_PLAN_KEY, "{not json");
    expect(readPendingPlan()).toBeNull();
    window.localStorage.setItem(PENDING_PLAN_KEY, JSON.stringify({ tier: "free", term: "monthly", at: Date.now() }));
    expect(readPendingPlan()).toBeNull();
    savePendingPlan({ tier: "starter", term: "monthly" });
    clearPendingPlan();
    expect(window.localStorage.getItem(PENDING_PLAN_KEY)).toBeNull();
  });
});

describe("upgrade hash", () => {
  it("round-trips tier and term", () => {
    const h = upgradeHash({ tier: "growth", term: "6mo" });
    expect(h).toBe("billing-upgrade-growth-6mo");
    expect(parseUpgradeHash(`#${h}`)).toEqual({ tier: "growth", term: "6mo" });
    expect(isUpgradeHash(`#${h}`)).toBe(true);
  });
  it("rejects plain billing hashes and bad values", () => {
    expect(parseUpgradeHash("#billing")).toBeNull();
    expect(parseUpgradeHash("#billing-usage")).toBeNull();
    expect(parseUpgradeHash("#billing-upgrade-free-monthly")).toBeNull();
    expect(parseUpgradeHash("#billing-upgrade-pro")).toBeNull();
    expect(isUpgradeHash("#billing")).toBe(false);
  });
});
