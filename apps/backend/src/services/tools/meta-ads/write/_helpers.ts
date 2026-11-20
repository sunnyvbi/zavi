
import { ExpectedToolError } from "@/services/tools/types";
import { minorUnitsPerMajor } from "./_currency";

export function toBudgetMinorUnits(usd: number, currency: string): number {
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new ExpectedToolError(
      "meta_ads_invalid_budget",
      `daily_budget_usd must be a finite positive number; got ${usd}`,
    );
  }
  return Math.round(usd * minorUnitsPerMajor(currency));
}

export function detectCbo(campaign: {
  daily_budget?: string | null;
  lifetime_budget?: string | null;
}): boolean {
  return hasPositiveBudget(campaign.daily_budget) || hasPositiveBudget(campaign.lifetime_budget);
}

function hasPositiveBudget(s: string | null | undefined): boolean {
  if (s == null) return false;
  const n = Number(s);
  return Number.isFinite(n) && n > 0;
}

export function assertNoNameCollision(existing: string[], name: string): void {
  const target = normalize(name);
  for (const e of existing) {
    if (normalize(e) === target) {
      throw new ExpectedToolError(
        "meta_ads_adset_name_exists",
        `An ad set named "${e.trim()}" already exists in this account. Pick a unique name.`,
      );
    }
  }
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

export function assertGraphWriteSucceeded(resp: unknown, label: string): void {
  if (resp && typeof resp === "object") {
    const r = resp as { success?: unknown; id?: unknown; error?: unknown };
    if (r.error != null) {
      throw new ExpectedToolError(
        "meta_ads_write_failed",
        `Meta ${label} returned an error: ${JSON.stringify(r.error).slice(0, 300)}`,
      );
    }
    if (r.success === true) return;
    if (r.success === false) {
      throw new ExpectedToolError(
        "meta_ads_write_failed",
        `Meta ${label} reported success=false (the change did not apply).`,
      );
    }
    if (typeof r.id === "string" && r.id.length > 0) return;
  }
  throw new ExpectedToolError(
    "meta_ads_write_failed",
    `Meta ${label} returned an unexpected response with no success/id confirmation.`,
  );
}
