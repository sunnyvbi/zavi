
import { DENTAL_SPEC, specFromSheetV2, type SheetV2 } from "./causal";
import coffeeSheet from "./sheets/coffee-subscription.json";
import fitnessSheet from "./sheets/fitness-studio.json";
import invoicingSheet from "./sheets/freelancer-invoicing.json";
import type { RunLog, Scenario } from "./types";

const always = { seen: 1, approve: 1, reject: 0 };

const reached = (target: number) => (log: RunLog) => {
  const last = log.days.at(-1)?.day ?? 0;
  return log.final.tiles.filter((t) => t.day <= last).reduce((a, t) => a + t.outcome, 0) >= target;
};

export const CAUSAL_DENTAL: Scenario = {
  id: "c1-dental-booking",
  business: "Local dental clinic",
  outcomeLabel: "bookings",
  goal: { objective: "60 new-patient bookings this month", target: 60, dueDays: 30, baseline: 0 },
  channels: [
    { slug: "seo", addedBy: "plan", cardsPerDay: 2 / 7, visitsPerApproved: 150 },
    { slug: "instagram_organic", addedBy: "plan", cardsPerDay: 1 / 7, visitsPerApproved: 100 },
    { slug: "x_organic", addedBy: "plan", cardsPerDay: 1 / 14, visitsPerApproved: 20 },
  ],
  founder: { policy: { seo: always, instagram_organic: always, x_organic: always }, answers: {} },
  world: { baseVisitsPerDay: 30, conversion: DENTAL_SPEC.conversion.current },
  autopilot: true,
  days: 30,
  causal: DENTAL_SPEC,
  pass: { dueDay: 30, describe: "by day 30: the goal's bookings reached", check: reached(60) },
};

const CHANNEL_ALIASES: Record<string, string> = { email_newsletter: "email_marketing" };
const zaviSlug = (slug: string) => CHANNEL_ALIASES[slug] ?? slug;

export function scenarioFromSheet(id: string, business: string, file: SheetV2): Scenario {
  const raw = specFromSheetV2(file);
  const spec = raw.decoyLever.kind === "channel" ? { ...raw, decoyLever: { ...raw.decoyLever, channel: zaviSlug(raw.decoyLever.channel) } } : raw;
  const b = { ...file.sheet.business, channels: file.sheet.business.channels.map((c) => ({ ...c, slug: zaviSlug(c.slug) })) };
  const label = b.outcome_label.replace(/_/g, " ");
  return {
    id,
    business,
    outcomeLabel: label,
    goal: { objective: `${b.goal_target} ${label} this month`, target: b.goal_target, dueDays: 30, baseline: 0 },
    channels: b.channels.map((c) => ({ slug: c.slug, addedBy: "plan" as const, cardsPerDay: c.cards_per_week / 7, visitsPerApproved: c.visits_per_post })),
    founder: { policy: Object.fromEntries(b.channels.map((c) => [c.slug, always])), answers: {} },
    world: { baseVisitsPerDay: spec.visits.current, conversion: spec.conversion.current },
    autopilot: true,
    days: 30,
    causal: spec,
    ...(file.holdout ? { holdout: true } : {}),
    pass: { dueDay: 30, describe: `by day 30: ${b.goal_target} ${label}`, check: reached(b.goal_target) },
  };
}

export const CAUSAL_INVOICING = scenarioFromSheet("c2-freelancer-invoicing", "Invoicing and time-tracking software for freelancers", invoicingSheet as SheetV2);
export const CAUSAL_COFFEE = scenarioFromSheet("c3-coffee-subscription", "Online specialty coffee subscription store", coffeeSheet as SheetV2);
export const HOLDOUT_FITNESS = scenarioFromSheet("h1-fitness-studio", "Local fitness studio with group classes", fitnessSheet as SheetV2);

export const CAUSAL_SCENARIOS: Scenario[] = [CAUSAL_DENTAL, CAUSAL_INVOICING, CAUSAL_COFFEE, HOLDOUT_FITNESS];
