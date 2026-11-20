
import { serviceClient } from "@/services/supabase";
import { getChannel } from "@zavi/shared";
import { FREE_EVERY_PLAN_SENTENCE } from "@/services/billing/plan-summary";
import {
  PLAN_UPGRADE_REQUIRED,
  TIERS,
  TIER_DISPLAY_NAME,
  TIER_PRICE_USD,
  isBuildStageAgent,
  isCustomAgentSlug,
  isProPageAgent,
  isDoneForYouRun,
  isSignupPreviewIdentity,
  isTier,
  isTierGatedChannel,
  requiredTierFor,
  requiredTierForRun,
  tierAgentMinFromBlob,
  tierAlwaysProFromBlob,
  tierAllows,
  tierGateEnforcedFromBlob,
  tierInviteEmailsPerDayFromBlob,
  tierRank,
  tierProTenantsFromBlob,
  type RunFacts,
  type Tier,
} from "@/services/billing/tiers";

export type Plan = "free" | "solo" | "team" | "full" | "enterprise";
export type SubStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "incomplete";

export const BILLABLE_BUILD_AGENT_SLUGS: ReadonlySet<string> = new Set(["engineer"]);

export function isBillableBuild(slug: string): boolean {
  return BILLABLE_BUILD_AGENT_SLUGS.has(slug);
}

export const PLAN_BUILD_ALLOWANCE: Record<Plan, number> = {
  free: 5,
  solo: 50,
  team: 250,
  full: 1000,
  enterprise: 1_000_000,
};

export function buildAllowanceFor(plan: Plan): number {
  return PLAN_BUILD_ALLOWANCE[plan] ?? PLAN_BUILD_ALLOWANCE.free;
}

export type TierGateConfig = {
  enforced: boolean;
  agentMin: Record<string, Tier>;
  proTenants: string[];
  alwaysPro?: string[];
  deferred?: boolean;
};

function gateApplies(cfg: TierGateConfig, slug: string, buildStage = false): boolean {
  const buildExempt = buildStage && isBuildStageAgent(slug);
  if (cfg.enforced) return true;
  if (cfg.deferred) return false;
  return isTierGatedChannel(slug) || (isProPageAgent(slug, cfg.alwaysPro) && !buildExempt);
}

export async function loadTierGateConfig(): Promise<TierGateConfig> {
  let blob: Record<string, unknown> | null;
  try {
    blob = await readSystemConfigBlob();
  } catch (e) {
    console.warn(`[tier-gate] system_config read failed, deferring to the DB gate: ${(e as Error).message}`);
    chatOnFree = null;
    return {
      enforced: false,
      agentMin: tierAgentMinFromBlob(null),
      proTenants: [],
      alwaysPro: tierAlwaysProFromBlob(null),
      deferred: true,
    };
  }
  const agentMin = tierAgentMinFromBlob(blob);
  const alwaysPro = tierAlwaysProFromBlob(blob);
  notePlanWallMap(agentMin, alwaysPro);
  return {
    enforced: tierGateEnforcedFromBlob(blob),
    agentMin,
    proTenants: tierProTenantsFromBlob(blob),
    alwaysPro,
  };
}

export async function readSystemConfigBlob(): Promise<Record<string, unknown> | null> {
  const { data, error } = await serviceClient()
    .from("system_config")
    .select("blob")
    .eq("id", 1)
    .maybeSingle<{ blob: Record<string, unknown> | null }>();
  if (error) throw new Error(error.message);
  return data?.blob ?? null;
}

const CHAT_ON_FREE_TTL_MS = 10 * 60 * 1000;
let chatOnFree: { onFree: boolean; at: number } | null = null;

export function everyPlanSentence(): string {
  return chatOnFree && chatOnFree.onFree && Date.now() - chatOnFree.at < CHAT_ON_FREE_TTL_MS
    ? FREE_EVERY_PLAN_SENTENCE
    : "";
}

export function notePlanWallMap(
  agentMin: Readonly<Record<string, Tier>>,
  alwaysPro: readonly string[],
): void {
  chatOnFree = { onFree: requiredTierFor("operator", agentMin, alwaysPro) === "free", at: Date.now() };
}

export async function refreshPlanWallFacts(): Promise<void> {
  await loadTierGateConfig().catch(() => undefined);
}

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["active", "trialing", "past_due"]);

