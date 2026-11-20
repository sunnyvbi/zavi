import { describe, expect, it } from "vitest";
import { shapeAdPlan, holdOf, adPlanAsk, adPlanBoundaries, noFitNote } from "@/services/growth/ad-plan-shape";

describe("shapeAdPlan (Autopilot, Flow 2)", () => {
  it("aethel: $58 left, 17 days, ChatGPT only -> lifetime $58 over 2 days, held $58", () => {
    const r = shapeAdPlan({ want_usd: 58, left_usd: 58, days_left: 17, margin: 1, today: "2026-10-15", preferred: "chatgpt_ads", connected: ["chatgpt_ads"] });
    expect(r.kind === "plan" && r.plan).toMatchObject({ channel_slug: "chatgpt_ads", budget_type: "lifetime", total_usd: 58, days: 2, start: "2026-10-15", end: "2026-10-17" });
    if (r.kind === "plan") expect(holdOf(r.plan, 17, 1)).toBe(58);
  });
  it("$500/mo, Meta $10/day live, day 10, TikTok wanted -> TikTok ~$20/day x 8 days (+1 timezone budget day), held <= $190 not $462", () => {
    const r = shapeAdPlan({ want_usd: 190, left_usd: 190, days_left: 22, margin: 1, today: "2026-10-10", preferred: "tiktok_ads", connected: ["meta_ads", "tiktok_ads"] });
    expect(r.kind === "plan" && r.plan).toMatchObject({ channel_slug: "tiktok_ads", budget_type: "daily", daily_usd: 20.01, days: 8 });
    if (r.kind === "plan") {
      expect(holdOf(r.plan, 22, 1)).toBeLessThanOrEqual(190);
      expect(holdOf(r.plan, 22, 1)).toBeLessThan(462);
    }
  });
  it("$40 left, only TikTok -> no order, one note naming the amount", () => {
    const r = shapeAdPlan({ want_usd: 40, left_usd: 40, days_left: 17, margin: 1, today: "2026-10-15", preferred: "tiktok_ads", connected: ["tiktok_ads"] });
    expect(r).toEqual({ kind: "none", add_usd: 10, channel_slug: "tiktok_ads" });
    expect(noFitNote(r as never)).toBe("Add $10 or wait for next month to run an ad test.");
  });
  it("preferred channel can't fit -> silent switch inside the cap", () => {
    const r = shapeAdPlan({ want_usd: 40, left_usd: 40, days_left: 17, margin: 1, today: "2026-10-15", preferred: "tiktok_ads", connected: ["tiktok_ads", "meta_ads"] });
    expect(r.kind === "plan" && r.plan.channel_slug).toBe("meta_ads");
    expect(r.kind === "plan" && r.plan.switched_from).toBe("tiktok_ads");
  });
  it("a small budget never moves onto LinkedIn from another channel, though LinkedIn's launch floor is $10", () => {
    const base = { margin: 1, today: "2026-10-15", days_left: 17, preferred: "reddit_ads" };
    for (const usd of [10, 50, 99.99]) {
      const r = shapeAdPlan({ ...base, want_usd: usd, left_usd: usd, connected: ["reddit_ads", "linkedin_ads"] });
      expect(r.kind).toBe("none");
      expect(r).toMatchObject({ add_usd: Math.ceil(100 - usd) });
    }
    const big = shapeAdPlan({ ...base, want_usd: 150, left_usd: 150, preferred: "tiktok_ads", connected: ["tiktok_ads", "linkedin_ads"], exclude: ["tiktok_ads"] });
    expect(big.kind === "plan" && big.plan).toMatchObject({ channel_slug: "linkedin_ads", switched_from: "tiktok_ads" });
  });
  it("a founder who chose LinkedIn still gets the $10 plan the live launch accepted", () => {
    const r = shapeAdPlan({ want_usd: 10, left_usd: 10, days_left: 17, margin: 1, today: "2026-10-15", preferred: "linkedin_ads", connected: ["linkedin_ads"] });
    expect(r.kind === "plan" && r.plan).toMatchObject({ channel_slug: "linkedin_ads", budget_type: "lifetime", total_usd: 10, switched_from: null });
  });
  it("must-not-exceed: never above min(want, left), never held above left", () => {
    let plans = 0;
    for (const left of [1, 24.99, 25, 49.5, 58, 120.33, 999]) for (const want of [5, 25, 58, 400]) for (const d of [1, 2, 17, 31])
      for (const slug of ["chatgpt_ads", "meta_ads", "tiktok_ads", "reddit_ads", "google_ads", "x_ads", "linkedin_ads"]) {
        const r = shapeAdPlan({ margin: 1, today: "2026-10-01", days_left: d, want_usd: want, left_usd: left, preferred: slug, connected: [slug] });
        if (r.kind !== "plan") continue;
        plans++;
        expect(r.plan.total_usd).toBeLessThanOrEqual(Math.min(want, left) + 1e-9);
        expect(holdOf(r.plan, d, 1)).toBeLessThanOrEqual(left + 1e-9);
        expect(r.plan.days).toBeLessThanOrEqual(d);
      }
    expect(plans).toBeGreaterThan(50);
  });
  it("no Autopilot budget (a founder yes with no month): left = Infinity", () => {
    const r = shapeAdPlan({ want_usd: 50, left_usd: Infinity, days_left: 17, margin: 1, today: "2026-10-15", preferred: "chatgpt_ads", connected: ["chatgpt_ads"] });
    expect(r.kind === "plan" && r.plan).toMatchObject({ budget_type: "lifetime", total_usd: 50, days: 2 });
  });
  it("nothing connected -> connect note", () => {
    const r = shapeAdPlan({ want_usd: 50, left_usd: 50, days_left: 17, margin: 1, today: "2026-10-15", preferred: "chatgpt_ads", connected: [] });
    expect(r).toEqual({ kind: "none", add_usd: 0, channel_slug: null });
    expect(noFitNote(r as never)).toBe("Connect an ad channel to run an ad test.");
  });
  it("the ask names channel, total, dates", () => {
    const r = shapeAdPlan({ want_usd: 58, left_usd: 58, days_left: 17, margin: 1, today: "2026-10-15", preferred: "chatgpt_ads", connected: ["chatgpt_ads"] });
    if (r.kind !== "plan") throw new Error("no plan");
    expect(adPlanAsk(r.plan)).toBe("Should I spend $58.00 on ChatGPT ads from Oct 15 to Oct 16? It is one total for the whole test, so it can never spend more.");
    expect(adPlanBoundaries(r.plan)).toContain("LIFETIME budget of exactly $58.00, start 2026-10-15, end 2026-10-17");
  });
});
