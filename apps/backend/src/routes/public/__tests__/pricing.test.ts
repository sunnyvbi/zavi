import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ blob: null as unknown, throws: false }));

vi.mock("@/services/tenant-client", () => ({
  globalClient: () => {
    if (H.throws) throw new Error("db down");
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: { blob: H.blob }, error: null }),
    };
    return { from: () => q };
  },
}));

import { publicPricing, buildPublicPricing } from "../pricing";
import { CHANNELS, PRICING_CONFIG, RETIRED_CHANNEL_SLUGS } from "@zavi/shared";
import { DEFAULT_TIER_AGENT_MIN, requiredTierFor, tierRank, type Tier } from "@/services/billing/tiers";

function makeRes() {
  return {
    headers: {} as Record<string, string>,
    body: undefined as any,
    set(k: string, v: string) {
      this.headers[k] = v;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

describe("GET /api/public/pricing", () => {
  beforeEach(() => {
    H.blob = null;
    H.throws = false;
  });

  it("returns 4 tiers + 3 packs from defaults when config is empty", async () => {
    const res = makeRes();
    await publicPricing({} as any, res as any);
    const b = res.body;
    expect(b.tiers.map((t: any) => t.slug)).toEqual(["free", "starter", "growth", "pro"]);
    expect(b.tiers.map((t: any) => t.usd)).toEqual([0, 20, 120, 240]);
    expect(b.tiers.map((t: any) => t.monthly_credits)).toEqual([0, 8000, 48000, 96000]);
    expect(b.free_daily_credits).toBe(1000);
    expect(b.tiers.every((t: any) => t.daily_credits === 1000)).toBe(true);
    expect(b.topup_packs).toEqual([
      { usd: 20, credits: 8000 },
      { usd: 120, credits: 48000 },
      { usd: 240, credits: 96000 },
    ]);
    expect(b.tiers[3].includes).toContain("Meta Ads");
    expect(b.tiers[3].includes).toContain("Email");
    expect(b.tiers[1].includes).toContain("Instagram");
    expect(b.tiers[1].includes).not.toContain("TikTok");
    expect(b.tiers[2].includes).toEqual(["Everything in Starter, plus:", "UGC Videos (real creators)", "TikTok", "YouTube"]);
    expect(b.tiers[0].includes[0]).toBe("Website analysis and 30-day growth plan");
    expect(b.tiers.flatMap((t: any) => t.includes).join(" ")).not.toMatch(/coming soon/i);
    expect(b.tiers.every((t: any) => t.includes.every((l: string) => !/credits a (month|day)/.test(l)))).toBe(true);
    expect(b.tiers.map((t: any) => t.six_month_usd)).toEqual([0, 60, 360, 720]);
    expect(b.tiers.map((t: any) => t.six_month_per_month_usd)).toEqual([0, 10, 60, 120]);
    expect(b.six_month_discount_pct).toBe(50);
    expect(b.six_month_months).toBe(6);
    expect(Array.isArray(b.rungs) && b.rungs.length).toBeTruthy();
    expect(res.headers["Cache-Control"]).toBe("public, max-age=60, stale-while-revalidate=300");
  });

  it("derives credit numbers from config, not literals", () => {
    const b = buildPublicPricing({ tier_credits: { starter: 9000, pro: 100000 }, free_daily_credits: 1500 });
    expect(b.tiers[1].monthly_credits).toBe(9000);
    expect(b.tiers[2].monthly_credits).toBe(48000);
    expect(b.tiers[0].daily_credits).toBe(1500);
    expect(b.free_daily_credits).toBe(1500);
    expect(b.tiers[1].daily_credits).toBe(1500);
    expect(b.topup_packs[2]).toEqual({ usd: 240, credits: 100000 });
  });

  it("falls back to defaults when the config read throws", async () => {
    H.throws = true;
    const res = makeRes();
    await publicPricing({} as any, res as any);
    expect(res.body.tiers).toHaveLength(4);
    expect(res.body.free_daily_credits).toBe(1000);
  });

  it("has no em-dashes in customer copy", () => {
    const all = buildPublicPricing(null).tiers.flatMap((t) => [t.name, ...t.includes]).join(" ");
    expect(all).not.toMatch(/—/);
  });

  it("sells each pricing row at exactly the tier the gate lets run it", () => {
    const SOLD_BELOW_GATE: Record<string, Tier> = { build: "free" };
    for (const f of PRICING_CONFIG.features) {
      const slugs = f.channels ? f.channels.flatMap((c) => (c.slug ? [c.slug] : [])) : (f.agents ?? []);
      expect(slugs.length, `${f.key} names no agent or channel`).toBeGreaterThan(0);
      for (const s of slugs) expect(DEFAULT_TIER_AGENT_MIN[s] ?? requiredTierFor(s), `${f.key}: ${s} unknown to the gate`).toBeDefined();
      const gate = slugs
        .map((s) => requiredTierFor(s))
        .reduce<Tier>((lo, t) => (tierRank(t) < tierRank(lo) ? t : lo), "pro");
      expect(f.min_tier, `${f.key}`).toBe(SOLD_BELOW_GATE[f.key] ?? gate);
      for (const c of f.channels ?? []) if (c.slug) expect(requiredTierFor(c.slug), `${f.key}: ${c.name}`).toBe(f.min_tier);
    }
  });

  it("lists every real channel once and nothing that is not a channel", () => {
    const listed = PRICING_CONFIG.features.flatMap((f) => f.channels ?? []);
    const known = new Set<string>(CHANNELS.map((c) => c.slug).filter((s) => !RETIRED_CHANNEL_SLUGS.has(s)));
    for (const c of listed) expect(c.slug && known.has(c.slug), `${c.name} is not a sellable channel`).toBe(true);
    const coveredBy: Record<string, string> = { youtube_ads: "google_ads" };
    const slugs = new Set(listed.map((c) => c.slug));
    for (const slug of known) {
      expect(slugs.has(slug) || slugs.has(coveredBy[slug] ?? ""), `${slug} is missing from the pricing page`).toBe(true);
    }
  });
});