export async function resolveTenantTier(
  tenant_id: string,
  cfg: Pick<TierGateConfig, "proTenants">,
): Promise<Tier> {
  if (!tenant_id) throw new Error("resolveTenantTier: tenant_id required");
  if (cfg.proTenants.includes(tenant_id)) return "pro";
  const { data, error } = await serviceClient()
    .from("tenant_subscriptions")
    .select("tier, status, comp_expires_at")
    .eq("tenant_id", tenant_id)
    .maybeSingle<{ tier: string | null; status: string | null; comp_expires_at: string | null }>();
  if (error) {
    throw new Error(`tier gate: subscription read failed: ${error.message}`);
  }
  return tierFromSubscription(data);
}

export type InviteEmailCap = { tier: Tier; cap: number; higherPlanAllowsMore: boolean };

export async function resolveInviteEmailCap(tenant_id: string): Promise<InviteEmailCap> {
  const { data, error } = await serviceClient()
    .from("system_config")
    .select("blob")
    .eq("id", 1)
    .maybeSingle<{ blob: Record<string, unknown> | null }>();
  if (error) {
    console.warn(`[invite-email-cap] system_config read failed, no invitee email: ${error.message}`);
    throw new Error(`invite email cap: system_config read failed: ${error.message}`);
  }
  const blob = data?.blob ?? null;
  const caps = tierInviteEmailsPerDayFromBlob(blob);
  const of = (tier: Tier, cap: number): InviteEmailCap => ({
    tier,
    cap,
    higherPlanAllowsMore: TIERS.some((t) => tierRank(t) > tierRank(tier) && caps[t] > cap),
  });
  try {
    const tier = await resolveTenantTier(tenant_id, { proTenants: tierProTenantsFromBlob(blob) });
    return of(tier, caps[tier]);
  } catch {
    return { tier: "free", cap: Math.min(...Object.values(caps)), higherPlanAllowsMore: false };
  }
}

export function tierFromSubscription(
  row: { tier: string | null; status: string | null; comp_expires_at: string | null } | null,
): Tier {
  if (!row || !isTier(row.tier)) return "free";
  if (row.comp_expires_at) {
    return new Date(row.comp_expires_at).getTime() > Date.now() ? row.tier : "free";
  }
  if (!ACTIVE_STATUSES.has(row.status ?? "")) return "free";
  return row.tier;
}

export type TierDecision = {
  enforced: boolean;
  tier: Tier;
  required_tier: Tier;
  allowed: boolean;
  unverified?: boolean;
};

export type TierGateOpts = {
  buildStage?: boolean;
  engineerBackendRun?: boolean;
  run?: RunFacts;
};

export function createTierGate(): {
  decide: (tenant_id: string, slug: string, opts?: TierGateOpts) => Promise<TierDecision>;
} {
  let cfgP: Promise<TierGateConfig> | null = null;
  const tiers = new Map<string, Promise<Tier>>();
  return {
    async decide(tenant_id, slug, opts) {
      if (opts?.engineerBackendRun && isBuildStageAgent(slug)) {
        return { enforced: false, tier: "free", required_tier: "free", allowed: true };
      }
      cfgP ??= loadTierGateConfig();
      const cfg = await cfgP;
      if (isCustomAgentSlug(slug)) {
        const { customAgentTierDecision } = await import("./custom-agents");
        const { required_tier } = await customAgentTierDecision(
          tenant_id,
          slug,
          { runId: opts?.run?.runId ?? null, cronDedupeKey: opts?.run?.cronDedupeKey ?? null },
          cfg.agentMin,
          cfg.alwaysPro,
        );
        let tierP = tiers.get(tenant_id);
        if (!tierP) {
          tierP = resolveTenantTier(tenant_id, cfg);
          tiers.set(tenant_id, tierP);
        }
        const tier = await tierP;
        return { enforced: true, tier, required_tier, allowed: tierRank(tier) >= tierRank(required_tier) };
      }
      const required_tier = requiredTierForRun(slug, cfg.agentMin, opts?.buildStage, cfg.alwaysPro);
      if (isSignupPreviewIdentity(tenant_id, slug, opts?.run)) {
        return { enforced: false, tier: "free", required_tier, allowed: true };
      }
      if (isDoneForYouRun(tenant_id, slug, opts?.run, cfg.agentMin, cfg.alwaysPro)) {
        return { enforced: false, tier: "free", required_tier, allowed: true };
      }
      if (!gateApplies(cfg, slug, opts?.buildStage)) {
        const unverified = cfg.deferred === true && (required_tier !== "free" || gateApplies({ ...cfg, deferred: false }, slug, opts?.buildStage));
        return { enforced: false, tier: "free", required_tier, allowed: true, ...(unverified ? { unverified: true } : {}) };
      }
      let tierP = tiers.get(tenant_id);
      if (!tierP) {
        tierP = resolveTenantTier(tenant_id, cfg);
        tiers.set(tenant_id, tierP);
      }
      const tier = await tierP;
      return { enforced: true, tier, required_tier, allowed: tierRank(tier) >= tierRank(required_tier) };
    },
  };
}

