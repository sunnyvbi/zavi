
export const PLAN_UPGRADE_REQUIRED = "plan_upgrade_required";

export type LockTier = "free" | "starter" | "growth" | "pro";

const NAMES: Record<LockTier, string> = {
  free: "Free",
  starter: "Starter",
  growth: "Growth",
  pro: "Pro",
};

function isLockTier(v: unknown): v is LockTier {
  return typeof v === "string" && v in NAMES;
}

export function lockedTierOf(row: unknown): Exclude<LockTier, "free"> | null {
  const t = (row as { locked_tier?: unknown } | null | undefined)?.locked_tier;
  return isLockTier(t) && t !== "free" ? t : null;
}

export function planBadgeLabel(tier: LockTier): string {
  return `${NAMES[tier]} plan`;
}

export function requiredTierFromBody(body: unknown): LockTier | null {
  const b = body as { required_tier?: unknown; error?: { required_tier?: unknown } } | null;
  const t = b?.error?.required_tier ?? b?.required_tier;
  return isLockTier(t) ? t : null;
}

export function planUpgradeMessage(serverMessage: string | null | undefined, tier: LockTier | null): string {
  if (serverMessage && serverMessage.trim()) return serverMessage;
  return tier
    ? `This needs the ${NAMES[tier]} plan. Upgrade to use it.`
    : "Your plan doesn't include this. Upgrade to use it.";
}

export function isPlanUpgradeRefusal(status: number | null | undefined, code: string | null | undefined): boolean {
  return code === PLAN_UPGRADE_REQUIRED && (status == null || status === 403);
}
