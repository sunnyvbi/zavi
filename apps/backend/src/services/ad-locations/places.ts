
import { gadsSearch, gadsSuggestGeoTargets } from "@/services/tools/google-ads/_client";
import { fbGet } from "@/services/tools/meta-ads/_client";
import { countryFromGoogleGeoId, countryName } from "./country";

export type AdPlatform = "google" | "meta";
export type PlaceKind = "City" | "State" | "Country" | "Region";
export type PlaceSource = "orders" | "address";

export type AdPlace = {
  id: string;
  name: string;
  kind: PlaceKind;
  source?: PlaceSource;
  reason?: string;
};

const GOOGLE_STATE_TYPES = new Set(["State", "Province", "Territory", "Prefecture", "Governorate", "Autonomous Community", "Union Territory", "Emirate", "Canton", "Okrug"]);
const GOOGLE_CITY_TYPES = new Set(["City", "Municipality", "Borough", "City Region", "Neighborhood", "District"]);

export function googleKind(targetType: string): PlaceKind {
  if (targetType === "Country") return "Country";
  if (GOOGLE_STATE_TYPES.has(targetType)) return "State";
  if (GOOGLE_CITY_TYPES.has(targetType)) return "City";
  return "Region";
}

export function googleDisplayName(g: { name: string; canonical_name: string; target_type: string; country_code: string }): string {
  const kind = googleKind(g.target_type);
  if (kind === "Country" || kind === "State") return g.name;
  const parts = g.canonical_name.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3 && g.country_code === "US") {
    const abbr = US_STATE_ABBR[parts[parts.length - 2]];
    if (abbr) return `${g.name}, ${abbr}`;
  }
  return parts.length >= 2 ? `${g.name}, ${parts[parts.length - 1]}` : g.name;
}

const US_STATE_ABBR: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT", Delaware: "DE",
  Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY",
  Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO",
  Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
  "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI",
  "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA",
  "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY", "District of Columbia": "DC",
};

type Searched = AdPlace & { country_code: string };

type MetaGeo = { key?: string; name?: string; type?: string; country_code?: string; country_name?: string; region?: string };

export function metaPlaceFromRow(r: MetaGeo): Searched | null {
  if (!r.key || !r.name || !r.type) return null;
  const kind: PlaceKind | null = r.type === "country" ? "Country" : r.type === "region" ? "State" : r.type === "city" ? "City" : null;
  if (!kind) return null;
  const name = r.type === "city" && r.region ? `${r.name}, ${r.region}` : r.type === "region" && r.country_name ? `${r.name}, ${r.country_name}` : r.name;
  return { id: `${r.type}:${r.key}`, name, kind, country_code: r.country_code ?? (r.type === "country" ? r.key : "") };
}

