import type { DecisionConsequence } from "@zavi/shared";
import { formatCurrency } from "@/components/workspace/metrics/currency";

type Body = Record<string, unknown>;

export function isTiktokAdsClass(cls: string | null | undefined): cls is "tiktok_ads.set_status" | "tiktok_ads.update_budget" {
  return cls === "tiktok_ads.set_status" || cls === "tiktok_ads.update_budget";
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function usd(v: unknown): string | null {
  const n = num(v);
  if (n === null) return null;
  const out = formatCurrency(n, "USD", !Number.isInteger(n));
  return out === "—" ? null : out;
}

function noun(b: Body): string {
  return b.level === "ad_group" ? "ad group" : b.level === "ad" ? "ad" : "campaign";
}

export function tiktokAdsRaisesSpend(cls: string, b: Body): boolean {
  if (cls === "tiktok_ads.create_launch") return true;
  if (cls === "tiktok_ads.set_status") return b.status !== "PAUSED";
  if (cls === "tiktok_ads.update_budget") {
    const to = num(b.daily_budget_usd), from = num(b.expected_current_daily_budget_usd);
    return !(to !== null && from !== null && to <= from);
  }
  return false;
}

const pause = (b: Body) => str(b.status)?.toUpperCase() === "PAUSED";
const who = (b: Body) => (str(b.name) ? `“${str(b.name)}”` : `this ${noun(b)}`);

export function tiktokAdsAction(cls: string, b: Body): string | null {
  if (cls === "tiktok_ads.set_status") return pause(b) ? `Pause this TikTok ${noun(b)}` : `Turn this TikTok ${noun(b)} back on`;
  if (cls === "tiktok_ads.update_budget") {
    const to = num(b.daily_budget_usd), from = num(b.expected_current_daily_budget_usd);
    if (to !== null && from !== null) return to > from ? "Raise daily budget" : "Lower daily budget";
    return "Change daily budget";
  }
  return null;
}

export function tiktokAdsDailyStake(cls: string, b: Body): string | null {
  if (cls === "tiktok_ads.set_status" && pause(b)) return null;
  const m = usd(b.daily_budget_usd);
  return m ? `${m}/day` : null;
}

export function tiktokAdsPreview(cls: string, b: Body): string | null {
  const name = str(b.name) ?? noun(b);
  if (cls === "tiktok_ads.set_status") return `→ TikTok · ${name}`;
  if (cls === "tiktok_ads.update_budget") {
    const from = usd(b.expected_current_daily_budget_usd), to = usd(b.daily_budget_usd);
    return `→ TikTok · ${name}${from && to ? ` · daily budget ${from} → ${to}` : ""}`;
  }
  return null;
}

export function tiktokAdsConsequence(cls: string, b: Body): DecisionConsequence | null {
  if (cls === "tiktok_ads.update_budget") {
    const from = usd(b.expected_current_daily_budget_usd), to = usd(b.daily_budget_usd);
    return { approve: `Changes the daily budget of ${who(b)} in TikTok Ads${from && to ? ` from ${from} to ${to}` : ""}.`, reject: `${who(b)} keeps its current daily budget.` };
  }
  if (cls === "tiktok_ads.set_status") {
    const daily = usd(b.daily_budget_usd);
    return pause(b)
      ? { approve: `Pauses ${who(b)} in TikTok Ads. It stops delivering and spending.`, reject: `${who(b)} keeps running and keeps spending.` }
      : { approve: `Turns ${who(b)} back on in TikTok Ads${daily ? `, up to ${daily}/day` : ""}.`, reject: `${who(b)} stays paused: no delivery, no spend.` };
  }
  return isTiktokAdsClass(cls) ? { approve: "Applies the change in TikTok Ads.", reject: "No change is made in TikTok Ads." } : null;
}

export function tiktokAdsFields(cls: string, b: Body): Array<{ label: string; value: string }> {
  const account = str(b.advertiser_name) ? [{ label: "Ad account", value: `${str(b.advertiser_name)} (${str(b.advertiser_id) ?? ""})` }] : [];
  if (cls === "tiktok_ads.set_status") {
    const label = `${noun(b)[0].toUpperCase()}${noun(b).slice(1)} ${who(b)}`;
    return [...account, { label, value: pause(b) ? "Active → Paused" : "Paused → Active" }];
  }
  if (cls === "tiktok_ads.update_budget") {
    return [...account, { label: "Daily budget", value: `${usd(b.expected_current_daily_budget_usd) ?? "?"} → ${usd(b.daily_budget_usd) ?? "?"}` }];
  }
  return [];
}
