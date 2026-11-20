import { describe, expect, it } from "vitest";
import { dispatchReadyBody, shapeChatgptBundle } from "@/services/tools/chatgpt-ads/propose";
import { CHATGPT_CREATE, growthBundle, growthCreateBody, parseGrowthAction } from "@/services/connectors/chatgpt-ads/growth-actions";
import { buildEnvelope, createFitsEnvelope, createMaxSpendUsd, createOf } from "@/services/approvals/approval-envelope";
import { budgetDaysTouched, type AdPlan } from "@/services/growth/ad-plan-shape";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const text = (r: () => number, min: number, max: number) => "Rent cars near you today with fair prices and real hosts".slice(0, min + Math.floor(r() * (max - min + 1)));

function modelInput(r: () => number): Record<string, unknown> {
  const bidding = r() < 0.8 ? "clicks" : pick(r, ["impressions", "conversions"] as const);
  const roll = r();
  const group =
    roll < 0.6 ? { strategy: "fixed_bid", max_bid_micros: 1 + Math.floor(r() * 5e6) }
    : roll < 0.75 ? { max_bid_micros: 1 + Math.floor(r() * 5e6) }
    : roll < 0.9 ? { strategy: bidding === "conversions" ? "maximize_conversions" : "maximize_clicks" }
    : { strategy: pick(r, ["maximize_clicks", "fixed_bid"] as const) };
  return {
    summary: text(r, 3, 40),
    rationale: text(r, 10, 60),
    campaign: {
      name: r() < 0.9 ? pick(r, ["Founder ask", "Spring test", "  Trimmed name  "]) : pick(r, ["ab", "x--y"]),
      bidding_type: bidding,
      ...(bidding === "conversions" && r() < 0.9 ? { conversion_event_setting_ids: ["evt_1"] } : {}),
      ...(r() < 0.5 ? { daily_budget_micros: Math.floor(r() * 900e6) } : {}),
      ...(r() < 0.5 ? { start_time: Math.floor(Date.now() / 1000) + Math.floor(r() * 1e6) } : {}),
      ...(r() < 0.5 ? { end_time: Math.floor(Date.now() / 1000) - 100 } : {}),
      targeting: r() < 0.9 ? { locations: { countries: [pick(r, ["US", "CA", "GB"])] } } : {},
    },
    group: { name: r() < 0.95 ? "Intent group" : "ab", context_hints: [text(r, 1, 30)], ...group },
    ads: [{
      name: r() < 0.95 ? "Intent ad" : "a",
      title: text(r, 3, r() < 0.9 ? 50 : 60),
      body: text(r, r() < 0.95 ? 1 : 0, r() < 0.9 ? 100 : 110),
      ...(r() < 0.95 ? { target_url: r() < 0.9 ? "https://example.com/cars" : pick(r, ["http://example.com", "https://localhost/x"]) } : {}),
      ...(r() < 0.95 ? { image_url: "https://example.com/img.png" } : {}),
    }],
  };
}

function plan(r: () => number): AdPlan {
  const days = 1 + Math.floor(r() * 14);
  const today = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  if (r() < 0.7) {
    const total = Math.round((25 + r() * 500) * 100) / 100;
    return { channel_slug: "chatgpt_ads", budget_type: "lifetime", total_usd: total, daily_usd: null, start: today, end, days, switched_from: null };
  }
  const daily = Math.round((25 + r() * 75) * 100) / 100;
  return { channel_slug: "chatgpt_ads", budget_type: "daily", total_usd: Math.round(2 * daily * (days + 1) * 100) / 100, daily_usd: daily, start: today, end, days, switched_from: null };
}

const bodyOf = (bundle: ReturnType<typeof growthBundle.parse>) => ({
  bundle,
  name: bundle.campaign.name,
  origin: "user_initiated_chat" as const,
  currency: "USD",
  ...(bundle.campaign.lifetime_budget_micros != null ? { lifetime_budget_usd: bundle.campaign.lifetime_budget_micros / 1e6 } : { daily_budget_usd: bundle.campaign.daily_budget_micros! / 1e6 }),
});

describe("propose-accepted ChatGPT bodies are dispatch-valid", () => {
  it("a founder's direct ask: 2,000 random model inputs x plans", () => {
    let accepted = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const r = rng(seed);
      const p = plan(r);
      let bundle: ReturnType<typeof growthBundle.parse>;
      try {
        bundle = shapeChatgptBundle(modelInput(r), p, Date.now());
      } catch {
        continue;
      }
      let body: ReturnType<typeof bodyOf>;
      try {
        body = dispatchReadyBody(bodyOf(bundle));
      } catch {
        continue;
      }
      accepted++;
      expect(() => parseGrowthAction(CHATGPT_CREATE, body), `seed ${seed}`).not.toThrow();
      const create = createOf(CHATGPT_CREATE, body);
      expect(create, `seed ${seed}`).not.toBeNull();
      expect(createMaxSpendUsd(create!), `seed ${seed}`).toBeLessThanOrEqual(p.total_usd + 1e-6);
      if (p.budget_type === "lifetime") expect(bundle.campaign.end_time - bundle.campaign.start_time, `seed ${seed}`).toBe(p.days * 86_400);
      else expect(budgetDaysTouched(bundle.campaign.start_time, bundle.campaign.end_time), `seed ${seed}`).toBe(p.days);
      const env = buildEnvelope({ envelope_id: "ask:r", tenant_id: "t", approver: { user_id: "u", role: "owner", surface: "chat" }, plan: p });
      expect(createFitsEnvelope(env, create), `seed ${seed}`).toBe(true);
    }
    expect(accepted).toBeGreaterThan(200);
  });

  it("without an ask: every bundle the tool parses is dispatch-valid", () => {
    let accepted = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const r = rng(seed);
      const input = modelInput(r);
      const c = input.campaign as Record<string, unknown>;
      if (r() < 0.5) Object.assign(c, { start_time: Math.floor(Date.now() / 1000) + 600, end_time: Math.floor(Date.now() / 1000) + 600 + 86_400, daily_budget_micros: 25e6 });
      const parsed = growthBundle.safeParse(input);
      if (!parsed.success) continue;
      accepted++;
      expect(growthCreateBody.safeParse(bodyOf(parsed.data)).success, `seed ${seed}`).toBe(true);
    }
    expect(accepted).toBeGreaterThan(50);
  });

  it("dispatchReadyBody refuses exactly what dispatch would refuse, and tells the model why", () => {
    const p: AdPlan = { channel_slug: "chatgpt_ads", budget_type: "lifetime", total_usd: 25, daily_usd: null, start: new Date().toISOString().slice(0, 10), end: "2099-01-01", days: 1, switched_from: null };
    const bundle = shapeChatgptBundle({
      summary: "One day test", rationale: "The founder asked for it directly.",
      campaign: { name: "Founder ask", bidding_type: "clicks", targeting: { locations: { countries: ["US"] } } },
      group: { name: "Intent group", context_hints: ["cars"], strategy: "fixed_bid", max_bid_micros: 2_000_000 },
      ads: [{ name: "Intent ad", title: "Rent a car", body: "Near you", target_url: "https://example.com", image_url: "https://example.com/i.png" }],
    }, p, Date.now());
    expect(() => dispatchReadyBody({ ...bodyOf(bundle), origin: "someone_else" as never })).toThrow(/would be refused when it runs.*origin/);
    expect(() => dispatchReadyBody({ ...bodyOf(bundle), daily_budget_usd: 25, lifetime_budget_usd: 25 })).toThrow(/would be refused/);
  });
});
