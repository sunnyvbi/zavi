
import {
  DEFAULT_TIER_AGENT_MIN,
  DEFAULT_TIER_ALWAYS_PRO,
  DEFAULT_TIER_CREDITS,
  TIERS,
  TIER_DISPLAY_NAME,
  TIER_PRICE_USD,
  tierAgentMinFromBlob,
  tierAlwaysProFromBlob,
  tierCreditsFromBlob,
  type PaidTier,
  type Tier,
} from "@/services/billing/tiers";
import { freeDailyCreditsFromBlob } from "@/services/agents/credits";
import { lockedSlugsFromBlob } from "@/services/channels/lock";
import { readSystemConfigBlob, resolveTenantTier } from "@/services/agents/entitlement";
import { featuresAt, freePlanSummary } from "@/services/billing/plan-summary";

export const ZAVI_SUPPORT_EMAIL = "support@zaviagent.com";
export const ZAVI_TUTORIALS_URL = "https://www.zaviagent.com/tutorials";

export type ZaviFactsInput = {
  agentMin: Readonly<Record<string, Tier>>;
  alwaysPro: readonly string[];
  credits: Readonly<Record<PaidTier, number>>;
  freeDailyCredits: number | null;
  lockedChannels: ReadonlySet<string>;
  configRead: boolean;
  tenantTier: Tier | null;
};

export function buildZaviFactsBlock(input: ZaviFactsInput): string {
  const { agentMin, alwaysPro, credits, freeDailyCredits, lockedChannels, configRead, tenantTier } = input;
  const planLines = configRead ? livePlanLines(agentMin, alwaysPro, credits, lockedChannels) : [
    `- ${TIERS.map((t) => (t === "free" ? `${TIER_DISPLAY_NAME[t]} ($0)` : `${TIER_DISPLAY_NAME[t]} ($${TIER_PRICE_USD[t]}/mo)`)).join(", ")}.`,
    "- What each plan includes could not be read just now: send the user to Settings → Billing, which lists it. Do not list plan contents from memory.",
  ];
  const daily =
    freeDailyCredits !== null
      ? `Every plan, Free included, also gets ${freeDailyCredits.toLocaleString("en-US")} free credits a day. They reset at midnight UTC and do not roll over.`
      : "Every plan, Free included, also gets free daily credits. They reset at midnight UTC and do not roll over.";
  return [
    "ZAVI FACTS — about Zavi itself, the product you are part of. When the user asks about Zavi (support, billing, cancelling, plans, tutorials), answer from these; never say you do not know them.",
    "",
    `- Support: email ${ZAVI_SUPPORT_EMAIL}.`,
    "- Cancel a paid plan: Settings → Billing → Cancel plan (owner or admin). They keep the plan and its credits until the end of the billing period, then move to Free and are not charged again. A plan bought in the App Store or Google Play is cancelled there.",
    "- Delete a sign-in account: Settings → Account → Delete account, or https://www.zaviagent.com/account. The user confirms there. Deleting an account does not cancel a workspace's paid plan; cancel a plan in Billing first if stopping its charges. A sole owner with other workspace members must transfer ownership first. For ‘cancel my account’, ask which they mean: stop billing or delete the sign-in.",
    `- Learn Zavi: the 2-minute "How to use Zavi" video is in the account menu at the bottom of the sidebar. Every tutorial video is at ${ZAVI_TUTORIALS_URL}.`,
    "- Upgrade or top up: Settings → Billing.",
    "",
    configRead ? "Plans (each includes everything in the plans above it):" : "Plans:",
    ...planLines,
    daily,
    ...(tenantTier ? ["", `This workspace is on the ${TIER_DISPLAY_NAME[tenantTier]} plan.`] : []),
  ].join("\n");
}

function livePlanLines(
  agentMin: Readonly<Record<string, Tier>>,
  alwaysPro: readonly string[],
  credits: Readonly<Record<PaidTier, number>>,
  lockedChannels: ReadonlySet<string>,
): string[] {
  return TIERS.map((tier) => {
    const name = TIER_DISPLAY_NAME[tier];
    if (tier === "free") return `- ${name} ($0): ${freePlanSummary(agentMin, alwaysPro)}`;
    const head = `${name} ($${TIER_PRICE_USD[tier]}/mo, ${credits[tier].toLocaleString("en-US")} credits a month)`;
    const adds = featuresAt(tier, agentMin, alwaysPro, lockedChannels);
    return adds.length > 0
      ? `- ${head} adds: ${adds.join(", ")}.`
      : `- ${head}: everything in the plan before it, with more credits.`;
  });
}

function defaultFactsInput(): ZaviFactsInput {
  return {
    agentMin: DEFAULT_TIER_AGENT_MIN,
    alwaysPro: DEFAULT_TIER_ALWAYS_PRO,
    credits: DEFAULT_TIER_CREDITS,
    freeDailyCredits: null,
    lockedChannels: new Set(),
    configRead: false,
    tenantTier: null,
  };
}

export async function loadZaviFactsBlock(tenant_id: string): Promise<string> {
  const input = defaultFactsInput();
  const [blobR, tierR] = await Promise.allSettled([
    readSystemConfigBlob(),
    tenant_id ? resolveTenantTier(tenant_id, { proTenants: [] }) : Promise.resolve(null),
  ]);
  if (blobR.status === "fulfilled") {
    const blob = blobR.value;
    input.agentMin = tierAgentMinFromBlob(blob);
    input.alwaysPro = tierAlwaysProFromBlob(blob);
    input.credits = tierCreditsFromBlob(blob);
    input.freeDailyCredits = freeDailyCreditsFromBlob(blob as { free_daily_credits?: unknown } | null);
    input.lockedChannels = new Set(lockedSlugsFromBlob(blob));
    input.configRead = true;
  } else {
    console.warn(`[zavi-facts] system_config read failed, using defaults: ${(blobR.reason as Error).message}`);
  }
  input.tenantTier = tierR.status === "fulfilled" ? tierR.value : null;
  return buildZaviFactsBlock(input);
}
