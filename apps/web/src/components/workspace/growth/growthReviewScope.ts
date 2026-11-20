
import { GROWTH_DECISION_CLASSES, isGrowthChannelSlug, isGrowthClass } from "@zavi/shared";

export { GROWTH_DECISION_CLASSES };

export function isGrowthDecision(d: { decision_class: string; channel_slug?: string | null }): boolean {
  return isGrowthClass(d.decision_class ?? "") || isGrowthChannelSlug(d.channel_slug);
}
