
import { PRICING_CONFIG, isChannelSlug } from "@zavi/shared";

export const TIERS = ["free", "starter", "growth", "pro"] as const;
export type Tier = (typeof TIERS)[number];
export type PaidTier = Exclude<Tier, "free">;
export const PAID_TIERS: readonly PaidTier[] = ["starter", "growth", "pro"];

const paidMap = <T>(f: (t: PaidTier) => T) =>
  Object.fromEntries(PAID_TIERS.map((t) => [t, f(t)])) as Record<PaidTier, T>;

export const TIER_DISPLAY_NAME: Record<Tier, string> = Object.fromEntries(
  TIERS.map((t) => [t, PRICING_CONFIG.tiers[t].name]),
) as Record<Tier, string>;

export const TIER_PRICE_USD: Record<PaidTier, number> = paidMap((t) => PRICING_CONFIG.tiers[t].monthly_usd);

export const DEFAULT_TIER_CREDITS: Record<PaidTier, number> = paidMap((t) => PRICING_CONFIG.tiers[t].monthly_credits);

export const DEFAULT_TIER_INVITE_EMAILS_PER_DAY: Readonly<Record<Tier, number>> = {
  free: 3,
  starter: 10,
  growth: 25,
  pro: 50,
};
export const MAX_INVITE_EMAILS_PER_DAY = 1000;

export const TOPUP_USD_PACKS: readonly number[] = [...PRICING_CONFIG.topup_usd_packs];

export const PLAN_UPGRADE_REQUIRED = "plan_upgrade_required";

export function tierRank(t: Tier): number {
  return TIERS.indexOf(t);
}

export function isTier(v: unknown): v is Tier {
  return typeof v === "string" && (TIERS as readonly string[]).includes(v);
}

export function isPaidTier(v: unknown): v is PaidTier {
  return typeof v === "string" && (PAID_TIERS as readonly string[]).includes(v);
}

export const DEFAULT_TIER_AGENT_MIN: Readonly<Record<string, Tier>> = {
  operator: "free",
  research: "free",
  advisor: "free",
  cgo: "free",
  "growth-lead": "free",
  pm: "free",
  "chief-of-staff": "free",
  "support-lead": "free",
  qa: "free",
  "dispute-response": "free",
  "onboarding-discovery": "free",
  "seo-geo": "free",
  "browser-operator": "starter",
  "content-design": "starter",
  "content-seo": "starter",
  "product-builder": "starter",
  "performance-marketer": "starter",
  generated_video: "starter",
  seo: "starter",
  geo: "starter",
  linkedin_organic: "starter",
  reddit_organic: "starter",
  blog: "starter",
  x_organic: "starter",
  instagram_organic: "starter",
  pinterest_organic: "starter",
  ugc: "growth",
  tiktok_organic: "growth",
  youtube_organic: "growth",
  engineer: "pro",
  fundraising: "pro",
  "supply-demand-balancer": "pro",
  google_ads: "pro",
  meta_ads: "pro",
  tiktok_ads: "pro",
  linkedin_ads: "pro",
  reddit_ads: "pro",
  x_ads: "pro",
  youtube_ads: "pro",
  chatgpt_ads: "pro",
  email_marketing: "pro",
  sms: "pro",
};

export const DEFAULT_TIER_ALWAYS_PRO: readonly string[] = [
  "engineer",
  "fundraising",
  "supply-demand-balancer",
];
export const PRO_PAGE_AGENT_SLUGS: ReadonlySet<string> = new Set(DEFAULT_TIER_ALWAYS_PRO);

export function isProPageAgent(
  slug: string,
  alwaysPro: readonly string[] = DEFAULT_TIER_ALWAYS_PRO,
): boolean {
  return alwaysPro.includes(slug);
}

export function isTierGatedChannel(slug: string): boolean {
  return isChannelSlug(slug);
}

export function isBuildStageAgent(slug: string): boolean {
  return slug === "engineer";
}

export const CUSTOM_AGENT_SLUG_RE = /^c-[a-z0-9]{8,12}$/;

export function isCustomAgentSlug(slug: string | null | undefined): boolean {
  return typeof slug === "string" && CUSTOM_AGENT_SLUG_RE.test(slug);
}

export const CUSTOM_AGENT_BLOCKED_SERVERS: ReadonlySet<string> = new Set(["qa_engineer", "code_index"]);

export function isToolServerBlockedForAgent(slug: string | null | undefined, server_id: string): boolean {
  return isCustomAgentSlug(slug) && CUSTOM_AGENT_BLOCKED_SERVERS.has(server_id);
}

export const CUSTOM_AGENT_BLOCKED_TOOL_MESSAGE = "This tool is not available to custom agents.";

export type RunFacts = {
  runId?: string | null;
  trigger: string;
  enqueuedByUser: boolean;
  payload: unknown;
  cronDedupeKey?: string | null;
};

export const CHAT_SURFACE_TRIGGERS: ReadonlySet<string> = new Set([
  "chat",
  "slack",
  "teams",
  "telegram",
  "discord",
  "whatsapp",
  "imessage",
  "email",
  "manual",
]);

