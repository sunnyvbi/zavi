
import { ExpectedToolError } from "@/services/tools/types";

export const CREATOR_PAYOUT_COUNTRIES: ReadonlySet<string> = new Set([
  "US",
  "CA",
  "GB",
  "CH",
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO",
]);

export function creatorPayoutCountrySupported(country_code: string | null | undefined): boolean {
  if (typeof country_code !== "string") return false;
  return CREATOR_PAYOUT_COUNTRIES.has(country_code.trim().toUpperCase());
}

export function assertCreatorPayoutCountry(country_code: string | null | undefined): void {
  if (!creatorPayoutCountrySupported(country_code)) {
    throw new ExpectedToolError(
      "creator_payout_country_unsupported",
      "This creator's country is outside Stripe's payout reach (US, Canada, UK, EEA, Switzerland), so they cannot be booked or hired yet. No card is held and no money moves.",
    );
  }
}
