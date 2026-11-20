import { describe, expect, it } from "vitest";
import { buildEnvelope, createFitsEnvelope, createOf, retimeEnvelopeFlight } from "@/services/approvals/approval-envelope";

const day = 86_400;
const T0 = Date.parse("2026-10-17T15:00:00Z");
const env = (channel: string, budget: "daily" | "lifetime", total: number, daily: number | null, days: number) =>
  buildEnvelope({ envelope_id: "ask:r", tenant_id: "t", approver: { user_id: "u", role: "owner", surface: "chat" }, plan: { channel_slug: channel, budget_type: budget, total_usd: total, daily_usd: daily, start: "2026-10-17", end: new Date(Date.parse("2026-10-17T00:00:00Z") + days * day * 1000).toISOString().slice(0, 10), days, switched_from: null } });

describe("retimeEnvelopeFlight", () => {
  it("Meta (a daily budget) is never re-timed: its date-boundary end stays", () => {
    const e = env("meta_ads", "daily", 30, 5, 3);
    const filed = { currency: "USD", campaign: { daily_budget_usd: 5 }, ad_set: { end_time: "2026-10-20T00:00:00+00:00" } };
    expect(retimeEnvelopeFlight("meta_ads.launch_campaign", filed, e, T0 + 3600_000)).toBe(filed);
  });
  it("X on a daily budget and ChatGPT on a daily budget are not re-timed either", () => {
    const x = env("x_ads", "daily", 40, 10, 2);
    const xp = { currency: "USD", launch: "ACTIVE", daily_budget: 10, end_time: "2026-10-19T00:00:00Z" };
    expect(retimeEnvelopeFlight("x_ads.create_campaign", xp, x, T0 + 3600_000)).toBe(xp);
    const c = env("chatgpt_ads", "daily", 100, 25, 2);
    const cp = { currency: "USD", bundle: { campaign: { daily_budget_micros: 25e6, start_time: T0 / 1000 - 3600, end_time: Date.parse("2026-10-19T00:00:00Z") / 1000 } } };
    expect(retimeEnvelopeFlight("chatgpt_ads.create_and_launch", cp, c, T0 + 3600_000)).toBe(cp);
  });
  it("LinkedIn and X: the end moves to now + the asked span", () => {
    const li = env("linkedin_ads", "lifetime", 50, null, 2);
    const later = T0 + 7200_000;
    expect((retimeEnvelopeFlight("linkedin_ads.launch_campaign", { currency: "USD", total_budget_usd: 50, end_time: T0 + 2 * day * 1000 }, li, later) as { end_time: number }).end_time).toBe(later + 2 * day * 1000);
    const x = env("x_ads", "lifetime", 40, null, 2);
    const xo = retimeEnvelopeFlight("x_ads.create_campaign", { currency: "USD", launch: "ACTIVE", daily_budget: 20, total_budget: 40, end_time: new Date(T0 + 2 * day * 1000).toISOString() }, x, later) as { end_time: string };
    expect(Date.parse(xo.end_time)).toBe(later + 2 * day * 1000);
  });
  it("ChatGPT: a passed start moves to now and keeps its 24h span; a future start is untouched", () => {
    const e = env("chatgpt_ads", "lifetime", 25, null, 1);
    const start = T0 / 1000 + 600;
    const filed = { currency: "USD", bundle: { campaign: { lifetime_budget_micros: 25e6, start_time: start, end_time: start + day } } };
    expect(retimeEnvelopeFlight("chatgpt_ads.create_and_launch", filed, e, T0)).toBe(filed);
    const later = T0 + 3 * 3600_000;
    const out = retimeEnvelopeFlight("chatgpt_ads.create_and_launch", filed, e, later) as typeof filed;
    expect(out.bundle.campaign.start_time).toBe(later / 1000 + 60);
    expect(out.bundle.campaign.end_time - out.bundle.campaign.start_time).toBe(day);
  });
  it("never past what the envelope accepts: a late LinkedIn dispatch is clamped", () => {
    const li = env("linkedin_ads", "lifetime", 50, null, 2);
    const muchLater = T0 + 1.5 * day * 1000;
    const filed = { currency: "USD", total_budget_usd: 50, end_time: T0 + 2 * day * 1000 };
    const out = retimeEnvelopeFlight("linkedin_ads.launch_campaign", filed, li, muchLater) as typeof filed;
    expect(createFitsEnvelope(li, createOf("linkedin_ads.launch_campaign", out, muchLater))).toBe(true);
    expect(out.end_time).toBeLessThan(muchLater + 2 * day * 1000);
  });
  it("other classes and unreadable payloads are returned as filed", () => {
    const e = env("tiktok_ads", "daily", 100, 25, 2);
    const p = { daily_budget_usd: 25, start_time: "2026-10-17T15:00:00Z", end_date: "2026-10-19" };
    expect(retimeEnvelopeFlight("tiktok_ads.create_launch", p, e, T0)).toBe(p);
    expect(retimeEnvelopeFlight("meta_ads.launch_campaign", null, e, T0)).toBeNull();
  });
});
