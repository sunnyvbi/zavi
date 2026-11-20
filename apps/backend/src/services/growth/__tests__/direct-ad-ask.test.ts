import { describe, expect, it } from "vitest";
import { directAskFallback, parseDirectAdAsk, shapeDirectAsk } from "@/services/growth/direct-ad-ask";
import { adConstraint } from "@zavi/shared";

const TODAY = "2026-10-15";

describe("parseDirectAdAsk", () => {
  it("a total on one channel", () => {
    expect(parseDirectAdAsk("Run a $50 ChatGPT ad")).toEqual({ channel_slug: "chatgpt_ads", total_usd: 50, daily_usd: null, days: null });
    expect(parseDirectAdAsk("Please run $30 of TikTok ads")).toMatchObject({ channel_slug: "tiktok_ads", total_usd: 30 });
  });
  it("a daily rate for a number of days", () => {
    expect(parseDirectAdAsk("set it to $10/day for 3 days on ChatGPT ads")).toEqual({ channel_slug: "chatgpt_ads", total_usd: 30, daily_usd: 10, days: 3 });
    expect(parseDirectAdAsk("run tiktok ads at $25 a day for five days")).toEqual({ channel_slug: "tiktok_ads", total_usd: 125, daily_usd: 25, days: 5 });
  });
  it("not an order: no amount, two amounts, two channels, a question, a daily with no length", () => {
    for (const t of ["run some ChatGPT ads", "run a $50 or $60 ChatGPT ad", "run $50 on ChatGPT and TikTok ads", "should I run a $50 ChatGPT ad?", "don't run the $50 ChatGPT ad", "run ChatGPT ads at $10/day", "how did the $50 ChatGPT ad do", 42, null])
      expect(parseDirectAdAsk(t)).toBeNull();
  });
});

describe("parseDirectAdAsk fails closed on questions, hypotheticals and plans (security review)", () => {
  it("never turns a question or a what-if into a spend order", () => {
    for (const t of [
      "How would a $300 ChatGPT test look?",
      "How would a $300 ChatGPT test look",
      "Run a $50 ChatGPT ad?",
      "I would like to run $30 of TikTok ads",
      "if we run a $50 ChatGPT ad what happens",
      "maybe run a $50 ChatGPT ad",
      "thinking about a $50 ChatGPT test",
      "idea: run a $50 ChatGPT ad",
      "plan to run a $50 ChatGPT ad next week",
      "we could run a $50 ChatGPT ad",
      "run a ChatGPT test with $50 or $100",
      "$10/day for 3 days on ChatGPT, run it, $30 total",
    ]) expect(parseDirectAdAsk(t), t).toBeNull();
  });
});

