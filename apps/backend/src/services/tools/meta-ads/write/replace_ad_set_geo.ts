
import { createHash } from "node:crypto";
import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import { fbGet, fbPost } from "../_client";
import { assertGraphWriteSucceeded } from "./_helpers";
import { ExpectedToolError } from "@/services/tools/types";
import { metaGeoPlaceSchema, type MetaGeoPlace } from "./_targeting-validate";

export const MAX_META_GEO_PLACES = 50;

export { metaGeoPlaceSchema, type MetaGeoPlace };

export const replaceAdSetGeoBodySchema = z.object({
  ad_set_id: z.string().regex(/^[0-9]+$/),
  places: z.array(metaGeoPlaceSchema).min(1).max(MAX_META_GEO_PLACES),
  before_names: z.array(z.string().max(200)).max(200),
  expected_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().max(255).optional(),
  about: z.string().max(300).optional(),
  rationale: rationaleInput(),
  over_cap: z.literal(true).optional(),
  origin: z.enum(["user_initiated_ledger", "zavi_location_proposal", "zavi_location_undo"]),
  before_places: z.array(metaGeoPlaceSchema).max(200).optional(),
  budget_daily: z.number().positive().optional(),
  budget_currency: z.string().regex(/^[A-Z]{3}$/).optional(),
});
export type ReplaceAdSetGeoBody = z.infer<typeof replaceAdSetGeoBodySchema>;

export type GeoLocations = {
  countries?: string[];
  regions?: Array<{ key?: string; name?: string; country?: string }>;
  cities?: Array<{ key?: string; name?: string; region?: string; country?: string }>;
  location_types?: string[];
  [other: string]: unknown;
};

const EDITABLE = new Set(["countries", "regions", "cities", "location_types"]);

export function unsupportedGeoKeys(geo: GeoLocations | null | undefined): string[] {
  if (!geo) return [];
  return Object.entries(geo)
    .filter(([k, v]) => !EDITABLE.has(k) && Array.isArray(v) && v.length > 0)
    .map(([k]) => k)
    .sort();
}

export function metaPlacesOf(geo: GeoLocations | null | undefined): MetaGeoPlace[] {
  if (!geo) return [];
  return [
    ...(geo.countries ?? []).map((c) => ({ type: "country" as const, key: String(c).toUpperCase() })),
    ...(geo.regions ?? []).flatMap((r) => (r?.key ? [{ type: "region" as const, key: String(r.key), ...(r.name ? { name: r.name } : {}) }] : [])),
    ...(geo.cities ?? []).flatMap((c) =>
      c?.key ? [{ type: "city" as const, key: String(c.key), ...(c.name ? { name: c.region ? `${c.name}, ${c.region}` : c.name } : {}) }] : [],
    ),
  ];
}

export function metaGeoFingerprint(geo: GeoLocations | null | undefined): string {
  const g = geo ?? {};
  const parts: string[] = [];
  for (const k of Object.keys(g).sort()) {
    const v = g[k];
    if (!Array.isArray(v)) continue;
    const items = v.map((x) => (x && typeof x === "object" ? JSON.stringify(Object.fromEntries(Object.entries(x as object).filter(([kk]) => kk !== "name").sort())) : String(x)));
    parts.push(`${k}=${items.sort().join(";")}`);
  }
  return createHash("sha256").update(`meta:${parts.join("|")}`).digest("hex");
}

export function shapeGeoLocations(places: readonly MetaGeoPlace[], old: GeoLocations | null | undefined): GeoLocations {
  const geo: GeoLocations = {};
  const countries = [...new Set(places.filter((p) => p.type === "country").map((p) => p.key.toUpperCase()))];
  const regions = [...new Set(places.filter((p) => p.type === "region").map((p) => p.key))].map((key) => ({ key }));
  const cities = [...new Set(places.filter((p) => p.type === "city").map((p) => p.key))].map((key) => ({ key }));
  if (countries.length) geo.countries = countries;
  if (regions.length) geo.regions = regions;
  if (cities.length) geo.cities = cities;
  if (old?.location_types?.length) geo.location_types = old.location_types;
  return geo;
}

export function metaPlaceKeys(geo: GeoLocations | null | undefined): string[] {
  return [...new Set(metaPlacesOf(geo).map((p) => `${p.type}:${p.key}`))].sort();
}

