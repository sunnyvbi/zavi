import type { BlogPost } from "../types";

export const canAiRunMyFacebookAds: BlogPost = {
  slug: "can-ai-run-my-facebook-ads",
  query: "can ai run my facebook ads",
  title: "Can AI run my Facebook ads? A real company's 30-day public test",
  description:
    "We gave an AI growth agent $25,000 and 30 days to run a real car-rental company's Meta and Google ads, with a public daily log. What it did, what it got wrong, and the numbers so far.",
  h1: "Can AI run my Facebook ads? A real company's 30-day public test",
  datePublished: "2026-10-12",
  dateModified: "2026-10-12",
  reviewedAt: "2026-10-12",
  answer:
    "Yes, an AI agent can run Facebook and Instagram ads: reading results daily, moving budget to what works, and drafting new ads, ideally inside a spend limit the software enforces. In our public test on a real company, by day 12 the agent had spent about $8,300 of a $25,000 budget while bookings ran well ahead of the company's normal pace, with a daily log published for anyone to read.",
  body: `Most "AI runs your ads" claims come with a demo account. We wanted a real one. On 1 October 2026 we handed **Upcar**, a real peer-to-peer car-rental marketplace (run by Zavi's founder, so the money and the results are real), to Zavi, our AI growth agent, with three rules:

- **$25,000** of real ad money for 30 days (1 to 30 October).
- **Hands off:** we do not pause or override it. If a person steps in, it goes in the public log.
- It can only place ads and move budget on the accounts Upcar has connected. Elsewhere it researches and drafts.

The scoreboard and a daily log are public at [zaviagent.com/live/upcar](/live/upcar), with one page for each published day.

## What the agent actually does each day

It reads every campaign and ad set, decides what to change, and writes down why in plain words. Some days it changes nothing and says so. Examples from its own log:

- **Day 2:** changed seven budgets across Google and Meta. ([day 2](/live/upcar/day/2))
- **Day 7:** raised a Meta budget from $40 to $80 a day. ([day 7](/live/upcar/day/7))
- **Day 9:** changed three budgets across Google and Meta, and had a further raise refused because the month's spend limit did not have room for it. ([day 9](/live/upcar/day/9))
- **Day 11:** spotted one ad that brought in paying renters for less and spent its whole budget every day, and asked to back it with the last room left under the monthly limit. ([day 11](/live/upcar/day/11))

## The numbers so far

As of **day 12 (12 October 2026, 18:23 UTC)**. The live page is the number of record and keeps moving:

| Measure | As of day 12 |
| --- | --- |
| Ad money spent | about $8,300 of $25,000 |
| Bookings (total price of trips booked) | about $141,000 |
| Upcar's normal pace for the same 12 days | about $91,500 |
| 30-day goal, set before day 1 | $300,000 |

Two honest caveats. "Normal pace" is Upcar's average over the four weeks before the test, not a controlled experiment, so part of the gap could be season or luck. And both the booking total and the normal pace include the same estimate (×1.4) for bookings Upcar's data feed misses, so they compare like for like, but neither is a raw count.

## What it got wrong or could not do

The log keeps the misses too: proposed changes that failed when applied, a raise refused by the spend limit, days where it only researched. That is the point of doing this in public: an agent's bad days tell you more than its good ones.

## Should an AI run *your* Facebook ads?

It depends less on the AI than on the guardrails around it:

1. **Approval first.** Start with the agent proposing changes and you approving them. Widen what it does alone only after you have watched it for a while.
2. **A real spend limit.** The limit should be checked by the software before a budget change goes out, not just written into the AI's instructions.
3. **A written reason for every change,** in words you can check against the ad account.
4. **Your own normal pace** to compare against, so a good season is not mistaken for a good agent.

By default, Zavi asks before it spends. The Upcar test is the exception we chose on purpose, inside a hard $25,000 limit, to show what it does when nobody is steering.`,
  faq: [
    {
      q: "Can AI create Facebook ads, not just manage budgets?",
      a: "Yes. Agents can draft new ad copy and creative to test. Whether a draft goes live on its own or waits for your approval should be your setting, not the agent's choice.",
    },
    {
      q: "Is it safe to let AI spend money on ads?",
      a: "Only with a limit the software enforces and a log of every change. Start with approval on every change, then widen it once you trust what you see.",
    },
    {
      q: "Does the AI replace Meta's own Advantage+ automation?",
      a: "No. Meta's tools optimize inside a campaign. An agent works across campaigns and channels: where budget should go next, what to test, and when to stop something.",
    },
    {
      q: "Where can I see what the agent did each day?",
      a: "On the live page and the day pages linked from it. Each published day lists what it did, why, the budget it moved and that day's results.",
    },
  ],
  sources: [
    { label: "Live scoreboard: Zavi runs Upcar's growth", url: "/live/upcar" },
    { label: "Day 9 log", url: "/live/upcar/day/9" },
    { label: "Day 11 log", url: "/live/upcar/day/11" },
  ],
  cta: {
    label: "Run Zavi on your site",
    href: "/start",
    text: "Same agent, your business. Start with a free growth score; Zavi asks before it spends anything.",
  },
};