export async function searchPlatformPlaces(tenant_id: string, platform: AdPlatform, q: string, countryCode?: string): Promise<Searched[]> {
  const query = q.trim().slice(0, 100);
  if (query.length < 2) return [];
  if (platform === "google") {
    const rows = await gadsSuggestGeoTargets(tenant_id, query, countryCode ? { countryCode } : {});
    return rows.map((g) => ({ id: String(g.id), name: googleDisplayName(g), kind: googleKind(g.target_type), country_code: g.country_code }));
  }
  const r = (await fbGet(tenant_id, "search", {
    type: "adgeolocation",
    q: query,
    location_types: JSON.stringify(["country", "region", "city"]),
    limit: 12,
  })) as { data?: MetaGeo[] };
  const out = (r?.data ?? []).map(metaPlaceFromRow).filter((p): p is Searched => p !== null);
  return countryCode ? out.filter((p) => !p.country_code || p.country_code === countryCode).concat(out.filter((p) => p.country_code && p.country_code !== countryCode)) : out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function placeQuery(label: string): string {
  const parts = label.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.find((p) => !/\d/.test(p) && !/^[A-Z]{2}$/.test(p) && p.length >= 2) ?? "";
}

export async function resolvePlace(tenant_id: string, platform: AdPlatform, label: string, countryCode: string): Promise<AdPlace | null> {
  const head = placeQuery(label);
  if (head.length < 2) return null;
  let rows: Searched[];
  try {
    rows = await searchPlatformPlaces(tenant_id, platform, head, countryCode);
  } catch (e) {
    console.warn(`[ad-locations] place lookup failed for ${tenant_id}: ${(e as Error).message}`);
    return null;
  }
  const want = norm(head);
  const inCountry = rows.filter((r) => r.country_code === countryCode && r.kind !== "Country");
  const exact = inCountry.filter((r) => norm(r.name.split(",")[0] ?? "") === want);
  const pick = exact.find((r) => r.kind === "City") ?? exact.find((r) => r.kind === "State") ?? exact[0];
  return pick ? { id: pick.id, name: pick.name, kind: pick.kind } : null;
}

export type PlaceResolution =
  | { status: "resolved"; place: AdPlace }
  | { status: "ambiguous"; candidates: AdPlace[] }
  | { status: "not_found" };

export async function resolvePlaceDetailed(
  tenant_id: string,
  platform: AdPlatform,
  label: string,
  countryCode: string | null,
  kind?: "City" | "State",
): Promise<PlaceResolution> {
  const head = placeQuery(label);
  if (head.length < 2) return { status: "not_found" };
  const parts = label.split(",").map((p) => p.trim()).filter(Boolean);
  const hint = parts[parts.indexOf(head) + 1] ?? "";
  const rows = await searchPlatformPlaces(tenant_id, platform, head, countryCode ?? undefined);
  const want = norm(head);
  const inRegion = (r: Searched) => {
    if (!hint || /\d/.test(hint)) return true;
    const region = (r.name.split(",")[1] ?? "").trim();
    return norm(region) === norm(hint) || US_STATE_ABBR[region] === hint.toUpperCase();
  };
  const exact = rows.filter(
    (r) =>
      (!countryCode || r.country_code === countryCode) &&
      r.kind !== "Country" &&
      norm(r.name.split(",")[0] ?? "") === want &&
      (r.kind !== "City" || inRegion(r)),
  );
  const plain = (r: Searched): AdPlace => ({ id: r.id, name: r.name, kind: r.kind });
  const hinted = !!hint && !/\d/.test(hint);
  if (!kind && !hinted) {
    const both = exact.filter((r) => r.kind === "City" || r.kind === "State");
    if (both.some((r) => r.kind === "City") && both.some((r) => r.kind === "State")) {
      return { status: "ambiguous", candidates: both.map(plain) };
    }
  }
  for (const k of kind ? [kind] : (["City", "State"] as const)) {
    const hits = exact.filter((r) => r.kind === k);
    if (hits.length === 1) return { status: "resolved", place: plain(hits[0]) };
    if (hits.length > 1) return { status: "ambiguous", candidates: hits.map(plain) };
  }
  return { status: "not_found" };
}

export async function readGooglePlaces(tenant_id: string, ids: readonly number[]): Promise<Map<number, AdPlace & { country_code: string }>> {
  const unique = [...new Set(ids)].filter((n) => Number.isInteger(n) && n > 0);
  const out = new Map<number, AdPlace & { country_code: string }>();
  if (unique.length === 0) return out;
  const rows = (await gadsSearch(
    tenant_id,
    "SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.canonical_name, geo_target_constant.target_type, geo_target_constant.country_code, geo_target_constant.status " +
      `FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${unique.map((id) => `'geoTargetConstants/${id}'`).join(", ")})`,
  )) as Array<{ geoTargetConstant?: { id?: string | number; name?: string; canonicalName?: string; targetType?: string; countryCode?: string; status?: string } }>;
  for (const r of rows) {
    const g = r.geoTargetConstant;
    const id = Number(g?.id);
    if (!g?.name || !Number.isInteger(id) || (g.status && g.status !== "ENABLED")) continue;
    const t = { name: g.name, canonical_name: g.canonicalName ?? g.name, target_type: g.targetType ?? "", country_code: g.countryCode ?? "" };
    out.set(id, { id: String(id), name: googleDisplayName(t), kind: googleKind(t.target_type), country_code: t.country_code });
  }
  return out;
}

export async function googlePlaceNames(tenant_id: string, ids: readonly number[]): Promise<Array<AdPlace & { country_code?: string }>> {
  let known = new Map<number, AdPlace & { country_code: string }>();
  try {
    known = await readGooglePlaces(tenant_id, ids);
  } catch (e) {
    console.warn(`[ad-locations] geo names unreadable for ${tenant_id}: ${(e as Error).message}`);
  }
  return [...new Set(ids)].map((id) => {
    const hit = known.get(id);
    if (hit) return hit;
    const country = countryFromGoogleGeoId(id);
    return country ? { id: String(id), name: country.name, kind: "Country" as const, country_code: country.code } : { id: String(id), name: `Place ${id}`, kind: "Region" as const };
  });
}

export function metaDisplayPlaces(places: ReadonlyArray<{ type: string; key: string; name?: string }>): AdPlace[] {
  return places.map((p) => ({
    id: `${p.type}:${p.key}`,
    name: p.type === "country" ? countryName(p.key) : p.name ?? p.key,
    kind: p.type === "country" ? "Country" : p.type === "region" ? "State" : "City",
  }));
}

export function parseMetaPlaceId(id: string): { type: "country" | "region" | "city"; key: string } | null {
  const m = /^(country|region|city):([A-Za-z0-9]{1,32})$/.exec(id);
  return m ? { type: m[1] as "country" | "region" | "city", key: m[2] } : null;
}

export const US_STATE_CODES: Readonly<Record<string, string>> = US_STATE_ABBR;
