
import { ExpectedToolError } from "@/services/tools/types";

const MINOR_UNITS: Readonly<Record<string, number>> = { USD: 100, INR: 100 };

export const DEFAULT_UNITS_PER_USD: Readonly<Record<string, number>> = { USD: 1, INR: 90 };

export function normalizeCurrency(currency: string | null | undefined): string {
  return (currency ?? "USD").trim().toUpperCase() || "USD";
}

export function isWritableCurrency(currency: string | null | undefined): boolean {
  return normalizeCurrency(currency) in MINOR_UNITS;
}

export function assertWritableCurrency(currency: string): string {
  const c = normalizeCurrency(currency);
  if (!(c in MINOR_UNITS)) {
    throw new ExpectedToolError(
      "meta_ads_unsupported_currency",
      `Meta budget writes support ${Object.keys(MINOR_UNITS).join(" and ")} ad accounts; this one is ${c}.`,
    );
  }
  return c;
}

export function minorUnitsPerMajor(currency: string): number {
  return MINOR_UNITS[assertWritableCurrency(currency)];
}

export function minorToMajor(minor: string | number | null | undefined, currency: string | null): number | null {
  if (minor == null || currency == null || !isWritableCurrency(currency)) return null;
  const n = Number(minor);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round((n / MINOR_UNITS[normalizeCurrency(currency)]) * 100) / 100;
}

export function unitsPerUsdFromBlob(blob: unknown, currency: string): number | null {
  const c = normalizeCurrency(currency);
  if (c === "USD") return 1;
  const map = (blob as { ad_fx_units_per_usd?: unknown } | null)?.ad_fx_units_per_usd;
  const raw = map && typeof map === "object" ? (map as Record<string, unknown>)[c] : undefined;
  const n = typeof raw === "string" ? Number(raw.trim()) : typeof raw === "number" ? raw : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_UNITS_PER_USD[c] ?? null;
}

export function capInAccountUnits<
  C extends { max_daily_budget_usd: number | null; max_daily_total_change_usd?: number | null },
>(cap: C, rate: number): C {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new ExpectedToolError("meta_ads_fx_unavailable", `Unusable exchange rate ${rate}; nothing was compared.`);
  }
  if (rate === 1) return cap;
  const scale = (n: number | null | undefined) => (n == null ? n : n * rate);
  return {
    ...cap,
    max_daily_budget_usd: scale(cap.max_daily_budget_usd),
    ...("max_daily_total_change_usd" in cap ? { max_daily_total_change_usd: scale(cap.max_daily_total_change_usd) } : {}),
  } as C;
}

export function formatMoney(amount: number, currency: string | null | undefined): string {
  const c = normalizeCurrency(currency);
  if (c === "USD") return `$${amount}`;
  if (c === "INR") return `₹${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  return `${c} ${amount}`;
}

export function bodyCurrencyMismatch(bodyCurrency: string | null | undefined, liveCurrency: string): string | null {
  const want = normalizeCurrency(bodyCurrency);
  const live = normalizeCurrency(liveCurrency);
  if (want === live) return null;
  return `meta_ads_currency_mismatch: this change was proposed in ${want} but the ad account is now ${live}. Nothing was changed; propose it again.`;
}
