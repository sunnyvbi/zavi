
import { isTierSlug, type BillingTerm, type PaidTierSlug } from "@/lib/marketing/pricing";

export const PENDING_PLAN_KEY = "zavi.pendingPlan";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type PlanChoice = { tier: PaidTierSlug; term: BillingTerm };

export function parsePlanChoice(tier: unknown, term: unknown): PlanChoice | null {
  if (!isTierSlug(tier) || tier === "free") return null;
  if (term !== "monthly" && term !== "6mo") return null;
  return { tier, term };
}

export function savePendingPlan(choice: PlanChoice, now = Date.now()): void {
  try {
    window.localStorage.setItem(PENDING_PLAN_KEY, JSON.stringify({ ...choice, at: now }));
  } catch {
  }
}

export function readPendingPlan(now = Date.now()): PlanChoice | null {
  try {
    const raw = window.localStorage.getItem(PENDING_PLAN_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as { tier?: unknown; term?: unknown; at?: unknown };
    if (typeof j.at !== "number" || now - j.at > MAX_AGE_MS || now < j.at) return null;
    return parsePlanChoice(j.tier, j.term);
  } catch {
    return null;
  }
}

export function clearPendingPlan(): void {
  try {
    window.localStorage.removeItem(PENDING_PLAN_KEY);
  } catch {
  }
}

const UPGRADE_HASH_PREFIX = "billing-upgrade-";

export const PLANS_HASH = "billing-plans";

export function upgradeHash(choice: PlanChoice): `billing-upgrade-${string}` {
  return `${UPGRADE_HASH_PREFIX}${choice.tier}-${choice.term}`;
}

export function parseUpgradeHash(hash: string): PlanChoice | null {
  const raw = hash.replace(/^#/, "");
  if (!raw.startsWith(UPGRADE_HASH_PREFIX)) return null;
  const rest = raw.slice(UPGRADE_HASH_PREFIX.length);
  const dash = rest.indexOf("-");
  if (dash < 0) return null;
  return parsePlanChoice(rest.slice(0, dash), rest.slice(dash + 1));
}

export function isUpgradeHash(hash: string): boolean {
  return hash.replace(/^#/, "").startsWith(UPGRADE_HASH_PREFIX);
}
