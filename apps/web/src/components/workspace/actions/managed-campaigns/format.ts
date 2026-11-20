import type { CampaignTargeting } from "@zavi/shared";
export function money(value: number | undefined | null, currency: string | null) {
  if (value == null || !Number.isFinite(value) || !currency) return "-";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
}
export function wholeMoney(value: number | undefined | null, currency: string | null) {
  if (value == null || !Number.isFinite(value) || !currency) return "-";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 }).format(value);
}
export const count = (n: number | undefined) => n == null || !Number.isFinite(n) ? "-" : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
export const percent = (n: number | undefined) => n == null ? "-" : `${(n * 100).toFixed(2)}%`;

export function campaignLocationsLine(targeting: CampaignTargeting | undefined, countryName: (code: string) => string = code => code): string {
  const names = (places: CampaignTargeting["locations"]) => [...(places?.countries ?? []).map(countryName), ...(places?.include ?? []).map(place => place.name || place.id)];
  const places = names(targeting?.locations);
  const excluded = names(targeting?.excluded_locations);
  if (!places.length && !excluded.length) return "No country set: ads can show in every available location";
  const except = excluded.length ? `excluding ${excluded.join(", ")}` : "";
  if (!places.length) return `Every available location, ${except}`;
  return except ? `${places.join(", ")}; ${except}` : places.join(", ");
}
