
import { z } from "zod";
import { ExpectedToolError } from "@/services/tools/types";

export const GOALS_REQUIRING_PROMOTED_OBJECT = new Set(["OFFSITE_CONVERSIONS"]);

export const promotedObjectSchema = z
  .object({
    pixel_id: z
      .string()
      .regex(/^\d+$/, "pixel_id must be a numeric Meta pixel id (digits only)")
      .optional(),
    custom_event_type: z.string().min(1).optional(),
    custom_conversion_id: z.string().regex(/^\d+$/).optional(),
    application_id: z.string().regex(/^\d+$/).optional(),
    object_store_url: z.string().url().optional(),
    page_id: z.string().regex(/^\d+$/).optional(),
  })
  .strict();

export type PromotedObject = z.infer<typeof promotedObjectSchema>;

export function checkPromotedObjectForGoal(
  optimization_goal: string,
  promoted_object: PromotedObject | undefined,
): string | null {
  if (!GOALS_REQUIRING_PROMOTED_OBJECT.has(optimization_goal)) return null;
  if (!promoted_object) {
    return `optimization_goal=${optimization_goal} requires promoted_object {pixel_id, custom_event_type}. Use meta_ads_pixel_health to get a REAL pixel id for this ad account — never invent one.`;
  }
  if (!promoted_object.pixel_id) {
    return `optimization_goal=${optimization_goal} requires promoted_object.pixel_id (a real numeric pixel id from meta_ads_pixel_health).`;
  }
  if (!promoted_object.custom_event_type) {
    return `optimization_goal=${optimization_goal} requires promoted_object.custom_event_type (the conversion event, e.g. LEAD / PURCHASE / COMPLETE_REGISTRATION).`;
  }
  return null;
}

function badInterestLabel(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return "an interest entry was not an object";
  const e = entry as { id?: unknown; name?: unknown };
  const id = e.id;
  const named = typeof e.name === "string" ? `"${e.name}"` : "an unnamed interest";
  const ok =
    (typeof id === "string" && /^\d+$/.test(id)) ||
    (typeof id === "number" && Number.isInteger(id) && id > 0);
  return ok ? null : named;
}

function collectInterestArrays(targeting: Record<string, unknown>): unknown[][] {
  const out: unknown[][] = [];
  const push = (v: unknown) => {
    if (Array.isArray(v)) out.push(v);
  };
  push(targeting.interests);
  const flex = targeting.flexible_spec;
  if (Array.isArray(flex)) {
    for (const spec of flex) {
      if (spec && typeof spec === "object") push((spec as { interests?: unknown }).interests);
    }
  }
  const excl = targeting.exclusions;
  if (excl && typeof excl === "object") push((excl as { interests?: unknown }).interests);
  return out;
}

export function checkTargetingInterestIds(targeting: unknown): string | null {
  if (!targeting || typeof targeting !== "object") return null;
  const arrays = collectInterestArrays(targeting as Record<string, unknown>);
  const bad: string[] = [];
  for (const arr of arrays) {
    for (const entry of arr) {
      const label = badInterestLabel(entry);
      if (label) bad.push(label);
    }
  }
  if (bad.length === 0) return null;
  return `targeting interests must each carry a numeric Meta interest id — ${bad.join(
    ", ",
  )} ${bad.length === 1 ? "has" : "have"} no id. Meta rejects name-only interests. Call meta_ads_search_interests to get the real id for each interest name; do NOT guess an id.`;
}

export function assertTargetingInterestIds(targeting: unknown): void {
  const err = checkTargetingInterestIds(targeting);
  if (err) throw new ExpectedToolError("meta_ads_invalid_targeting", err);
}

export const metaGeoPlaceSchema = z.object({
  type: z.enum(["country", "region", "city"]),
  key: z.string().regex(/^[A-Za-z0-9]{1,32}$/),
  name: z.string().max(200).optional(),
});
export type MetaGeoPlace = z.infer<typeof metaGeoPlaceSchema>;

const COUNTRY_CODE = /^[A-Za-z]{2}$/;

