import { CHANNELS, adConstraint, smallestAcceptedDailyUsd, type AdChannelConstraint } from "@zavi/shared";

const floor2 = (n: number) => Math.floor(Number((n * 100).toFixed(6))) / 100;
const ceil2 = (n: number) => Math.ceil(Number((n * 100).toFixed(6))) / 100;
const DAY = 86_400_000;
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

export type AdPlan = {
  channel_slug: string;
  budget_type: "daily" | "lifetime";
  total_usd: number;
  daily_usd: number | null;
  start: string;
  end: string;
  days: number;
  switched_from: string | null;
};
export const lastDay = (p: AdPlan) => addDays(p.end, -1);
export type AdPlanShape = { kind: "plan"; plan: AdPlan } | { kind: "none"; add_usd: number; channel_slug: string | null };
export type AdPlanInput = {
  want_usd: number;
  preferred: string;
  connected: readonly string[];
  left_usd: number;
  days_left: number;
  margin: number;
  today: string;
  exclude?: readonly string[];
};

export function holdOf(p: AdPlan, days_left: number, margin: number): number {
  const c = adConstraint(p.channel_slug)!;
  if (p.budget_type === "lifetime") return ceil2(p.total_usd * margin);
  if (c.end_date) return ceil2(ceil2(p.daily_usd! * c.hold_factor) * Math.min(days_left, planBudgetDays(p.days)) * margin);
  const sqlFactor = c.platform === "chatgpt" || c.platform === "x" ? 2 : 1;
  return ceil2(ceil2(p.daily_usd! * sqlFactor) * days_left * margin);
}

const floorFor = (c: AdChannelConstraint, preferred: string) =>
  c.channel_slug === preferred ? c.min_campaign_total_usd : c.switch_min_total_usd ?? c.min_campaign_total_usd;

function fit(c: AdChannelConstraint, i: AdPlanInput): Omit<AdPlan, "switched_from"> | null {
  const amount = floor2(Math.min(i.want_usd, i.left_usd / i.margin));
  const min = smallestAcceptedDailyUsd(c);
  const floor = floorFor(c, i.preferred);
  if (!(amount >= min) || (floor != null && amount < floor)) return null;
  if (c.lifetime) {
    const days = Math.min(i.days_left, Math.max(1, Math.floor(amount / min)));
    return { channel_slug: c.channel_slug, budget_type: "lifetime", total_usd: amount, daily_usd: null, start: i.today, end: addDays(i.today, days), days };
  }
  const perDayHeld = (d: number) => ceil2(d * c.hold_factor) * i.margin;
  if (c.end_date) {
    const bd = planBudgetDays(i.days_left);
    const spread = floor2(Math.min(amount / bd, i.left_usd / (bd * i.margin * c.hold_factor)));
    if (spread >= min && perDayHeld(spread) * bd <= i.left_usd + 1e-9 && (c.min_campaign_total_usd == null || spread * i.days_left >= c.min_campaign_total_usd))
      return { channel_slug: c.channel_slug, budget_type: "daily", total_usd: floor2(spread * bd), daily_usd: spread, start: i.today, end: addDays(i.today, i.days_left), days: i.days_left };
    const days = Math.min(i.days_left, Math.floor(Math.min(amount / min, i.left_usd / perDayHeld(min))) - 1);
    if (days < 1 || (c.min_campaign_total_usd != null && min * days < c.min_campaign_total_usd)) return null;
    return { channel_slug: c.channel_slug, budget_type: "daily", total_usd: floor2(min * planBudgetDays(days)), daily_usd: min, start: i.today, end: addDays(i.today, days), days };
  }
  const sqlFactor = c.platform === "chatgpt" || c.platform === "x" ? 2 : 1;
  const daily = floor2(Math.min(amount / i.days_left, i.left_usd / (i.days_left * i.margin * sqlFactor)));
  if (daily < min) return null;
  return { channel_slug: c.channel_slug, budget_type: "daily", total_usd: floor2(daily * i.days_left), daily_usd: daily, start: i.today, end: addDays(i.today, i.days_left), days: i.days_left };
}

