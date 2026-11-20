
import { allowsAnalytics, type ConsentState } from "@/lib/consent";

export const REGION_COOKIE = "zavi_region";
export const COUNTRY_COOKIE = "zavi_country";
export const REGION_COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;

export type Region = "eu" | "other" | "unknown";

const OPT_IN_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "AX", "GF", "GP", "MQ", "RE", "YT", "MF",
  "IS", "LI", "NO",
  "GB", "GI", "IM", "JE", "GG",
]);

export function regionForCountry(country: string | null | undefined): "eu" | "other" | null {
  const code = countryCode(country);
  if (!code) return null;
  return OPT_IN_COUNTRIES.has(code) ? "eu" : "other";
}

export function countryCode(country: string | null | undefined): string | null {
  const code = (country ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== "XX" ? code : null;
}

export function readCountry(): string | null {
  try {
    if (typeof document === "undefined") return null;
    for (const part of document.cookie.split(";")) {
      const [name, value] = part.trim().split("=");
      if (name === COUNTRY_COOKIE) return countryCode(value);
    }
  } catch {
    return null;
  }
  return null;
}

export function parseRegion(cookieString: string): Region {
  for (const part of (cookieString || "").split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === REGION_COOKIE) return value === "eu" || value === "other" ? value : "unknown";
  }
  return "unknown";
}

export function readRegion(): Region {
  try {
    return typeof document === "undefined" ? "unknown" : parseRegion(document.cookie);
  } catch {
    return "unknown";
  }
}

export function allowsGoogleAnalytics(s: ConsentState, region: Region): boolean {
  if (region === "other") return allowsAnalytics(s);
  return s.status === "set" && s.prefs.analytics;
}
