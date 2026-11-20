import { describe, expect, it } from "vitest";
import { shapeDirectAsk } from "@/services/growth/direct-ad-ask";
import { addDays, dailyBudgetDays, dailyHoldEndsOn, flightEndMs, holdOf, planBudgetDays, rollingEndMs } from "@/services/growth/ad-plan-shape";
import { buildEnvelope, createFitsEnvelope, createMaxSpendUsd, createOf } from "@/services/approvals/approval-envelope";
import { adConstraint } from "@zavi/shared";

const TODAY = "2026-10-17";
const DAY = 86_400;
const iso = (ms: number) => new Date(ms).toISOString();
const payloadOf = (channel: string, daily: number, startMs: number, endMs: number) => {
  if (channel === "meta_ads") return ["meta_ads.launch_campaign", { currency: "USD", campaign: { daily_budget_usd: daily }, ad_set: { end_time: iso(endMs) } }] as const;
  if (channel === "google_ads") return ["google_ads.create_campaign", { daily_budget_usd: daily, end_date: iso(endMs).slice(0, 10), location_ids: ["2840"] }] as const;
  return ["tiktok_ads.create_launch", { daily_budget_usd: daily, start_time: iso(startMs), end_date: iso(endMs).slice(0, 10) }] as const;
};
const localDays = (start_s: number, end_s: number, offsetH: number) => {
  const o = offsetH * 3600;
  return Math.ceil((end_s + o) / DAY) - Math.floor((start_s + o) / DAY);
};
const OFFSETS = Array.from({ length: 27 }, (_, i) => i - 12);

describe("daily-budget direct asks never spend more than asked, in any account timezone", () => {
  it("Meta '$25 for 1 day' at 14:32 UTC", () => {
    const shape = shapeDirectAsk({ channel_slug: "meta_ads", total_usd: 25, daily_usd: null, days: 1 }, TODAY);
    if (shape.kind !== "plan") throw new Error(shape.line);
    const now = Date.parse(`${TODAY}T14:32:00Z`);
    const [cls, payload] = payloadOf("meta_ads", shape.plan.daily_usd!, now, flightEndMs(shape.plan, now));
    const create = createOf(cls, payload, now)!;
    const f = adConstraint("meta_ads")!.hold_factor;
    for (const o of OFFSETS) expect(shape.plan.daily_usd! * f * localDays(create.start_s, create.end_s, o), `UTC${o}`).toBeLessThanOrEqual(25 + 1e-9);
    expect(createMaxSpendUsd(create)).toBeLessThanOrEqual(25 + 1e-9);
    expect(dailyBudgetDays(create.start_s, create.end_s)).toBe(planBudgetDays(1));
    const env = buildEnvelope({ envelope_id: "ask:r", tenant_id: "t", approver: { user_id: "u", role: "owner", surface: "chat" }, plan: shape.plan });
    expect(createFitsEnvelope(env, create)).toBe(true);
    const rolled = createOf(cls, payloadOf("meta_ads", shape.plan.daily_usd!, now, rollingEndMs(shape.plan, now))[1], now)!;
    expect(createFitsEnvelope(env, rolled)).toBe(false);
  });

  it("Meta '$25 for 1 day': the dispatch hold's ends_on covers both budget days (daily x 1.75 x 2 = $24.99)", () => {
    const shape = shapeDirectAsk({ channel_slug: "meta_ads", total_usd: 25, daily_usd: null, days: 1 }, TODAY);
    if (shape.kind !== "plan") throw new Error(shape.line);
    const now = Date.parse(`${TODAY}T14:32:00Z`);
    const endMs = flightEndMs(shape.plan, now);
    const endsOn = dailyHoldEndsOn(Math.floor(endMs / 1000));
    const heldDays = (Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${TODAY}T00:00:00Z`)) / 86_400_000;
    expect(heldDays).toBe(2);
    const held = Math.round(shape.plan.daily_usd! * 1.75 * heldDays * 100) / 100;
    expect(held).toBeCloseTo(24.99, 2);
    expect(holdOf(shape.plan, 17, 1)).toBe(25);
  });

  it.each(["meta_ads", "google_ads", "tiktok_ads"])("%s: any amount, length, start minute and offset", (channel) => {
    const f = adConstraint(channel)!.hold_factor;
    let plans = 0;
    for (const total of [25, 50, 60, 100, 300]) for (const days of [1, 2, 3, 7]) {
      const shape = shapeDirectAsk({ channel_slug: channel, total_usd: total, daily_usd: null, days }, TODAY);
      if (shape.kind !== "plan") continue;
      plans++;
      const p = shape.plan;
      expect(p.budget_type).toBe("daily");
      const env = buildEnvelope({ envelope_id: "ask:r", tenant_id: "t", approver: { user_id: "u", role: "owner", surface: "chat" }, plan: p });
      for (let minute = 0; minute < 24 * 60; minute += 37) {
        const now = Date.parse(`${TODAY}T00:00:00Z`) + minute * 60_000;
        const [cls, payload] = payloadOf(channel, p.daily_usd!, now, flightEndMs(p, now));
        const create = createOf(cls, payload, now);
        const tag = `${channel} $${total} ${days}d +${minute}m`;
        expect(create, tag).not.toBeNull();
        for (const o of OFFSETS) expect(p.daily_usd! * f * localDays(create!.start_s, create!.end_s, o), `${tag} UTC${o}`).toBeLessThanOrEqual(total + 1e-9);
        expect(dailyBudgetDays(create!.start_s, create!.end_s), tag).toBe(planBudgetDays(p.days));
        expect(dailyHoldEndsOn(create!.end_s), tag).toBe(addDays(TODAY, planBudgetDays(p.days)));
        expect(createMaxSpendUsd(create!), tag).toBeLessThanOrEqual(total + 1e-9);
        expect(createFitsEnvelope(env, create), tag).toBe(true);
      }
    }
    expect(plans).toBeGreaterThan(3);
  });

  it("below the platform minimum it says so and runs nothing (never more than asked)", () => {
    const r = shapeDirectAsk({ channel_slug: "tiktok_ads", total_usd: 40, daily_usd: null, days: 1 }, TODAY);
    expect(r.kind).toBe("none");
  });
});
