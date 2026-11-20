
import { isTierSlug } from "@/lib/marketing/pricing";
import { upgradeHash } from "./pendingPlan";
import type { TabDescriptor } from "./types";

export type BillingTarget = "billing" | "billing-usage" | "billing-plans" | `billing-upgrade-${string}`;

export function openBillingSettings(
  openTab: (d: Omit<TabDescriptor, "id">) => string,
  target: BillingTarget = "billing",
): void {
  openTab({
    kind: "settings",
    title: "Settings",
    payload: { kind: "settings" },
    dirty: false,
    pinned: false,
  } as Omit<TabDescriptor, "id">);
  if (typeof window !== "undefined") {
    window.setTimeout(() => {
      window.location.hash = target;
    }, 80);
  }
}

export function wallBillingTarget(kind: "credits" | "plan", tier?: string | null): BillingTarget {
  return kind === "plan" && isTierSlug(tier) && tier !== "free"
    ? upgradeHash({ tier, term: "6mo" })
    : "billing";
}
