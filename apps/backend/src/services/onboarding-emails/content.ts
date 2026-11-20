
import { compareActions } from "@zavi/shared";
import type { ResultsContent } from "@/email/templates/onboarding-sequence";
import { cardUrl, destinationUrl, DIGEST_STEP } from "./steps";
import { DEFAULT_TIER_AGENT_MIN, TIER_DISPLAY_NAME, tierRank } from "@/services/billing/tiers";
import { CHANNELS_FOR_STEP, type ResultsStep } from "./plan";
import { channelName, type EmailCard, type WorkspaceFacts } from "./facts";

export const STARTER_LINE = "The drafts are yours to copy and post. On Starter I post for you and keep finding more each week.";
export const APPROVE_LINE = "Nothing posts until you approve it.";

export function upgradeLine(slug: string): string {
  const tier = DEFAULT_TIER_AGENT_MIN[slug] ?? "starter";
  if (tierRank(tier) <= tierRank("starter")) return STARTER_LINE;
  return `The drafts are yours to copy and post. On ${TIER_DISPLAY_NAME[tier]} I post for you and keep finding more each week.`;
}

const steps = (n: number) => (n === 1 ? "step" : "steps");

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function rankedAcross(facts: WorkspaceFacts, slugs: readonly string[] | null): EmailCard[] {
  const lists = slugs ? slugs.map((s) => facts.cards.get(s) ?? []) : [...facts.cards.values()];
  return lists.flat().sort(compareActions);
}

export function channelResults(args: {
  step: ResultsStep;
  facts: WorkspaceFacts;
  workspaceUrl: string;
  planLacks: (slug: string) => boolean;
}): ResultsContent | null {
  const { step, facts, workspaceUrl } = args;
  const cards = rankedAcross(facts, CHANNELS_FOR_STEP[step]);
  if (cards.length === 0) return null;
  const withCards = CHANNELS_FOR_STEP[step].filter((s) => (facts.cards.get(s) ?? []).length > 0);
  const label = joinNames(withCards.map(channelName));
  const n = cards.length;
  const top = cards.slice(0, 2);
  const more = n - top.length;
  const first = top[0];
  return {
    subject: `${n} ${label} ${steps(n)} ${n === 1 ? "is" : "are"} ready for ${facts.company}`,
    headline: `Your ${label} ${steps(n)} ${n === 1 ? "is" : "are"} ready`,
    intro: `I looked at ${facts.company} for ${label}. Here ${n === 1 ? "is what I found" : "is the top of what I found"}.`,
    items: top.map((c) => ({
      ...(withCards.length > 1 ? { prefix: channelName(c.channel_slug) } : {}),
      title: c.title,
      detail: c.reason,
    })),
    moreLines: more > 0 ? [`${more} more ${steps(more)} on the ${label} ${withCards.length > 1 ? "pages" : "page"}`] : [],
    button: "Review the drafts",
    ctaUrl: cardUrl(workspaceUrl, first.channel_slug, first.id, step),
    afterButton: args.planLacks(first.channel_slug) ? upgradeLine(first.channel_slug) : APPROVE_LINE,
  };
}

function countsByChannel(cards: readonly EmailCard[]): string {
  const by = new Map<string, number>();
  for (const c of cards) by.set(c.channel_slug, (by.get(c.channel_slug) ?? 0) + 1);
  return [...by.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([slug, count]) => `${count} ${channelName(slug)}`)
    .join(", ");
}

export function digestResults(args: { facts: WorkspaceFacts; workspaceUrl: string }): ResultsContent | null {
  const { facts, workspaceUrl } = args;
  const cards = rankedAcross(facts, null);
  if (cards.length === 0) return null;
  const n = cards.length;
  const visible = cards.filter((c) => !c.held);
  const top = visible.slice(0, 3);
  const shown = new Set(top.map((c) => c.id));
  const leftover = cards.filter((c) => !shown.has(c.id));
  const restLine = countsByChannel(leftover.filter((c) => !c.held));
  const heldLine = countsByChannel(leftover.filter((c) => c.held));
  const working = [...facts.plan.inFlight].filter((s) => (facts.cards.get(s) ?? []).length === 0).length;
  const moreLines = [
    ...(restLine ? [`Also ready: ${restLine}.`] : []),
    ...(heldLine ? [`Coming next: ${heldLine}. One channel a day.`] : []),
    ...(working > 0 ? [`${working} more ${working === 1 ? "channel is" : "channels are"} still working.`] : []),
  ];
  const step = DIGEST_STEP.step;
  return {
    subject: `Your first results for ${facts.company}: ${n} ${steps(n)} ready`,
    headline: DIGEST_STEP.headline,
    intro: DIGEST_STEP.paragraphs[0] ?? "Here is what I found overnight.",
    items: top.map((c) => ({ prefix: channelName(c.channel_slug), title: c.title, detail: c.reason })),
    moreLines,
    linkLine: {
      before: "Give me your goal in ",
      linkText: "Growth Strategy",
      after: ", and let’s work toward it together.",
      url: destinationUrl("growth_strategy", workspaceUrl, step),
    },
    button: DIGEST_STEP.button,
    ctaUrl: destinationUrl("channels", workspaceUrl, step),
  };
}
