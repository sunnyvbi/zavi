
import { CHANNELS } from "../channels/registry";

export const GROWTH_DECISION_CLASSES = {
  exact: ["channel.recipe_step"],
  prefixes: [
    "social.publish",
    "meta_ads.",
    "google_ads.",
    "x_ads.",
    "linkedin_ads.",
    "reddit_ads.",
    "chatgpt_ads.",
    "growth-lead.",
  ],
} as const;

export const GROWTH_CHANNEL_SLUGS: readonly string[] = CHANNELS.map((c) => c.slug);
const CHANNEL_SLUGS = new Set<string>(GROWTH_CHANNEL_SLUGS);

export function isGrowthClass(decision_class: string | null | undefined): boolean {
  if (typeof decision_class !== "string" || decision_class.length === 0) return false;
  return (
    (GROWTH_DECISION_CLASSES.exact as readonly string[]).includes(decision_class) ||
    GROWTH_DECISION_CLASSES.prefixes.some((p) => decision_class.startsWith(p))
  );
}

export function isGrowthChannelSlug(slug: string | null | undefined): boolean {
  return typeof slug === "string" && CHANNEL_SLUGS.has(slug);
}

export type DecisionHomeKind = "channel" | "growth" | "needs_you";
export const DECISION_HOME_KINDS: readonly DecisionHomeKind[] = ["channel", "growth", "needs_you"];

export type DecisionHome = { kind: "channel"; slug: string } | { kind: "growth" } | { kind: "needs_you" };

export function decisionHome(d: { decision_class: string; channel_slug?: string | null }): DecisionHome {
  if (isGrowthChannelSlug(d.channel_slug)) return { kind: "channel", slug: d.channel_slug as string };
  return isGrowthClass(d.decision_class) ? { kind: "growth" } : { kind: "needs_you" };
}

export function decisionHomeFromStamp(d: {
  decision_class: string;
  home?: string | null;
  home_channel?: string | null;
}): DecisionHome {
  if (d.home === "channel" && isGrowthChannelSlug(d.home_channel)) {
    return { kind: "channel", slug: d.home_channel as string };
  }
  if (d.home === "growth") return { kind: "growth" };
  if (d.home === "needs_you") return { kind: "needs_you" };
  return decisionHome({ decision_class: d.decision_class, channel_slug: d.home_channel ?? null });
}
