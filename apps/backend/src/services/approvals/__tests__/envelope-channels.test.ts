import { describe, expect, it } from "vitest";
import { createFitsEnvelope, createMaxSpendUsd, createOf, type ApprovalEnvelope } from "@/services/approvals/approval-envelope";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const env = (channel: string, total: number, daily: number | null, ends = "2026-10-18"): ApprovalEnvelope => ({ v: 1, envelope_id: "ask:r", tenant_id: "t", actor_user_id: "u", actor_role: "owner", surface: "chat", channel, max_total_usd: total, max_daily_usd: daily, starts_on: "2026-10-15", ends_on: ends });

describe("Meta launch: the ad set's end_time caps it (factor 1.75)", () => {
  const body = (daily: number, end?: string) => ({ currency: "USD", campaign: { daily_budget_usd: daily }, ad_set: { ...(end ? { end_time: end } : {}) } });
  it("fits, one cent over, no end", () => {
    expect(createFitsEnvelope(env("meta_ads", 50, 9.52), createOf("meta_ads.launch_campaign", body(7.14, "2026-10-18T00:00:00+00:00"), NOW))).toBe(true);
    expect(createFitsEnvelope(env("meta_ads", 50, 9.52), createOf("meta_ads.launch_campaign", body(7.15, "2026-10-18T00:00:00+00:00"), NOW))).toBe(false);
    expect(createOf("meta_ads.launch_campaign", body(9.52), NOW)).toBeNull();
    expect(createOf("meta_ads.launch_campaign", { ...body(9.52, "2026-10-18T00:00:00Z"), currency: "INR" }, NOW)).toBeNull();
  });
});

describe("Google create: end_date caps it (factor 2)", () => {
  it("fits, one cent over, no end", () => {
    expect(createFitsEnvelope(env("google_ads", 30, 5), createOf("google_ads.create_campaign", { daily_budget_usd: 3.75, end_date: "2026-10-18", location_ids: [2840] }, NOW))).toBe(true);
    expect(createFitsEnvelope(env("google_ads", 30, 5), createOf("google_ads.create_campaign", { daily_budget_usd: 3.76, end_date: "2026-10-18", location_ids: [2840] }, NOW))).toBe(false);
    expect(createOf("google_ads.create_campaign", { daily_budget_usd: 5, end_date: "2026-10-18", location_ids: [] }, NOW)).toBeNull();
    expect(createOf("google_ads.create_campaign", { daily_budget_usd: 5, end_date: "2026-10-18" }, NOW)).toBeNull();
    expect(createOf("google_ads.create_campaign", { daily_budget_usd: 5 }, NOW)).toBeNull();
  });
});

describe("X create: a total budget X enforces, or an end date", () => {
  const base = { currency: "USD", launch: "ACTIVE", daily_budget: 7.14, start_time: "2026-10-15T12:00:00Z", end_time: "2026-10-18T00:00:00Z" };
  it("a lifetime total fits up to the ask; one cent over does not; paused or no end never fits", () => {
    expect(createFitsEnvelope(env("x_ads", 50, null), createOf("x_ads.create_campaign", { ...base, total_budget: 50 }, NOW))).toBe(true);
    expect(createFitsEnvelope(env("x_ads", 50, null), createOf("x_ads.create_campaign", { ...base, total_budget: 50.01 }, NOW))).toBe(false);
    expect(createOf("x_ads.create_campaign", { ...base, launch: "PAUSED", total_budget: 50 }, NOW)).toBeNull();
    expect(createOf("x_ads.create_campaign", { ...base, end_time: null, total_budget: 50 }, NOW)).toBeNull();
  });
  it("a daily create counts at X's 2x over-delivery", () => {
    const c = createOf("x_ads.create_campaign", { ...base, total_budget: null }, NOW)!;
    expect(createMaxSpendUsd(c)).toBeCloseTo(2 * 7.14 * 4, 6);
  });
});

describe("LinkedIn launch: the lifetime cap and end time", () => {
  it("fits, one cent over, no end", () => {
    const end = Date.parse("2026-10-18T00:00:00Z");
    expect(createFitsEnvelope(env("linkedin_ads", 150, null), createOf("linkedin_ads.launch_campaign", { currency: "USD", total_budget_usd: 150, end_time: end }, NOW))).toBe(true);
    expect(createFitsEnvelope(env("linkedin_ads", 150, null), createOf("linkedin_ads.launch_campaign", { currency: "USD", total_budget_usd: 150.01, end_time: end }, NOW))).toBe(false);
    expect(createOf("linkedin_ads.launch_campaign", { currency: "USD", total_budget_usd: 150 }, NOW)).toBeNull();
  });
});

describe("Reddit: not wired (two cards: prepare, then launch)", () => {
  it("never fits", () => {
    expect(createOf("reddit_ads.prepare_campaign", { lifetime_cap_usd: 150, daily_budget_usd: 5 }, NOW)).toBeNull();
    expect(createOf("reddit_ads.launch_campaign", { operation_key: "k" }, NOW)).toBeNull();
  });
});
