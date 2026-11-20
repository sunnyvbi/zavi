import { z } from "zod";
import { ExpectedToolError } from "@/services/tools/types";

export type AdsFx = {
  currency: string;
  units_per_usd: number;
  as_of: string | null;
  source: "ExchangeRate-API" | "USD";
};
const schema = z.object({
  result: z.literal("success"),
  base_code: z.literal("USD"),
  time_last_update_unix: z.number().int().positive(),
  time_next_update_unix: z.number().int().positive(),
  rates: z.record(z.string(), z.number().finite().positive()),
});
let cached: { data: z.infer<typeof schema>; until: number } | undefined;
let pending: Promise<z.infer<typeof schema>> | undefined;
export const ADS_FX_UNAVAILABLE =
  "Zavi could not get a current exchange rate for this ad account's currency, so it cannot count new spending against your monthly ad budget in dollars right now. Nothing new was approved or sent, and you can still pause campaigns. Exchange rates are checked every hour, so try again in an hour.";
export const adsFxUnsupported = (currency: string) =>
  `Zavi has no exchange rate for ${/^[A-Z]{3}$/.test(currency) ? currency : "this ad account's currency"}, so it cannot count this ad account's spending against your monthly ad budget. Nothing new was approved or sent, and you can still pause campaigns. Use an ad account billed in another currency, such as US dollars.`;
const fail = (words: string = ADS_FX_UNAVAILABLE): never => {
  throw new ExpectedToolError("ads_fx_unavailable", words);
};
const MAX_RATE_AGE_MS = 48 * 3600000;
export async function adsFx(currency: string): Promise<AdsFx> {
  if (currency === "USD")
    return { currency, units_per_usd: 1, as_of: null, source: "USD" };
  if (!/^[A-Z]{3}$/.test(currency)) return fail(adsFxUnsupported(currency));
  const now = Date.now();
  try {
    if (!cached || cached.until <= now) {
      const kept = cached && now - cached.data.time_last_update_unix * 1000 <= MAX_RATE_AGE_MS ? cached : undefined;
      pending ??= (async () => {
        const response = await fetch("https://open.er-api.com/v6/latest/USD", {
          signal: AbortSignal.timeout(8000),
          redirect: "error",
        });
        if (!response.ok) return fail();
        return schema.parse(await response.json());
      })().finally(() => {
        pending = undefined;
      });
      const data = await pending.catch(() => undefined);
      if (
        data &&
        data.rates.USD === 1 &&
        data.time_last_update_unix * 1000 <= now + 300000 &&
        now - data.time_last_update_unix * 1000 <= MAX_RATE_AGE_MS &&
        data.time_next_update_unix > data.time_last_update_unix
      )
        cached = {
          data,
          until: Math.min(now + 3600000, data.time_next_update_unix * 1000),
        };
      else if (kept) cached = { ...kept, until: now + 300000 };
      else return fail();
    }
    if (now - cached.data.time_last_update_unix * 1000 > MAX_RATE_AGE_MS)
      return fail();
    const units = cached.data.rates[currency];
    if (!units) return fail(adsFxUnsupported(currency));
    return {
      currency,
      units_per_usd: units,
      as_of: new Date(cached.data.time_last_update_unix * 1000).toISOString(),
      source: "ExchangeRate-API",
    };
  } catch (e) {
    if (e instanceof ExpectedToolError) throw e;
    return fail();
  }
}
function fraction(value: number): [bigint, bigint] {
  if (!Number.isFinite(value) || value < 0) return fail();
  const [digits, exponent = "0"] = value.toString().toLowerCase().split("e");
  const [whole, decimal = ""] = digits.split(".");
  const scale = decimal.length - Number(exponent);
  return scale >= 0
    ? [BigInt(whole + decimal), 10n ** BigInt(scale)]
    : [BigInt(whole + decimal) * 10n ** BigInt(-scale), 1n];
}
function safe(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return fail();
  return Number(value);
}
export function adsUsd(amount: number, fx: AdsFx): number {
  const [a, b] = fraction(amount),
    [r, s] = fraction(fx.units_per_usd);
  if (r === 0n) return fail();
  const numerator = a * s * 100n,
    denominator = b * r;
  return safe((numerator + denominator - 1n) / denominator) / 100;
}
export function adsLocalMicros(usd: number, fx: AdsFx): number {
  const [a, b] = fraction(usd),
    [r, s] = fraction(fx.units_per_usd);
  if (r === 0n) return fail();
  const micros = safe((a * r * 1000000n) / (b * s));
  if (micros <= 0) return fail();
  return micros;
}
