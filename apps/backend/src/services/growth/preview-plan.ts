
import type { ClaimedAgentRun } from "@/services/agents/runner";
import { loadTierGateConfig, planUpgradeErrorBody, resolveTenantTier } from "@/services/agents/entitlement";
import {
  isSignupPreviewIdentity,
  isTierGatedChannel,
  requiredTierFor,
  tierAllows,
  type Tier,
} from "@/services/billing/tiers";
import { getBoolSettingStrictResolved } from "@/services/settings";

export type PlanDeps = {
  loadConfig?: typeof loadTierGateConfig;
  resolveTier?: typeof resolveTenantTier;
};

export async function planIncludesChannel(tenant_id: string, slug: string, deps: PlanDeps = {}): Promise<boolean> {
  try {
    const cfg = await (deps.loadConfig ?? loadTierGateConfig)();
    if (cfg.deferred) return false;
    const tier = await (deps.resolveTier ?? resolveTenantTier)(tenant_id, cfg);
    return tierAllows(tier, slug, cfg.agentMin, cfg.alwaysPro);
  } catch {
    return false;
  }
}

export function isPreviewClaim(claim: Pick<ClaimedAgentRun, "tenant_id" | "agent_slug" | "trigger" | "enqueued_by" | "cron_dedupe_key">): boolean {
  return isSignupPreviewIdentity(claim.tenant_id, claim.agent_slug, {
    trigger: claim.trigger,
    enqueuedByUser: claim.enqueued_by != null,
    payload: null,
    cronDedupeKey: claim.cron_dedupe_key ?? null,
  });
}

export async function isDryPreviewRun(
  claim: Pick<ClaimedAgentRun, "tenant_id" | "agent_slug" | "trigger" | "enqueued_by" | "cron_dedupe_key">,
  deps: PlanDeps = {},
): Promise<boolean> {
  if (!isPreviewClaim(claim)) return false;
  return !(await planIncludesChannel(claim.tenant_id, claim.agent_slug, deps));
}

export type PreviewRunMode = { dry: boolean; keepCards: boolean };

export async function previewRunMode(
  claim: Pick<ClaimedAgentRun, "tenant_id" | "agent_slug" | "trigger" | "enqueued_by" | "cron_dedupe_key">,
  deps: PlanDeps & { realCards?: (tenant_id: string) => Promise<boolean> } = {},
): Promise<PreviewRunMode> {
  if (!(await isDryPreviewRun(claim, deps))) return { dry: false, keepCards: false };
  let keepCards = false;
  try {
    keepCards =
      (await (deps.realCards ?? ((t: string) => getBoolSettingStrictResolved("signup_preview_real_cards", t)))(
        claim.tenant_id,
      )) === true;
  } catch {
    keepCards = false;
  }
  return { dry: true, keepCards };
}

export function asPreviewRunMode(v: unknown): PreviewRunMode {
  if (typeof v === "boolean") return { dry: v, keepCards: false };
  const m = (v ?? {}) as Partial<PreviewRunMode>;
  const dry = m.dry === true;
  return { dry, keepCards: dry && m.keepCards === true };
}

export async function channelPlanLock(
  tenant_id: string,
  slug: string,
  deps: PlanDeps = {},
): Promise<{ slug: string; required_tier: Tier } | null> {
  try {
    const cfg = await (deps.loadConfig ?? loadTierGateConfig)();
    if (cfg.deferred) return { slug, required_tier: requiredTierFor(slug) };
    const tier = await (deps.resolveTier ?? resolveTenantTier)(tenant_id, cfg);
    return tierAllows(tier, slug, cfg.agentMin, cfg.alwaysPro)
      ? null
      : { slug, required_tier: requiredTierFor(slug, cfg.agentMin, cfg.alwaysPro) };
  } catch {
    return { slug, required_tier: requiredTierFor(slug) };
  }
}

export async function planLockedChannels(
  tenant_id: string,
  slugs: readonly string[],
  deps: PlanDeps = {},
): Promise<Set<string>> {
  const distinct = [...new Set(slugs)];
  if (distinct.length === 0) return new Set();
  try {
    const cfg = await (deps.loadConfig ?? loadTierGateConfig)();
    if (cfg.deferred) return new Set(distinct);
    const tier = await (deps.resolveTier ?? resolveTenantTier)(tenant_id, cfg);
    return new Set(distinct.filter((slug) => !tierAllows(tier, slug, cfg.agentMin, cfg.alwaysPro)));
  } catch {
    return new Set(distinct);
  }
}

export type ChannelPlanRefusal = {
  required_tier: Tier;
  message: string;
  body: ReturnType<typeof planUpgradeErrorBody>;
};

export async function refuseIfChannelPlanLocked(
  tenant_id: string,
  channelSlug: string,
  deps: PlanDeps & { strict?: boolean } = {},
): Promise<ChannelPlanRefusal | null> {
  if (!isTierGatedChannel(channelSlug)) return null;
  let required: Tier | null;
  if (deps.strict === true) {
    const cfg = await (deps.loadConfig ?? loadTierGateConfig)();
    if (cfg.deferred) throw new Error("tier config unreadable");
    const tier = await (deps.resolveTier ?? resolveTenantTier)(tenant_id, cfg);
    required = tierAllows(tier, channelSlug, cfg.agentMin, cfg.alwaysPro)
      ? null
      : requiredTierFor(channelSlug, cfg.agentMin, cfg.alwaysPro);
  } else {
    required = (await channelPlanLock(tenant_id, channelSlug, deps))?.required_tier ?? null;
  }
  if (!required) return null;
  const body = planUpgradeErrorBody(channelSlug, required);
  return { required_tier: required, message: body.error.message, body };
}

export async function planIncludesChannelStrict(tenant_id: string, slug: string, deps: PlanDeps = {}): Promise<boolean> {
  const cfg = await (deps.loadConfig ?? loadTierGateConfig)();
  if (cfg.deferred) throw new Error("tier config unreadable");
  const tier = await (deps.resolveTier ?? resolveTenantTier)(tenant_id, cfg);
  return tierAllows(tier, slug, cfg.agentMin, cfg.alwaysPro);
}
