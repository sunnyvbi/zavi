
import { apiFetch } from "@/lib/api";
import { isTierSlug, tierRank, type BillingTerm, type TierSlug } from "@/lib/marketing/pricing";

export type SubscriptionSource = "stripe" | "app_store" | "play_store" | "test_store" | "shopify";

export const MANAGED_IN_STORE_COPY =
  "Your plan is managed in the App Store or Google Play. Change or cancel it there.";

export const MANAGED_IN_SHOPIFY_COPY =
  "Your plan is billed by Shopify. Change or cancel it from the Zavi app in your Shopify admin.";

export function isStoreSource(source: unknown): boolean {
  return source === "app_store" || source === "play_store" || source === "test_store" || source === "shopify";
}

export function isShopifySource(source: unknown): boolean {
  return source === "shopify";
}

export function managedElsewhereCopy(source: unknown): string {
  return isShopifySource(source) ? MANAGED_IN_SHOPIFY_COPY : MANAGED_IN_STORE_COPY;
}

export function toSource(v: unknown): SubscriptionSource {
  return v === "app_store" || v === "play_store" || v === "test_store" || v === "shopify" ? v : "stripe";
}

export type SubscriptionState = {
  tier: TierSlug;
  term: BillingTerm | null;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  scheduledChange: { tier: TierSlug; term: BillingTerm | null; effectiveAt: string | null } | null;
  source?: SubscriptionSource;
};

const isTerm = (v: unknown): v is BillingTerm => v === "monthly" || v === "6mo";

export function toSubscription(raw: unknown): SubscriptionState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isTierSlug(r.tier)) return null;
  const sc = r.scheduled_change as Record<string, unknown> | null | undefined;
  return {
    tier: r.tier,
    term: isTerm(r.term) ? r.term : null,
    status: typeof r.status === "string" ? r.status : "active",
    currentPeriodEnd: typeof r.current_period_end === "string" ? r.current_period_end : null,
    cancelAtPeriodEnd: r.cancel_at_period_end === true,
    source: toSource(r.source),
    scheduledChange:
      sc && isTierSlug(sc.tier)
        ? {
            tier: sc.tier,
            term: isTerm(sc.term) ? sc.term : null,
            effectiveAt: typeof sc.effective_at === "string" ? sc.effective_at : null,
          }
        : null,
  };
}

export async function fetchSubscription(): Promise<SubscriptionState | null> {
  try {
    const res = await apiFetch("/api/billing/subscription");
    if (!res.ok) return null;
    const j = (await res.json().catch(() => null)) as { subscription?: unknown } | null;
    return toSubscription(j?.subscription);
  } catch {
    return null;
  }
}

export type PlanChangeKind = "upgrade" | "downgrade" | "same";

export function classifyPlanChange(
  from: { tier: TierSlug; term: BillingTerm | null },
  to: { tier: TierSlug; term: BillingTerm },
): PlanChangeKind {
  const a = tierRank(from.tier);
  const b = tierRank(to.tier);
  if (b > a) return "upgrade";
  if (b < a) return "downgrade";
  if (to.tier === "free") return "same";
  const fromTerm = from.term ?? "monthly";
  if (fromTerm === to.term) return "same";
  return to.term === "6mo" ? "upgrade" : "downgrade";
}

type ActionResult =
  | { ok: true; redirect?: string; subscription: SubscriptionState | null }
  | { ok: false; code: string | null; message: string | null; status: number };

async function post(path: string, body: unknown): Promise<ActionResult> {
  try {
    const res = await apiFetch(path, { method: "POST", body: JSON.stringify(body ?? {}) });
    const j = (await res.json().catch(() => null)) as {
      redirect?: string;
      subscription?: unknown;
      error?: { code?: string; message?: string };
    } | null;
    if (!res.ok) {
      return { ok: false, code: j?.error?.code ?? null, message: j?.error?.message ?? null, status: res.status };
    }
    return { ok: true, redirect: j?.redirect, subscription: toSubscription(j?.subscription) };
  } catch {
    return { ok: false, code: "network", message: null, status: 0 };
  }
}

export const changePlan = (tier: TierSlug, term: BillingTerm) =>
  post("/api/billing/change-plan", { tier, term });
export const cancelPlan = () => post("/api/billing/cancel", {});
export const resumePlan = () => post("/api/billing/resume", {});

export function fmtPlanDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
