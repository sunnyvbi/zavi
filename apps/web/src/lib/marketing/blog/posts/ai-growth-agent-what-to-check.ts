import type { BlogPost } from "../types";

export const aiGrowthAgentChecklist: BlogPost = {
  slug: "ai-growth-agent-what-to-check",
  query: "ai growth agent",
  title: "AI growth agent: 5 things to check before you pay for one",
  description:
    "An AI growth agent can save a small team real hours, or quietly spend your money. Five questions separate the two, and what an honest vendor should be able to show you for each.",
  h1: "AI growth agent: 5 things to check before you pay for one",
  datePublished: "2026-10-12",
  dateModified: "2026-10-12",
  reviewedAt: "2026-10-12",
  answer:
    "Before you pay for an AI growth agent, check five things: what it does without asking you, what stops it spending more than you allow, how it proves its work caused a result, how it undoes a bad change, and one real result it can show you. An agent that cannot answer these clearly should only ever draft, never act.",
  body: `"AI growth agent" covers everything from a chatbot that writes ad copy to software that moves real budget on your ad accounts. The label does not tell you which one you are buying. These five questions do. We build one, Zavi, so weigh our view accordingly; we answer each question for ourselves at the end, including where we fall short.

## 1. What does it do without asking you?

Ask for the exact list of actions it can take on its own: publish a post, send an email, change an ad budget, edit your website. "It is fully autonomous" is not an answer. The safe default for a new tool is that it **proposes** and you approve, and that you can widen what it may do by itself, one kind of action at a time, inside limits you set.

## 2. What stops it from spending more than you allow?

If the agent touches paid ads, find out where the spending limit lives. A limit that is just an instruction to the AI ("please don't spend more than X") can be misread. A limit the software checks before any budget change goes out is much safer. Ask to see what happens when it tries to go over: a good answer is a logged refusal, not an apology afterwards.

## 3. How does it prove its work caused the result?

Sales went up the week the agent started. Did the agent do that, or was it the season, a sale, or a mention somewhere? Ask how it separates its effect from everything else: a comparison against your normal pace, a holdout, tracking that ties a signup to a campaign. "Revenue is up" without that is a coincidence with a dashboard.

## 4. How does it undo a bad change?

Every agent will get something wrong. What matters is how fast it notices and what it does then. Ask what it watches after a change, how it reverses one, and whether reversing is automatic or needs you.

## 5. Can it show you one real result?

Ask for one measured result on a real business you can look at, with the dates and the numbers. Screenshots of a demo account do not count.

## Our own answers, honestly

- **Without asking:** by default Zavi asks before it publishes or spends. You can let it act on its own inside limits you set, such as an ads spend limit; anything outside those limits still waits for you.
- **Spending:** on Meta and Google ads, the spend limit is checked before a budget change goes out. In our public test on Upcar, Zavi's own log shows it trying to raise a budget on day 9 and being refused because the month's limit did not have room ([day 9](/live/upcar/day/9)).
- **Proof:** our public test compares Upcar's results with its normal pace from the four weeks before. That is a comparison, not a controlled experiment, and we say so.
- **Undo and full autonomy:** we do not yet meet our own bar on all five of these checks for running a channel completely on its own. That is the work in front of us, not something we claim today.
- **A real result:** Zavi is running growth for Upcar, a real car-rental marketplace, in public: [zaviagent.com/live/upcar](/live/upcar). Zavi's daily log, its budget moves and the day-by-day results are on the page, wins and flops included.`,
  faq: [
    {
      q: "What is an AI growth agent?",
      a: "Software that looks at your business, works out what is holding growth back, and does the growth work: ads, content, email, site fixes. The good ones ask before acting by default and report what changed.",
    },
    {
      q: "Is an AI growth agent worth it for a small business?",
      a: "It can be when you have no one to do the everyday growth work. Start free, let it propose rather than act, and judge it on one measured result in your own business.",
    },
    {
      q: "Can an AI growth agent run my ads by itself?",
      a: "Some can, inside limits. Check that a spend limit is enforced by the software, not just written into the AI's instructions, and that every change is logged where you can see it.",
    },
    {
      q: "Does an AI growth agent replace a marketing hire?",
      a: "It can take over a lot of the everyday execution. It does not replace brand judgment or the relationships a person brings, and you should still decide what it is allowed to do.",
    },
  ],
  sources: [
    { label: "Zavi runs Upcar's growth in public", url: "/live/upcar" },
    { label: "Day 9: a budget raise refused by the monthly limit", url: "/live/upcar/day/9" },
    { label: "What Zavi is (About)", url: "/about" },
  ],
  cta: {
    label: "Start with a free growth score",
    href: "/start",
    text: "See what Zavi would work on first for your business. Free, no card, and by default it asks before it publishes or spends anything.",
  },
};
