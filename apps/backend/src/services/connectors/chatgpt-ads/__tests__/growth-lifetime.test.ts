import { describe, expect, it } from "vitest";
import { growthBundle, growthCreateBody, growthCampaignBudget } from "@/services/connectors/chatgpt-ads/growth-actions";
import { fundingLimit } from "@/services/connectors/chatgpt-ads/campaign-settings";
import { groupBidding } from "@/services/connectors/chatgpt-ads/workspace";

const now = 1_760_486_400;
const fixed = { name: "group one", context_hints: [], strategy: "fixed_bid" as const, max_bid_micros: 2_000_000 };
const bundle = (campaign: Record<string, unknown>, group: Record<string, unknown> = fixed) => ({
  rationale: "Two-day ChatGPT test inside the founder's total.", summary: "Lifetime test",
  campaign: { name: "Zavi test", bidding_type: "clicks", targeting: { locations: { countries: ["US"] } }, start_time: now, end_time: now + 2 * 86400, ...campaign },
  group,
  ads: [{ name: "ad one", title: "Title", body: "Body text", target_url: "https://example.com", image_url: "https://example.com/a.png" }],
});

describe("ChatGPT lifetime Autopilot bundles", () => {
  it("Autopilot accepts a lifetime total (fixed bidding)", () => {
    const r = growthBundle.safeParse(bundle({ lifetime_budget_micros: 58_000_000 }));
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it("still exactly one budget type, and a daily budget still needs $25", () => {
    expect(growthBundle.safeParse(bundle({ lifetime_budget_micros: 58_000_000, daily_budget_micros: 25_000_000 })).success).toBe(false);
    expect(growthBundle.safeParse(bundle({})).success).toBe(false);
    expect(growthBundle.safeParse(bundle({ daily_budget_micros: 24_000_000 })).success).toBe(false);
    expect(growthBundle.safeParse(bundle({ daily_budget_micros: 25_000_000 })).success).toBe(true);
  });
  it("automatic bidding stays daily-only (OpenAI refused it on a paused lifetime campaign, live check 2026-10-15)", () => {
    const auto = { name: "group one", context_hints: [], strategy: "maximize_clicks" as const };
    expect(() => groupBidding({ bidding_type: "clicks", budget: { lifetime_spend_limit_micros: 58_000_000 } }, auto)).toThrow(/daily budget/);
    expect(growthBundle.safeParse(bundle({ lifetime_budget_micros: 58_000_000 }, auto)).success).toBe(false);
    expect(growthBundle.safeParse(bundle({ daily_budget_micros: 25_000_000 }, auto)).success).toBe(true);
  });
  it("lifetime wallet funding = exact total; daily keeps 2x", () => {
    expect(fundingLimit({ budget: growthCampaignBudget({ lifetime_budget_micros: 58_000_000 }) })).toBe(58_000_000);
    expect(fundingLimit({ budget: growthCampaignBudget({ daily_budget_micros: 25_000_000 }), start_time: now, end_time: now + 2 * 86400 })).toBe(25_000_000 * 2 * 4);
  });
  it("the stored card carries one budget, never both", () => {
    const b = growthBundle.parse(bundle({ lifetime_budget_micros: 58_000_000 }));
    expect(growthCreateBody.safeParse({ bundle: b, name: "t", origin: "agent", lifetime_budget_usd: 58 }).success).toBe(true);
    expect(growthCreateBody.safeParse({ bundle: b, name: "t", origin: "agent", lifetime_budget_usd: 58, daily_budget_usd: 25 }).success).toBe(false);
  });
});
