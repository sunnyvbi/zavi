import { describe, expect, it } from "vitest";
import { isRecurringAsk } from "../recurring-intent-classify";

describe("isRecurringAsk", () => {
  it.each([
    "Send me daily standup update to me about what zavi worked on today for my business.",
    "every Monday 9am post stalled approvals to #ops",
    "check my competitors weekly",
    "tell me when our Meta CPA goes above $60",
    "let me know whenever a new 1-star review comes in",
    "alert me if bookings drop below 20 a day",
    "keep an eye on Turo's pricing in LA",
    "each morning send me yesterday's signups",
    "every 2 hours check the checkout error rate",
    "once a week summarize my ad spend",
    "on Fridays send me a recap",
    "send me an end of day summary",
    "give me a morning briefing",
    "build me an agent that tracks new listings",
    "create a custom agent for churn alerts",
    "set up a bot to post the weekly report to #growth",
    "from now on send me the numbers after every campaign",
  ])("matches recurring ask: %s", (msg) => {
    expect(isRecurringAsk(msg)).toBe(true);
  });

  it.each([
    "what did zavi work on today?",
    "post this to #ops now",
    "tell me what our CPA is",
    "how many bookings did we get yesterday",
    "fix the checkout button",
    "",
  ])("does not match one-off ask: %s", (msg) => {
    expect(isRecurringAsk(msg)).toBe(false);
  });
});