export function checkTargetingGeo(targeting: unknown): string | null {
  if (!targeting || typeof targeting !== "object") return null;
  const geo = (targeting as { geo_locations?: unknown }).geo_locations;
  if (geo === undefined || geo === null) return null;
  if (typeof geo !== "object" || Array.isArray(geo)) return "targeting.geo_locations must be an object";
  const g = geo as Record<string, unknown>;
  const bad: string[] = [];
  const label = (x: unknown) =>
    x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string"
      ? String((x as { name: string }).name)
      : JSON.stringify(x);
  if (g.countries !== undefined) {
    if (!Array.isArray(g.countries)) return "targeting.geo_locations.countries must be a list of ISO country codes";
    for (const c of g.countries) if (typeof c !== "string" || !COUNTRY_CODE.test(c)) bad.push(label(c));
  }
  for (const k of ["regions", "cities"] as const) {
    if (g[k] === undefined) continue;
    if (!Array.isArray(g[k])) return `targeting.geo_locations.${k} must be a list`;
    for (const e of g[k] as unknown[]) {
      const key = e && typeof e === "object" ? (e as { key?: unknown }).key : undefined;
      if (!metaGeoPlaceSchema.shape.key.safeParse(typeof key === "number" ? String(key) : key).success) bad.push(label(e));
    }
  }
  if (bad.length === 0) return null;
  return `targeting locations must each be a Meta location key (countries as ISO codes) — ${bad.join(", ")} ${
    bad.length === 1 ? "is" : "are"
  } not. Pass place names in \`locations\` instead and they are resolved to Meta keys; do NOT guess a key.`;
}

export function assertTargetingGeo(targeting: unknown): void {
  const err = checkTargetingGeo(targeting);
  if (err) throw new ExpectedToolError("meta_ads_invalid_location", err);
}

const NON_NARROWING_KEYS = new Set([
  "geo_locations", "excluded_geo_locations", "locales", "age_min", "age_max", "age_range", "genders",
  "excluded_custom_audiences", "publisher_platforms", "facebook_positions", "instagram_positions",
  "messenger_positions", "audience_network_positions", "threads_positions", "device_platforms",
]);
const SERVER_OWNED_KEYS = new Set(["targeting_automation", "targeting_relaxation_types"]);

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

export function isBroadTargeting(t: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(t)) {
    if (SERVER_OWNED_KEYS.has(k) || isEmptyValue(v)) continue;
    if (!NON_NARROWING_KEYS.has(k)) return false;
  }
  if (t.age_min !== undefined && t.age_min !== null && !(typeof t.age_min === "number" && t.age_min >= 18 && t.age_min <= 25)) return false;
  if (t.age_max !== undefined && t.age_max !== null && !(typeof t.age_max === "number" && t.age_max >= 65)) return false;
  if (Array.isArray(t.genders)) {
    const picked = new Set(t.genders.filter((g) => g === 1 || g === 2));
    if (picked.size === 1) return false;
  }
  return true;
}

export function withAudienceMode(targeting: Record<string, unknown>): Record<string, unknown> {
  const t = targeting ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) if (!SERVER_OWNED_KEYS.has(k)) out[k] = v;
  const broad = isBroadTargeting(out);
  out.targeting_automation = { advantage_audience: broad ? 1 : 0 };
  if (includesAudience(out)) out.targeting_relaxation_types = { custom_audience: 0, lookalike: 0 };
  return out;
}

function includesAudience(t: Record<string, unknown>): boolean {
  if (!isEmptyValue(t.custom_audiences)) return true;
  return Array.isArray(t.flexible_spec) && t.flexible_spec.some((s) => s && typeof s === "object" && !isEmptyValue((s as { custom_audiences?: unknown }).custom_audiences));
}

export function audienceModeLabel(targeting: Record<string, unknown>): string {
  return isBroadTargeting(targeting ?? {})
    ? "Advantage audience on: only locations, languages, minimum age and excluded audiences are firm; Meta may show the ad to other people"
    : "Exact audience: Meta stays inside these limits";
}

export function checkTargetingPlacements(targeting: unknown): string | null {
  if (!targeting || typeof targeting !== "object") return null;
  const fb = (targeting as { facebook_positions?: unknown }).facebook_positions;
  if (Array.isArray(fb) && fb.includes("video_feeds")) {
    return "Meta no longer accepts the Facebook video feeds placement (video_feeds); drop it from facebook_positions";
  }
  return null;
}

export function assertTargetingPlacements(targeting: unknown): void {
  const err = checkTargetingPlacements(targeting);
  if (err) throw new ExpectedToolError("meta_ads_invalid_targeting", err);
}
