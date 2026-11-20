
import { getChannel, isChannelSlug } from "@zavi/shared";
import {
  DEFAULT_TIER_AGENT_MIN,
  DEFAULT_TIER_ALWAYS_PRO,
  requiredTierFor,
  type Tier,
} from "@/services/billing/tiers";

const FEATURE_LABELS: Readonly<Record<string, string>> = {
  cgo: "Growth plan",
  research: "Research reports",
  "product-builder": "Build (websites and apps)",
  "content-design": "Content design",
  "performance-marketer": "Performance marketer",
  engineer: "Engineer page",
  fundraising: "Fundraising page",
  "supply-demand-balancer": "Supply & Demand page",
};

export const POST_CREATIVE_CHANNELS: ReadonlySet<string> = new Set([
  "instagram_organic",
  "linkedin_organic",
  "x_organic",
  "pinterest_organic",
]);

function featureLabel(slug: string): string | null {
  if (isChannelSlug(slug)) return getChannel(slug)?.name ?? null;
  return FEATURE_LABELS[slug] ?? null;
}

export function featuresAt(
  tier: Tier,
  agentMin: Readonly<Record<string, Tier>>,
  alwaysPro: readonly string[],
  locked: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const slug of new Set([...Object.keys(agentMin), ...alwaysPro])) {
    if (requiredTierFor(slug, agentMin, alwaysPro) !== tier) continue;
    const label = featureLabel(slug);
    if (!label) continue;
    out.push(locked.has(slug) ? `${label} (coming soon)` : label);
  }
  return out;
}

export const FREE_EVERY_PLAN_SENTENCE =
  "Every plan, Free included, can chat with Zavi about your business, research your market, and make post images, reports and decks right in the chat.";

export function freePlanSummary(
  agentMin: Readonly<Record<string, Tier>> = DEFAULT_TIER_AGENT_MIN,
  alwaysPro: readonly string[] = DEFAULT_TIER_ALWAYS_PRO,
): string {
  const extra = featuresAt("free", agentMin, alwaysPro, new Set());
  const chatOnFree = requiredTierFor("operator", agentMin, alwaysPro) === "free";
  if (!chatOnFree) {
    return extra.length > 0 ? `${extra.join(", ")}.` : "the free daily credits only; every feature needs a paid plan.";
  }
  return extra.length > 0
    ? `${FREE_EVERY_PLAN_SENTENCE.slice(0, -1)}, plus ${extra.join(", ")}.`
    : FREE_EVERY_PLAN_SENTENCE;
}
