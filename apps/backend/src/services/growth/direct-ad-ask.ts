import { adConstraint, smallestAcceptedDailyUsd } from "@zavi/shared";
import { addDays, channelName, planBudgetDays, usd, type AdPlan } from "./ad-plan-shape";

export type DirectAdAsk = {
  channel_slug: string;
  total_usd: number;
  daily_usd: number | null;
  days: number | null;
};

const CHANNEL_WORDS: Array<[RegExp, string]> = [
  [/\b(chat\s?gpt|openai)\b/, "chatgpt_ads"],
  [/\b(meta|facebook|instagram|fb|ig)\b/, "meta_ads"],
  [/\btik\s?tok\b/, "tiktok_ads"],
  [/\byoutube\b/, "youtube_ads"],
  [/\bgoogle\b/, "google_ads"],
  [/\breddit\b/, "reddit_ads"],
  [/\blinked\s?in\b/, "linkedin_ads"],
  [/\b(twitter|x ads?|on x)\b/, "x_ads"],
];
const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fourteen: 14, thirty: 30 };
const money = (s: string) => Math.round(Number(s.replace(/,/g, "")) * 100) / 100;

export function parseDirectAdAsk(text: unknown, opts: { adWordOptional?: boolean } = {}): DirectAdAsk | null {
  if (typeof text !== "string" || text.length > 2000) return null;
  const t = text.toLowerCase();
  if (!/\b(run|launch|start|spend|put|try|test|set)\b/.test(t)) return null;
  if (t.includes("?")) return null;
  if (/\b(don'?t|do not|never|stop|pause|should|would|could|how|if|maybe|perhaps|thinking|think|idea|ideas|plan|plans|planning|what|whether|consider|considering|suppose|imagine|hypothetical(?:ly)?|example|estimate|cost)\b/.test(t)) return null;
  if ((t.match(/\$\s?\d/g) ?? []).length > 1) return null;
  const channels = [...new Set(CHANNEL_WORDS.filter(([re]) => re.test(t)).map(([, s]) => s))];
  const slugs = channels.includes("youtube_ads") ? channels.filter((c) => c !== "google_ads") : channels;
  if (slugs.length !== 1) return null;
  const daily = /\$\s?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:\/|per|a|each)\s*day\b/.exec(t);
  if (!opts.adWordOptional && !daily && !/\b(ads?|campaign|test)\b/.test(t)) return null;
  const daysM = /\b(?:for|over)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|fourteen|thirty)\s+days?\b/.exec(t);
  const days = daysM ? (NUM_WORDS[daysM[1]] ?? Number(daysM[1])) : null;
  if (daily) {
    const d = money(daily[1]);
    if (!(d > 0) || !days || days < 1 || days > 90) return null;
    return { channel_slug: slugs[0], daily_usd: d, days, total_usd: Math.round(d * days * 100) / 100 };
  }
  const amounts = [...t.matchAll(/\$\s?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/g)].map((m) => money(m[1]));
  if (amounts.length !== 1 || !(amounts[0] > 0)) return null;
  if (days != null && (days < 1 || days > 90)) return null;
  return { channel_slug: slugs[0], total_usd: amounts[0], daily_usd: null, days };
}

export type DirectAskShape =
  | { kind: "plan"; plan: AdPlan; line: string; reshaped: boolean }
  | { kind: "none"; line: string };

const floor2 = (n: number) => Math.floor(Number((n * 100).toFixed(6))) / 100;
const DEFAULT_MAX_DAYS = 7;

export function shapeDirectAsk(ask: DirectAdAsk, today: string): DirectAskShape {
  const c = adConstraint(ask.channel_slug);
  const name = channelName(ask.channel_slug);
  const T = floor2(ask.total_usd);
  if (!c || (!c.lifetime && !c.end_date)) {
    return { kind: "none", line: `I can't cap a ${name} ad at ${usd(T)} from here yet, so I didn't run it. The card is waiting for you to approve it yourself.` };
  }
  const min = smallestAcceptedDailyUsd(c);
  if (c.min_campaign_total_usd != null && T < c.min_campaign_total_usd) {
    return { kind: "none", line: `${name}'s minimum is ${usd(c.min_campaign_total_usd)} for a campaign, so nothing ran. Ask for ${usd(c.min_campaign_total_usd)} or more.` };
  }
  const plan = (p: Omit<AdPlan, "switched_from" | "start" | "end"> & { days: number }): AdPlan => ({
    ...p, start: today, end: addDays(today, p.days), switched_from: null,
  });
  const when = (days: number) => (days === 1 ? "for 1 day" : `for ${days} days`);
  if (c.lifetime) {
    if (T < min && ask.days == null) {
      return { kind: "none", line: `${name}'s minimum is ${usd(min)} a day, so ${usd(T)} can't run on it. Nothing ran.` };
    }
    const days = Math.min(90, ask.days ?? Math.min(DEFAULT_MAX_DAYS, Math.max(1, Math.floor(T / min))));
    return {
      kind: "plan",
      plan: plan({ channel_slug: c.channel_slug, budget_type: "lifetime", total_usd: T, daily_usd: null, days }),
      line: `Running ${usd(T)} on ${name} as one total ${when(days)}. It can never spend more.`,
      reshaped: false,
    };
  }
  const f = c.hold_factor;
  let days = ask.days ?? Math.min(DEFAULT_MAX_DAYS, Math.max(1, Math.floor(T / (f * min)) - 1));
  let daily = floor2(T / (f * planBudgetDays(days)));
  let reshaped = ask.daily_usd != null && daily !== floor2(ask.daily_usd);
  if (daily < min) {
    days = Math.floor(T / (f * min)) - 1;
    daily = days >= 1 ? floor2(T / (f * planBudgetDays(days))) : min;
    reshaped = true;
  }
  if (days < 1 || (c.min_campaign_total_usd != null && daily * days < c.min_campaign_total_usd)) {
    return { kind: "none", line: `${name}'s minimum is ${usd(min)} a day, so ${usd(T)} can't run on it. Nothing ran.` };
  }
  const p = plan({ channel_slug: c.channel_slug, budget_type: "daily", total_usd: T, daily_usd: daily, days });
  const over = f > 1 ? ` ${name} can spend up to ${f}x a daily budget on one day, so the daily is set to keep the whole test at ${usd(T)} or less.` : "";
  return {
    kind: "plan",
    plan: p,
    line: reshaped
      ? `${name}'s minimum is ${usd(min)} a day, so I'm running ${usd(daily)} a day for ${days} day${days === 1 ? "" : "s"}, ${usd(T)} at most.${over}`
      : `Running ${usd(daily)} a day on ${name} ${when(days)}, ${usd(T)} at most.${over}`,
    reshaped,
  };
}

export function directAskFallback(p: AdPlan, statedMinUsd?: number | null): AdPlan | null {
  const c = adConstraint(p.channel_slug);
  if (!c || p.budget_type !== "lifetime") return null;
  const unit = Math.max(smallestAcceptedDailyUsd(c), statedMinUsd ?? 0);
  const days = Math.floor(p.total_usd / unit);
  if (days < 1) return null;
  const total = floor2(Math.min(p.total_usd, unit * days));
  if (total >= p.total_usd) return null;
  return { ...p, total_usd: total, days, end: addDays(p.start, days) };
}
