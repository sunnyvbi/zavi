import { ExpectedToolError } from "@/services/tools/types";

const MICROS_PER_USD = 1_000_000;

export function usdToMicros(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new ExpectedToolError(
      "google_ads_invalid_amount",
      `amount must be a finite positive number; got ${usd}`,
    );
  }
  return String(Math.round(usd * MICROS_PER_USD));
}

export function microsToUsd(micros: number | string | undefined): number {
  const n = Number(micros ?? 0);
  return Number.isFinite(n) ? Math.round((n / MICROS_PER_USD) * 100) / 100 : 0;
}

export function resourceId(resourceName: string): string {
  const tail = resourceName.split("/").pop() ?? "";
  return tail.includes("~") ? tail.split("~").pop() ?? "" : tail;
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

export function assertNoGoogleNameCollision(
  existing: readonly string[],
  name: string,
  label: "campaign" | "ad group",
): void {
  const target = normalize(name);
  for (const e of existing) {
    if (normalize(e) === target) {
      throw new ExpectedToolError(
        `google_ads_${label.replace(" ", "_")}_name_exists`,
        `A ${label} named "${e.trim()}" already exists in this account. Pick a unique name.`,
      );
    }
  }
}