export async function checkAgentTier(tenant_id: string, slug: string, opts?: TierGateOpts): Promise<TierDecision> {
  return createTierGate().decide(tenant_id, slug, opts);
}

export async function isLiveBuildStage(tenant_id: string, conductor_run_id: string | null): Promise<boolean> {
  if (!tenant_id || !conductor_run_id) return false;
  try {
    const { data, error } = await serviceClient()
      .from("conductor_runs")
      .select("id")
      .eq("id", conductor_run_id)
      .eq("tenant_id", tenant_id)
      .eq("kind", "build_app")
      .in("status", ["provisioning", "active"])
      .maybeSingle<{ id: string }>();
    return !error && !!data;
  } catch {
    return false;
  }
}

export function agentDisplayName(slug: string): string {
  const ch = getChannel(slug);
  if (ch?.name) return ch.name;
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function planUpgradeMessage(slug: string, required_tier: Tier): string {
  const name = TIER_DISPLAY_NAME[required_tier];
  const price = required_tier === "free" ? null : TIER_PRICE_USD[required_tier];
  return price === null
    ? `${agentDisplayName(slug)} needs the ${name} plan.`
    : `${agentDisplayName(slug)} needs the ${name} plan ($${price}/mo).`;
}

export function planWallMessage(slug: string, required_tier: Tier): string {
  const every = everyPlanSentence();
  return every ? `${planUpgradeMessage(slug, required_tier)} ${every}` : planUpgradeMessage(slug, required_tier);
}

export function planUpgradeErrorBody(slug: string, required_tier: Tier): {
  error: { code: typeof PLAN_UPGRADE_REQUIRED; required_tier: Tier; message: string };
} {
  return {
    error: {
      code: PLAN_UPGRADE_REQUIRED,
      required_tier,
      message: planWallMessage(slug, required_tier),
    },
  };
}

export function requiredTierFromDbError(
  err: { details?: string | null } | null | undefined,
): Tier {
  const d = (err?.details ?? "").trim();
  return isTier(d) ? d : "pro";
}

export async function tenantPlanForDisplay(tenant_id: string): Promise<Tier | null> {
  try {
    const cfg = await loadTierGateConfig();
    if (cfg.deferred) return null;
    return await resolveTenantTier(tenant_id, cfg);
  } catch {
    return null;
  }
}

export async function annotateLockedTier<T extends { slug: string }>(
  agents: T[],
  tenant_id: string,
  onReadError?: () => void,
): Promise<Array<T & { locked_tier: Tier | null }>> {
  let lockFor: (slug: string) => Tier | null = () => null;
  try {
    const cfg = await loadTierGateConfig();
    if (cfg.deferred) onReadError?.();
    if (agents.some((a) => gateApplies(cfg, a.slug))) {
      const tier = await resolveTenantTier(tenant_id, cfg);
      lockFor = (slug) =>
        !gateApplies(cfg, slug) || tierAllows(tier, slug, cfg.agentMin, cfg.alwaysPro)
          ? null
          : requiredTierFor(slug, cfg.agentMin, cfg.alwaysPro);
    }
  } catch {
    lockFor = () => null;
    onReadError?.();
  }
  return agents.map((a) => ({ ...a, locked_tier: lockFor(a.slug) }));
}

export async function filterPlanEntitledAgents<T extends { slug: string }>(
  agents: T[],
  tenant_id: string,
): Promise<T[]> {
  const cfg = await loadTierGateConfig();
  if (!agents.some((a) => gateApplies(cfg, a.slug))) return agents;
  const tier = await resolveTenantTier(tenant_id, cfg);
  return agents.filter(
    (a) => !gateApplies(cfg, a.slug) || tierAllows(tier, a.slug, cfg.agentMin, cfg.alwaysPro),
  );
}
