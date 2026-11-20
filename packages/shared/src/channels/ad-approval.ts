import type { CampaignTargeting } from "./managed-campaigns";

export const AD_IMAGE_PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

export function isAdImagePath(value: string): boolean {
  return AD_IMAGE_PATH_RE.test(value);
}

export function isOwnAdImagePath(tenantId: string, value: string): boolean {
  return isAdImagePath(value) && value.slice(0, 36).toLowerCase() === tenantId.toLowerCase();
}

export type AdSuggestionSource = "starter" | "company_profile" | "website" | "default";

export type CampaignReviewSuggested = {
  lifetime_budget_micros: number | null;
  max_bid_micros: number | null;
  countries: string[];
  budget_source: AdSuggestionSource;
  countries_source: AdSuggestionSource;
};

export type AdImageAi = { available: boolean; credits: number | null };

export type CampaignReviewResponse<Draft> = {
  draft: Draft;
  currency: string;
  suggested: CampaignReviewSuggested;
  ai_image: AdImageAi;
};

export type LaunchItemStatus = "activated" | "already_active" | "failed" | "skipped";
export type LaunchItem = { kind: "campaign" | "ad_group" | "ad"; id: string; name: string; status: LaunchItemStatus; reason?: string };

export type LaunchSummary = {
  currency?: string;
  fx?: { currency: string; units_per_usd: number; as_of: string | null; source: "USD" | "ExchangeRate-API" };
  funding_source?: "wallet" | "provider";
  provider_account_id?: string | null;
  state: "ready" | "launched" | "ended" | "archived";
  campaign: { id: string; name: string; status: string | null; updated_at: number; bidding_type: string; lifetime_budget_micros: number | null; daily_budget_micros: number | null; countries: string[]; targeting?: CampaignTargeting; start_time: number | null; end_time: number | null };
  groups: Array<{ id: string; name: string; status: string | null; max_bid_micros: number | null }>;
  ads: Array<{ id: string; ad_group_id: string; name: string; status: string | null; review_status: string | null; title: string | null; body: string | null; target_url: string | null }>;
  wallet: { currency: string; available_cents: number; funding_enabled: boolean; in_app_enabled: boolean } | null;
  shortfall_cents: number | null;
  snapshot: string;
};

export type LaunchResult = { ok: boolean; items: LaunchItem[]; code?: string; message?: string };

function canonicalRegion(code: string): string {
  try { return Intl.getCanonicalLocales(`und-${code}`)[0]?.slice(4) ?? code; } catch { return code; }
}

const NOT_COUNTRIES = new Set(["EU", "EZ", "UN", "QO", "ZZ", "AC", "CP", "CQ", "DG", "EA", "IC", "TA"]);

let regionCache: Array<{ code: string; name: string }> | null = null;
export function countryOptions(locale = "en"): Array<{ code: string; name: string }> {
  if (regionCache && locale === "en") return regionCache;
  const names = new Intl.DisplayNames([locale], { type: "region", fallback: "none" });
  const out: Array<{ code: string; name: string }> = [];
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    if (NOT_COUNTRIES.has(code) || code.startsWith("X")) continue;
    if (canonicalRegion(code) !== code) continue;
    const name = names.of(code);
    if (name && name !== code) out.push({ code, name });
  }
  out.sort((x, y) => x.name.localeCompare(y.name));
  if (locale === "en") regionCache = out;
  return out;
}

const COUNTRY_ALIASES: Record<string, string> = {
  us: "US", usa: "US", "u.s.": "US", "u.s.a.": "US", "united states of america": "US", america: "US",
  uk: "GB", "u.k.": "GB", england: "GB", scotland: "GB", wales: "GB", "great britain": "GB", britain: "GB",
  uae: "AE", "south korea": "KR", korea: "KR", russia: "RU", vietnam: "VN", "czech republic": "CZ",
  holland: "NL", "the netherlands": "NL",
};

const COUNTRY_DOMAINS: Record<string, string> = {
  uk: "GB", ca: "CA", au: "AU", nz: "NZ", ie: "IE", in: "IN", de: "DE", fr: "FR", es: "ES", it: "IT", nl: "NL",
  be: "BE", se: "SE", no: "NO", dk: "DK", fi: "FI", pl: "PL", pt: "PT", at: "AT", ch: "CH", jp: "JP", kr: "KR",
  sg: "SG", my: "MY", ph: "PH", za: "ZA", br: "BR", mx: "MX", ar: "AR", cl: "CL", ae: "AE", sa: "SA", il: "IL",
  tr: "TR", gr: "GR", cz: "CZ", hu: "HU", ro: "RO", hk: "HK", tw: "TW", id: "ID", th: "TH", vn: "VN", ng: "NG", ke: "KE", eg: "EG", pk: "PK",
};

export function countryFromWebsite(website: string | null | undefined): string | null {
  if (!website) return null;
  let host: string;
  try { host = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase(); } catch { return null; }
  const tld = host.split(".").pop() ?? "";
  return COUNTRY_DOMAINS[tld] ?? null;
}

export function countryFromLocation(location: string | null | undefined): string | null {
  const last = (location ?? "").split(",").pop()?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
  if (COUNTRY_ALIASES[last]) return COUNTRY_ALIASES[last];
  if (last.length < 3) return null;
  const match = countryOptions().find(c => c.name.toLowerCase() === last);
  return match?.code ?? null;
}