describe("shapeDirectAsk (never more than asked)", () => {
  it("$50 ChatGPT -> one lifetime total of $50 over 2 days", () => {
    const r = shapeDirectAsk(parseDirectAdAsk("Run a $50 ChatGPT ad")!, TODAY);
    expect(r.kind === "plan" && r.plan).toMatchObject({ channel_slug: "chatgpt_ads", budget_type: "lifetime", total_usd: 50, days: 2, start: TODAY, end: "2026-10-17" });
    expect(r.kind === "plan" && r.line).toBe("Running $50.00 on ChatGPT as one total for 2 days. It can never spend more.");
  });
  it("$10/day x 3 on ChatGPT -> a $30 lifetime total over 3 days; the fallback is $25 for 1 day as one total", () => {
    const r = shapeDirectAsk(parseDirectAdAsk("$10/day for 3 days on ChatGPT, run it")!, TODAY);
    expect(r.kind === "plan" && r.plan).toMatchObject({ budget_type: "lifetime", total_usd: 30, days: 3 });
    if (r.kind !== "plan") throw new Error("no plan");
    expect(directAskFallback(r.plan)).toMatchObject({ budget_type: "lifetime", total_usd: 25, days: 1, end: "2026-10-16" });
    expect(directAskFallback({ ...r.plan, total_usd: 20 })).toBeNull();
  });
  it("TikTok under its $50 campaign minimum -> nothing, with the reason", () => {
    const r = shapeDirectAsk({ channel_slug: "tiktok_ads", total_usd: 40, daily_usd: null, days: null }, TODAY);
    expect(r).toEqual({ kind: "none", line: "TikTok's minimum is $50.00 for a campaign, so nothing ran. Ask for $50.00 or more." });
  });
  it("TikTok $10/day x 6 = $60 -> nothing fits once the extra timezone budget day is counted; it says so", () => {
    const r = shapeDirectAsk({ channel_slug: "tiktok_ads", total_usd: 60, daily_usd: 10, days: 6 }, TODAY);
    expect(r.kind).toBe("none");
  });
  it("TikTok $10/day x 10 = $100 -> reshaped above the minimum, every budget day counted", () => {
    const r = shapeDirectAsk({ channel_slug: "tiktok_ads", total_usd: 100, daily_usd: 10, days: 10 }, TODAY);
    expect(r.kind === "plan" && r.plan).toMatchObject({ budget_type: "daily", days: 3, total_usd: 100 });
    expect(r.kind === "plan" && r.plan.daily_usd! * (r.plan.days + 1)).toBeLessThanOrEqual(100);
    expect(r.kind === "plan" && r.reshaped).toBe(true);
  });
  it("a channel whose create cannot be capped (Reddit's two-card flow) runs nothing and says so", () => {
    const r = shapeDirectAsk({ channel_slug: "reddit_ads", total_usd: 150, daily_usd: null, days: null }, TODAY);
    expect(r.kind).toBe("none");
    expect(r.line).toMatch(/can't cap a Reddit ad/);
  });
  it("every other channel: factor x daily x days <= the ask (Meta 1.75, Google 2, X lifetime, LinkedIn lifetime)", () => {
    const meta = shapeDirectAsk({ channel_slug: "meta_ads", total_usd: 50, daily_usd: null, days: 3 }, TODAY);
    expect(meta.kind === "plan" && meta.plan).toMatchObject({ budget_type: "daily", daily_usd: 7.14, days: 3, total_usd: 50 });
    const google = shapeDirectAsk({ channel_slug: "google_ads", total_usd: 50, daily_usd: 10, days: 5 }, TODAY);
    expect(google.kind === "plan" && google.plan).toMatchObject({ budget_type: "daily", daily_usd: 4.16, days: 5 });
    const x = shapeDirectAsk({ channel_slug: "x_ads", total_usd: 50, daily_usd: null, days: null }, TODAY);
    expect(x.kind === "plan" && x.plan).toMatchObject({ budget_type: "lifetime", total_usd: 50, days: 7 });
    const li = shapeDirectAsk({ channel_slug: "linkedin_ads", total_usd: 150, daily_usd: null, days: null }, TODAY);
    expect(li.kind === "plan" && li.plan).toMatchObject({ budget_type: "lifetime", total_usd: 150, days: 7 });
  });
  it("factor x daily x days <= ask, for every bounded channel and amount", () => {
    for (const slug of ["chatgpt_ads", "tiktok_ads", "meta_ads", "google_ads", "x_ads", "linkedin_ads"]) for (const T of [25, 30, 50, 58, 99.99, 250]) for (const days of [null, 1, 2, 3, 9]) {
      const r = shapeDirectAsk({ channel_slug: slug, total_usd: T, daily_usd: null, days }, TODAY);
      if (r.kind !== "plan") continue;
      expect(r.plan.total_usd).toBeLessThanOrEqual(T);
      if (r.plan.budget_type === "daily") expect(adConstraint(slug)!.hold_factor * r.plan.daily_usd! * (r.plan.days + 1)).toBeLessThanOrEqual(T + 1e-9);
    }
  });
});