export async function readMetaAdSetTargeting(
  tenant_id: string,
  ad_set_id: string,
): Promise<{ name: string | null; targeting: Record<string, unknown> & { geo_locations?: GeoLocations } }> {
  if (!/^[0-9]+$/.test(ad_set_id)) throw new ExpectedToolError("meta_ads_invalid_ad_set_id", `invalid ad_set_id: ${ad_set_id}`);
  const r = (await fbGet(tenant_id, ad_set_id, { fields: "name,targeting" })) as { name?: string; targeting?: Record<string, unknown> };
  if (!r || typeof r !== "object" || !r.targeting || typeof r.targeting !== "object") {
    throw new ExpectedToolError("meta_ads_targeting_unreadable", "Meta did not return this ad set's targeting, so nothing was changed.");
  }
  return { name: r.name ?? null, targeting: r.targeting as Record<string, unknown> & { geo_locations?: GeoLocations } };
}

export async function metaReplaceAdSetGeo(
  tenant_id: string,
  body: ReplaceAdSetGeoBody,
): Promise<{ keys: string[]; verified: boolean; before: MetaGeoPlace[]; after_fingerprint: string | null; read_back: string[] | null }> {
  const { targeting } = await readMetaAdSetTargeting(tenant_id, body.ad_set_id);
  const geo = targeting.geo_locations;
  if (metaGeoFingerprint(geo) !== body.expected_fingerprint) {
    throw new ExpectedToolError(
      "meta_ads_geo_stale",
      "Where this ad set shows changed after the places were picked, so nothing was changed. Open the card again to pick from what it shows now.",
    );
  }
  const unsupported = unsupportedGeoKeys(geo);
  if (unsupported.length) {
    throw new ExpectedToolError("meta_ads_geo_unsupported", "This ad set targets places Zavi can't edit here, so nothing was changed. Change it in Meta Ads Manager.");
  }
  const geo_locations = shapeGeoLocations(body.places, geo);
  const r = await fbPost(tenant_id, body.ad_set_id, { targeting: JSON.stringify({ ...targeting, geo_locations }) });
  assertGraphWriteSucceeded(r, "location update");
  const want = metaPlaceKeys(geo_locations);
  let verified = false;
  let after_fingerprint: string | null = null;
  let read_back: string[] | null = null;
  try {
    const after = await readMetaAdSetTargeting(tenant_id, body.ad_set_id);
    read_back = metaPlaceKeys(after.targeting.geo_locations);
    verified = read_back.join(",") === want.join(",");
    if (verified) after_fingerprint = metaGeoFingerprint(after.targeting.geo_locations);
  } catch {
    verified = false;
  }
  return { keys: want, verified, before: metaPlacesOf(geo), after_fingerprint, read_back };
}

type MetaGeoMeta = { key?: string; name?: string; region?: string; country_code?: string };

export type MetaPlaceFacts = MetaGeoPlace & { country_code: string | null; region_name: string | null };

export async function verifyMetaPlaces(tenant_id: string, places: readonly MetaGeoPlace[]): Promise<MetaGeoPlace[]> {
  return (await metaPlaceFacts(tenant_id, places)).map(({ country_code: _c, region_name: _r, ...p }) => p);
}

export async function metaPlaceFacts(tenant_id: string, places: readonly MetaGeoPlace[]): Promise<MetaPlaceFacts[]> {
  if (places.length === 0) return [];
  const of = (t: MetaGeoPlace["type"]) => places.filter((p) => p.type === t).map((p) => p.key);
  const params: Record<string, string> = { type: "adgeolocationmeta" };
  if (of("country").length) params.countries = JSON.stringify(of("country"));
  if (of("region").length) params.regions = JSON.stringify(of("region"));
  if (of("city").length) params.cities = JSON.stringify(of("city"));
  const r = (await fbGet(tenant_id, "search", params)) as { data?: Record<string, unknown> | unknown[] };
  const data = r?.data;
  const bucket = (name: string): Map<string, MetaGeoMeta> => {
    const m = new Map<string, MetaGeoMeta>();
    const src = data && !Array.isArray(data) ? (data as Record<string, unknown>)[name] : undefined;
    if (src && typeof src === "object") {
      for (const [k, v] of Object.entries(src as Record<string, MetaGeoMeta>)) m.set(String(v?.key ?? k), v ?? {});
    }
    return m;
  };
  const known = { country: bucket("countries"), region: bucket("regions"), city: bucket("cities") };
  return places.map((p) => {
    const hit = known[p.type].get(p.key) ?? (p.type === "country" ? known.country.get(p.key.toUpperCase()) : undefined);
    if (!hit) throw new ExpectedToolError("ad_locations_bad_place", "One of the places is not a place Meta knows. Search for it again.");
    const name = p.type === "city" && hit.name && hit.region ? `${hit.name}, ${hit.region}` : hit.name ?? p.name ?? p.key;
    const cc = p.type === "country" ? p.key.toUpperCase() : typeof hit.country_code === "string" && /^[A-Za-z]{2}$/.test(hit.country_code) ? hit.country_code.toUpperCase() : null;
    return { ...p, name, country_code: cc, region_name: p.type === "region" ? hit.name ?? null : hit.region ?? null };
  });
}
