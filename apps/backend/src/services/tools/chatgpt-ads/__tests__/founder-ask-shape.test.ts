import { describe, expect, it } from "vitest";
import { shapeChatgptBundle } from "@/services/tools/chatgpt-ads/propose";
import { growthBundle } from "@/services/connectors/chatgpt-ads/growth-actions";
import { buildEnvelope, createFitsEnvelope, createOf } from "@/services/approvals/approval-envelope";

const NOW = Date.parse("2026-10-15T18:00:00Z");
const base = (group: Record<string, unknown>) => growthBundle.parse({
  rationale: "The founder asked for a ChatGPT test.", summary: "Founder ask",
  campaign: { name: "Zavi test", bidding_type: "clicks", targeting: { locations: { countries: ["US"] } }, daily_budget_micros: 400_000_000, start_time: NOW / 1000 + 3600, end_time: NOW / 1000 + 30 * 86400 },
  group,
  ads: [{ name: "ad one", title: "Title", body: "Body text", target_url: "https://example.com", image_url: "https://example.com/a.png" }],
});
const plan = { channel_slug: "chatgpt_ads", budget_type: "lifetime" as const, total_usd: 50, daily_usd: null, start: "2026-10-15", end: "2026-10-17", days: 2, switched_from: null };

describe("shapeChatgptBundle", () => {
  it("replaces the agent's budget and dates with the founder's plan; the result fits the envelope", () => {
    const b = shapeChatgptBundle(base({ name: "group one", context_hints: [], strategy: "fixed_bid", max_bid_micros: 2_000_000 }), plan, NOW);
    expect(b.campaign).toMatchObject({ lifetime_budget_micros: 50_000_000, start_time: NOW / 1000 + 600, end_time: NOW / 1000 + 600 + 2 * 86400 });
    expect(b.campaign.daily_budget_micros).toBeUndefined();
    const env = buildEnvelope({ envelope_id: "ask:r", tenant_id: "t", approver: { user_id: "u", role: "owner", surface: "chat" }, plan });
    expect(createFitsEnvelope(env, createOf("chatgpt_ads.create_and_launch", { bundle: b, currency: "USD" }))).toBe(true);
  });
  it("the model may leave out the budget and dates; its own are ignored", () => {
    const { daily_budget_micros: _d, start_time: _s, end_time: _e, ...campaign } = base({ name: "group one", context_hints: [], strategy: "fixed_bid", max_bid_micros: 2_000_000 }).campaign;
    const b = shapeChatgptBundle({ ...base({ name: "group one", context_hints: [], strategy: "fixed_bid", max_bid_micros: 2_000_000 }), campaign }, plan, NOW);
    expect(b.campaign.lifetime_budget_micros).toBe(50_000_000);
    expect(b.campaign.end_time - b.campaign.start_time).toBe(2 * 86400);
  });
  it("a 1-day ask made late in the UTC day still fits its envelope and runs 24 hours", () => {
    const late = Date.parse("2026-10-15T23:30:00Z");
    const one = { ...plan, total_usd: 25, end: "2026-10-16", days: 1 };
    const b = shapeChatgptBundle(base({ name: "group one", context_hints: [], strategy: "fixed_bid", max_bid_micros: 2_000_000 }), one, late);
    expect(b.campaign.end_time - b.campaign.start_time).toBe(86400);
    const env = buildEnvelope({ envelope_id: "ask:r", tenant_id: "t", approver: { user_id: "u", role: "owner", surface: "chat" }, plan: one });
    expect(createFitsEnvelope(env, createOf("chatgpt_ads.create_and_launch", { bundle: b, currency: "USD" }))).toBe(true);
    const longer = { ...b, campaign: { ...b.campaign, end_time: b.campaign.end_time + 86400 } };
    expect(createFitsEnvelope(env, createOf("chatgpt_ads.create_and_launch", { bundle: longer, currency: "USD" }))).toBe(false);
  });
  it("a lifetime ask with automatic bidding tells the agent to use a fixed bid", () => {
    expect(() => shapeChatgptBundle(base({ name: "group one", context_hints: [], strategy: "maximize_clicks" }), plan, NOW)).toThrow(/fixed bidding/);
  });
});