export const FOUNDER_DIRECT_AGENT_MENTION_KEY = "founder_direct_agent_mention";

export function isEngineerBackendRun(slug: string, run: RunFacts | undefined): boolean {
  if (slug !== "engineer" || !run || run.enqueuedByUser) return false;
  if ((run.payload as Record<string, unknown> | null | undefined)?.[FOUNDER_DIRECT_AGENT_MENTION_KEY] === true) return false;
  if ((run.payload as { dispatched_by?: unknown } | null | undefined)?.dispatched_by === "cgo") return false;
  if (!CHAT_SURFACE_TRIGGERS.has(run.trigger)) return true;
  return (run.payload as { kind?: unknown } | null | undefined)?.kind === "engineer_pr_followup";
}

export const PREVIEW_RUN_KEY_PREFIX = "first-run-preview:";
export const PREVIEW_DONE_KEY_PREFIX = "first-run-preview-done:";

export function previewRunKey(tenant_id: string, slug: string): string {
  return `${PREVIEW_RUN_KEY_PREFIX}${tenant_id}:${slug}`;
}

export function isSignupPreviewIdentity(tenant_id: string, slug: string, run: RunFacts | undefined): boolean {
  if (!run || run.enqueuedByUser || run.trigger !== "channel_recipe") return false;
  return !!tenant_id && run.cronDedupeKey === previewRunKey(tenant_id, slug);
}

export function isSignupPreviewRun(
  tenant_id: string,
  slug: string,
  run: RunFacts | undefined,
  map: Readonly<Record<string, Tier>> = DEFAULT_TIER_AGENT_MIN,
  alwaysPro: readonly string[] = DEFAULT_TIER_ALWAYS_PRO,
): boolean {
  if (!run || run.enqueuedByUser || run.trigger !== "channel_recipe") return false;
  if (!tenant_id || run.cronDedupeKey !== previewRunKey(tenant_id, slug)) return false;
  return isTierGatedChannel(slug) && requiredTierFor(slug, map, alwaysPro) === "starter";
}

export const DONE_FOR_YOU_KEY_PREFIX = "done-for-you:";
export const DONE_FOR_YOU_MAX_ATTEMPTS = 3;

export function doneForYouKey(tenant_id: string, attempt: number): string {
  return `${DONE_FOR_YOU_KEY_PREFIX}${tenant_id}:${attempt}`;
}

export function doneForYouAttemptOf(tenant_id: string, key: string | null | undefined): number | null {
  if (!tenant_id || !key) return null;
  for (let n = 1; n <= DONE_FOR_YOU_MAX_ATTEMPTS; n++) if (key === doneForYouKey(tenant_id, n)) return n;
  return null;
}

export function isDoneForYouIdentity(tenant_id: string, run: RunFacts | undefined): boolean {
  if (!run || run.enqueuedByUser || run.trigger !== "channel_recipe") return false;
  return doneForYouAttemptOf(tenant_id, run.cronDedupeKey) !== null;
}

export function isDoneForYouRun(
  tenant_id: string,
  slug: string,
  run: RunFacts | undefined,
  map: Readonly<Record<string, Tier>> = DEFAULT_TIER_AGENT_MIN,
  alwaysPro: readonly string[] = DEFAULT_TIER_ALWAYS_PRO,
): boolean {
  if (!isDoneForYouIdentity(tenant_id, run)) return false;
  return isTierGatedChannel(slug) && requiredTierFor(slug, map, alwaysPro) === "starter";
}

export const BUILD_STAGE_HOST_SLUG = "product-builder";

export function requiredTierForRun(
  slug: string,
  map: Readonly<Record<string, Tier>> = DEFAULT_TIER_AGENT_MIN,
  buildStage = false,
  alwaysPro: readonly string[] = DEFAULT_TIER_ALWAYS_PRO,
): Tier {
  if (buildStage && isBuildStageAgent(slug)) return requiredTierFor(BUILD_STAGE_HOST_SLUG, map, alwaysPro);
  return requiredTierFor(slug, map, alwaysPro);
}

export const BUILD_CONDUCTOR_RUN_ID_KEY = "build_conductor_run_id";

export function buildConductorRunIdOf(payload: unknown): string | null {
  const v = (payload as Record<string, unknown> | null | undefined)?.[BUILD_CONDUCTOR_RUN_ID_KEY];
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    ? v.toLowerCase()
    : null;
}

export function requiredTierFor(
  slug: string,
  map: Readonly<Record<string, Tier>> = DEFAULT_TIER_AGENT_MIN,
  alwaysPro: readonly string[] = DEFAULT_TIER_ALWAYS_PRO,
): Tier {
  if (isProPageAgent(slug, alwaysPro)) return "pro";
  const t = map[slug];
  return isTier(t) ? t : "pro";
}

export function tierAllows(
  tier: Tier,
  slug: string,
  map?: Readonly<Record<string, Tier>>,
  alwaysPro?: readonly string[],
): boolean {
  return tierRank(tier) >= tierRank(requiredTierFor(slug, map, alwaysPro));
}