const needUsd = (c: AdChannelConstraint, preferred: string) => Math.max(smallestAcceptedDailyUsd(c), floorFor(c, preferred) ?? 0);

export function shapeAdPlan(i: AdPlanInput): AdPlanShape {
  if (!(i.days_left >= 1) || !(i.margin > 0)) return { kind: "none", add_usd: 0, channel_slug: null };
  const usable = i.connected.filter((s) => !i.exclude?.includes(s) && adConstraint(s));
  const order = usable.includes(i.preferred) ? [i.preferred, ...usable.filter((s) => s !== i.preferred)] : usable;
  for (const slug of order) {
    const p = fit(adConstraint(slug)!, i);
    if (p) return { kind: "plan", plan: { ...p, switched_from: slug === i.preferred ? null : i.preferred } };
  }
  const have = floor2(Math.min(i.want_usd, i.left_usd));
  let best: { add_usd: number; channel_slug: string } | null = null;
  for (const slug of usable) {
    const add = Math.max(1, Math.ceil(needUsd(adConstraint(slug)!, i.preferred) - have));
    if (!best || add < best.add_usd) best = { add_usd: add, channel_slug: slug };
  }
  return { kind: "none", add_usd: best?.add_usd ?? 0, channel_slug: best?.channel_slug ?? null };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const channelName = (slug: string) => (CHANNELS.find((c) => c.slug === slug)?.name ?? slug).replace(/ Ads$/, "");
export const shortDay = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
export const usd = (n: number) => `$${n.toFixed(2)}`;
export const rollingEndMs = (p: Pick<AdPlan, "days">, startMs: number) => startMs + p.days * DAY;
export const budgetDaysTouched = (start_s: number, end_s: number) => Math.max(0, Math.ceil(end_s / 86_400) - Math.floor(start_s / 86_400));
export const budgetEndsOn = (end_s: number) => new Date(Math.ceil(end_s / 86_400) * DAY).toISOString().slice(0, 10);
export const dailyBudgetDays = (start_s: number, end_s: number) => budgetDaysTouched(start_s, end_s) + 1;
export const planBudgetDays = (days: number) => days + 1;
export const dailyHoldEndsOn = (end: number | string) => addDays(typeof end === "number" ? budgetEndsOn(end) : end, 1);
export const flightEndMs = (p: Pick<AdPlan, "days" | "budget_type" | "end">, startMs: number) =>
  p.budget_type === "lifetime" ? rollingEndMs(p, startMs) : Date.parse(`${p.end}T00:00:00Z`);
export const utcStamp = (ms: number) => {
  const d = new Date(ms).toISOString();
  return `${shortDay(d.slice(0, 10))} at ${d.slice(11, 16)} UTC`;
};
const when =(p: AdPlan) => (p.days === 1 ? `on ${shortDay(p.start)}` : `from ${shortDay(p.start)} to ${shortDay(lastDay(p))}`);

export function adPlanAsk(p: AdPlan): string {
  return p.budget_type === "lifetime"
    ? `Should I spend ${usd(p.total_usd)} on ${channelName(p.channel_slug)} ads ${when(p)}? It is one total for the whole test, so it can never spend more.`
    : `Should I spend up to ${usd(p.total_usd)} on ${channelName(p.channel_slug)} ads (${usd(p.daily_usd!)} a day) ${when(p)}?`;
}
export function adPlanBoundaries(p: AdPlan): string {
  return p.budget_type === "lifetime"
    ? `Approved: one ${channelName(p.channel_slug)} campaign with a LIFETIME budget of exactly ${usd(p.total_usd)}, start ${p.start}, end ${p.end} (UTC). Never a daily budget, never more, never longer.`
    : `Approved: daily budget ${usd(p.daily_usd!)} on ${channelName(p.channel_slug)}, start ${p.start}, END ${p.end} (UTC, set the end date). Never more, never longer.`;
}
export function noFitNote(r: Extract<AdPlanShape, { kind: "none" }>): string {
  return r.channel_slug ? `Add $${r.add_usd} or wait for next month to run an ad test.` : "Connect an ad channel to run an ad test.";
}
