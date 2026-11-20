
import { apiFetch } from "@/lib/api";
import { withAffiliateClick } from "@/lib/analytics/affiliate";
import { MANAGED_IN_STORE_COPY } from "./billingSubscription";
import type { LockTier } from "./planUpgrade";

const BILLING_UNAVAILABLE_COPY =
  "Self-serve billing isn't available yet. Contact support to change your plan.";

export async function startPlanCheckout(tier: Exclude<LockTier, "free">): Promise<string> {
  try {
    const res = await apiFetch("/api/billing/checkout", {
      method: "POST",
      body: JSON.stringify(withAffiliateClick({ tier, origin: "workspace" })),
    });
    const j = (await res.json().catch(() => null)) as {
      url?: string;
      redirect?: string;
      error?: { code?: string; message?: string };
    } | null;
    const dest = j?.url ?? j?.redirect;
    if (res.ok && dest) {
      window.location.href = dest;
      return "";
    }
    const code = j?.error?.code;
    if (res.status === 503 || code === "billing_not_configured")
      return BILLING_UNAVAILABLE_COPY;
    if (code === "managed_in_store") return j?.error?.message ?? MANAGED_IN_STORE_COPY;
    if (code === "price_not_configured")
      return "Plan changes aren't available yet. Contact support to change your plan.";
    return j?.error?.message ?? "Couldn't start checkout. Please try again.";
  } catch {
    return "Network error. Please try again.";
  }
}