type Blob = {
  tier_credits?: unknown;
  tier_agent_min?: unknown;
  tier_gate_enforced?: unknown;
  tier_pro_tenants?: unknown;
  tier_always_pro?: unknown;
  tier_invite_emails_per_day?: unknown;
} | null | undefined;

function toNonNegInt(v: unknown): number | null {
  const n = typeof v === "string" && /^[0-9]+$/.test(v.trim()) ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 2_000_000_000 ? n : null;
}

export function tierCreditsFromBlob(blob: Blob): Record<PaidTier, number> {
  const raw = blob?.tier_credits;
  const out = { ...DEFAULT_TIER_CREDITS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const t of PAID_TIERS) {
    const n = toNonNegInt((raw as Record<string, unknown>)[t]);
    if (n !== null) out[t] = n;
  }
  return out;
}

function toInviteCap(v: unknown): number | null {
  const n = toNonNegInt(v);
  return n !== null && n <= MAX_INVITE_EMAILS_PER_DAY ? n : null;
}

export function tierInviteEmailsPerDayFromBlob(blob: Blob): Record<Tier, number> {
  const raw = blob?.tier_invite_emails_per_day;
  const out = { ...DEFAULT_TIER_INVITE_EMAILS_PER_DAY };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const t of TIERS) {
    const n = toInviteCap((raw as Record<string, unknown>)[t]);
    if (n !== null) out[t] = n;
  }
  return out;
}

export function tierAgentMinFromBlob(blob: Blob): Record<string, Tier> {
  const raw = blob?.tier_agent_min;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_TIER_AGENT_MIN };
  const out: Record<string, Tier> = {};
  for (const [slug, t] of Object.entries(raw as Record<string, unknown>)) {
    if (isTier(t)) out[slug] = t;
  }
  return out;
}

export function tierGateEnforcedFromBlob(blob: Blob): boolean {
  return blob?.tier_gate_enforced === true;
}

const AGENT_SLUG_RE = /^[a-z0-9_-]+$/;

export function tierAlwaysProFromBlob(blob: Blob): string[] {
  const raw = blob?.tier_always_pro;
  if (!Array.isArray(raw)) return [...DEFAULT_TIER_ALWAYS_PRO];
  return raw.filter((x): x is string => typeof x === "string" && AGENT_SLUG_RE.test(x));
}

export function tierProTenantsFromBlob(blob: Blob): string[] {
  const raw = blob?.tier_pro_tenants;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

export function tierConfigRejection(
  key:
    | "tier_credits"
    | "tier_agent_min"
    | "tier_gate_enforced"
    | "tier_pro_tenants"
    | "tier_always_pro"
    | "tier_invite_emails_per_day",
  raw: unknown,
): string | null {
  switch (key) {
    case "tier_always_pro":
      return Array.isArray(raw) && raw.every((x) => typeof x === "string" && AGENT_SLUG_RE.test(x))
        ? null
        : 'tier_always_pro must be an array of agent slugs like ["engineer", "fundraising"]';
    case "tier_gate_enforced":
      return typeof raw === "boolean" ? null : "tier_gate_enforced must be true or false";
    case "tier_pro_tenants":
      return Array.isArray(raw) && raw.every((x) => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x))
        ? null
        : "tier_pro_tenants must be an array of tenant uuids";
    case "tier_credits": {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "tier_credits must be an object like {\"starter\": 8000}";
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!isPaidTier(k)) return `tier_credits key "${k}" must be starter, growth or pro`;
        if (toNonNegInt(v) === null) return `tier_credits["${k}"] must be a whole number of credits`;
      }
      return null;
    }
    case "tier_invite_emails_per_day": {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return 'tier_invite_emails_per_day must be an object like {"free": 3, "pro": 50}';
      }
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!isTier(k)) return `tier_invite_emails_per_day key "${k}" must be one of ${TIERS.join(", ")}`;
        if (toInviteCap(v) === null) return `tier_invite_emails_per_day["${k}"] must be a whole number from 0 to ${MAX_INVITE_EMAILS_PER_DAY}`;
      }
      return null;
    }
    case "tier_agent_min": {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "tier_agent_min must be an object like {\"engineer\": \"pro\"}";
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!isTier(v)) return `tier_agent_min["${k}"] must be one of ${TIERS.join(", ")}`;
      }
      return null;
    }
  }
}

export function isPlanUpgradeError(err: { message?: string | null } | null | undefined): boolean {
  return !!err?.message && err.message.includes(PLAN_UPGRADE_REQUIRED);
}

export type PlanUpgradeRequired = Error & {
  code: typeof PLAN_UPGRADE_REQUIRED;
  agent_slug: string;
  required_tier: Tier;
  body: { error: { code: typeof PLAN_UPGRADE_REQUIRED; required_tier: Tier; message: string } };
};

export function asPlanUpgradeRequired(e: unknown): PlanUpgradeRequired | null {
  const x = e as Partial<PlanUpgradeRequired> | null;
  return !!x &&
    typeof x === "object" &&
    x.code === PLAN_UPGRADE_REQUIRED &&
    isTier(x.required_tier) &&
    typeof x.agent_slug === "string"
    ? (x as PlanUpgradeRequired)
    : null;
}
