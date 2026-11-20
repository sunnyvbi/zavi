
import { ExpectedToolError } from "@/services/tools/types";
import { gadsGetBudgetGuardFacts } from "../_client";

export const GOOGLE_NON_USD_CODE = "google_ads_non_usd_account";

const RUN_CACHE_TTL_MS = 30 * 60_000;
const RUN_CACHE_MAX = 1_000;
const runCache = new Map<string, { at: number; currency: string }>();

export function clearGoogleCurrencyRunCache(): void {
  runCache.clear();
}

export async function readGoogleAccountCurrency(
  tenant_id: string,
  run_id?: string | null,
  now: number = Date.now(),
): Promise<string> {
  const key = run_id ? `${run_id}\u0000${tenant_id}` : null;
  if (key) {
    const hit = runCache.get(key);
    if (hit && now - hit.at < RUN_CACHE_TTL_MS) return hit.currency;
  }
  const currency = ((await gadsGetBudgetGuardFacts(tenant_id, null)).currency_code ?? "").toUpperCase();
  if (key) {
    for (const [k, v] of runCache) {
      if (now - v.at >= RUN_CACHE_TTL_MS) runCache.delete(k);
    }
    if (runCache.size >= RUN_CACHE_MAX) {
      const oldest = runCache.keys().next().value;
      if (oldest !== undefined) runCache.delete(oldest);
    }
    runCache.set(key, { at: now, currency });
  }
  return currency;
}

export async function assertUsdGoogleAccount(
  ctx: { tenant_id: string; run_id?: string },
  what: string,
): Promise<void> {
  let currency: string;
  try {
    currency = await readGoogleAccountCurrency(ctx.tenant_id, ctx.run_id);
  } catch (e) {
    if (e instanceof ExpectedToolError) throw e;
    throw new ExpectedToolError(
      GOOGLE_NON_USD_CODE,
      `The Google Ads account currency could not be read (${(e as Error).message}). Zavi sends ${what} in USD, so nothing was proposed.`,
    );
  }
  if (currency !== "USD") {
    throw new ExpectedToolError(
      GOOGLE_NON_USD_CODE,
      `This Google Ads account bills in ${currency || "an unknown currency"}. Zavi sends ${what} in USD, so it cannot propose this here.`,
    );
  }
}

export type CurrencyRefusal = { ok: false; code?: string; error: string };

export async function googleCurrencyRefusal(tenant_id: string, outcome: string): Promise<CurrencyRefusal | null> {
  let currency: string;
  try {
    currency = await readGoogleAccountCurrency(tenant_id, null);
  } catch (e) {
    const code = e instanceof ExpectedToolError ? e.code : undefined;
    return {
      ok: false,
      ...(code ? { code } : {}),
      error: `google_ads_currency_unverified: the account currency could not be read (${(e as Error).message}); ${outcome}.`,
    };
  }
  if (currency === "USD") return null;
  return {
    ok: false,
    code: GOOGLE_NON_USD_CODE,
    error: `${GOOGLE_NON_USD_CODE}: this Google Ads account bills in ${currency || "an unknown currency"}; Zavi sends amounts in USD, so ${outcome}.`,
  };
}
