
import type { AdObject, Inventory } from "./ad-spend-controller";
import type { GeoLocations, MetaGeoPlace } from "@/services/tools/meta-ads/write/replace_ad_set_geo";

export const ANY_GOAL = "*";

export type NamedPlace = { kind: "country" | "state" | "city" | "market"; country: string; name?: string; state?: string; key?: string };

export type CopyRegion = {
  label: string;
  share: number;
  place: NamedPlace;
  meta: MetaGeoPlace;
  covered_goals: string[];
};

export type Coverage = { goals: string[]; places: NamedPlace[] | "everywhere" };

export type CopyTargets = { regions: CopyRegion[]; goals: Map<string, string | null> };

const AWARENESS = new Set(["REACH", "IMPRESSIONS", "AD_RECALL_LIFT", "THRUPLAY", "TWO_SECOND_CONTINUOUS_VIDEO_VIEWS"]);
const TRAFFIC = new Set(["LINK_CLICKS", "LANDING_PAGE_VIEWS"]);
const ENGAGEMENT = new Set(["POST_ENGAGEMENT", "PAGE_LIKES", "EVENT_RESPONSES", "CONVERSATIONS"]);
const CONVERSION_GOALS = new Set(["OFFSITE_CONVERSIONS", "VALUE", "CONVERSIONS"]);

export function metaGoalKey(optimization_goal: string | null | undefined, promoted?: { custom_event_type?: string; custom_conversion_id?: string } | null): string | null {
  const g = (optimization_goal ?? "").toUpperCase();
  if (!g) return null;
  if (AWARENESS.has(g)) return "awareness";
  if (TRAFFIC.has(g)) return "traffic";
  if (ENGAGEMENT.has(g)) return "engagement";
  if (g === "APP_INSTALLS") return "app_installs";
  if (g === "LEAD_GENERATION" || g === "QUALITY_LEAD") return "event:LEAD";
  if (promoted?.custom_event_type) return `event:${promoted.custom_event_type.toUpperCase()}`;
  if (CONVERSION_GOALS.has(g) || promoted?.custom_conversion_id) return null;
  return null;
}

const GOOGLE_EVENT: Record<string, string> = {
  PURCHASE: "event:PURCHASE",
  SIGNUP: "event:COMPLETE_REGISTRATION",
  SUBMIT_LEAD_FORM: "event:LEAD",
  QUALIFIED_LEAD: "event:LEAD",
  CONVERTED_LEAD: "event:LEAD",
  IMPORTED_LEAD: "event:LEAD",
  CONTACT: "event:LEAD",
  REQUEST_QUOTE: "event:LEAD",
  BOOK_APPOINTMENT: "event:LEAD",
  PHONE_CALL_LEAD: "event:LEAD",
  ADD_TO_CART: "event:ADD_TO_CART",
  BEGIN_CHECKOUT: "event:INITIATED_CHECKOUT",
  SUBSCRIBE_PAID: "event:SUBSCRIBE",
};
const GOOGLE_CONVERSION_BIDDING = new Set(["MAXIMIZE_CONVERSIONS", "MAXIMIZE_CONVERSION_VALUE", "TARGET_CPA", "TARGET_ROAS"]);
const GOOGLE_CLICK_BIDDING = new Set(["MANUAL_CPC", "TARGET_SPEND", "MAXIMIZE_CLICKS", "ENHANCED_CPC"]);
const GOOGLE_VIEW_BIDDING = new Set(["TARGET_IMPRESSION_SHARE", "MANUAL_CPM", "MANUAL_CPV", "TARGET_CPM", "TARGET_CPV"]);

export function googleGoalKeys(bidding: string | null | undefined, categories: readonly string[]): string[] {
  const b = (bidding ?? "").toUpperCase();
  if (GOOGLE_CLICK_BIDDING.has(b)) return ["traffic"];
  if (GOOGLE_VIEW_BIDDING.has(b)) return ["awareness"];
  if (GOOGLE_CONVERSION_BIDDING.has(b) && categories.length > 0) {
    return [...new Set(categories.map((c) => GOOGLE_EVENT[c.toUpperCase()] ?? ANY_GOAL))];
  }
  return [ANY_GOAL];
}

const norm = (s: string | undefined) =>
  (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const nonAscii = (s: string | undefined) => !!s && /[^\x00-\x7F]/.test(s);

export function placeKey(name: string | undefined, abbr: Readonly<Record<string, string>>): string {
  const n = (name ?? "").trim();
  const full = Object.keys(abbr).find((k) => abbr[k] === n.toUpperCase());
  return norm(full ?? n);
}

const PLACED_META_GEO = new Set(["countries", "regions", "cities", "location_types", "country_groups"]);
const NARROW_META_GEO = new Set(["zips", "custom_locations", "neighborhoods", "places", "subcities", "subneighborhoods"]);
const MARKET_META_GEO = new Set(["geo_markets", "medium_geo_areas", "large_geo_areas", "electoral_districts", "metro_areas"]);

export function placesOfMetaGeo(geo: GeoLocations | null | undefined): NamedPlace[] | "everywhere" {
  if (!geo) return "everywhere";
  if (Array.isArray(geo.country_groups) && geo.country_groups.length > 0) return "everywhere";
  const out: NamedPlace[] = [];
  for (const [k, v] of Object.entries(geo)) {
    if (!Array.isArray(v) || v.length === 0 || PLACED_META_GEO.has(k) || NARROW_META_GEO.has(k)) continue;
    if (MARKET_META_GEO.has(k)) out.push({ kind: "market", country: "" });
    else return "everywhere";
  }
  for (const c of geo.countries ?? []) out.push({ kind: "country", country: String(c).toUpperCase() });
  for (const r of geo.regions ?? []) {
    if (!r?.name && !r?.key) return "everywhere";
    out.push({ kind: "state", country: String(r?.country ?? "").toUpperCase(), name: r?.name, key: r?.key ? String(r.key) : undefined });
  }
  for (const c of geo.cities ?? []) {
    if (!c?.name && !c?.key) return "everywhere";
    out.push({ kind: "city", country: String(c?.country ?? "").toUpperCase(), name: c?.name, state: c?.region, key: c?.key ? String(c.key) : undefined });
  }
  return out;
}

export function reaches(places: NamedPlace[] | "everywhere", target: NamedPlace, abbr: Readonly<Record<string, string>>): boolean {
  if (places === "everywhere") return true;
  const k = (s: string | undefined) => placeKey(s, abbr);
  const sameCountry = (p: NamedPlace) => !p.country || p.country === target.country;
  for (const p of places) {
    if (p.kind === "country" && p.country === target.country) return true;
    if (p.kind === "market") {
      if (target.kind === "city" && sameCountry(p)) return true;
      continue;
    }
    if (p.key && target.key && p.kind === target.kind) {
      if (p.key === target.key) return true;
      continue;
    }
    if (p.kind !== "country" && !p.name) return true;
    if (!sameCountry(p)) continue;
    if (nonAscii(p.name) || nonAscii(p.state) || nonAscii(target.name) || nonAscii(target.state)) return true;
    if (k(p.name) !== "" && k(p.name) === k(target.name)) return true;
    if (target.kind === "city") {
      if (p.kind === "state" && (!target.state || k(p.name) === k(target.state))) return true;
      if (p.kind === "city" && k(p.name) === k(target.name) && (!p.state || !target.state || k(p.state) === k(target.state))) return true;
    }
  }
  return false;
}

export function coveredGoals(target: NamedPlace, coverage: readonly Coverage[], abbr: Readonly<Record<string, string>>): string[] {
  const goals = new Set<string>();
  for (const c of coverage) if (reaches(c.places, target, abbr)) for (const g of c.goals) goals.add(g);
  return [...goals].sort();
}

export function pickCopyRegion(goal: string | null | undefined, regions: readonly CopyRegion[], taken: ReadonlySet<string>): CopyRegion | null {
  if (!goal) return null;
  for (const r of [...regions].sort((a, b) => b.share - a.share)) {
    if (r.covered_goals.includes(ANY_GOAL) || r.covered_goals.includes(goal)) continue;
    if (taken.has(`${goal}|${r.meta.type}:${r.meta.key}`)) continue;
    return r;
  }
  return null;
}

export function metaCoverage(objects: readonly AdObject[]): Coverage[] {
  return objects
    .filter((o) => o.platform === "meta" && o.level === "ad_set" && !o.paused_self && o.has_live_ads !== false)
    .map((o) => ({ goals: [o.goal ?? ANY_GOAL], places: placesOfMetaGeo(o.geo) }));
}

const MAX_REGIONS = 8;
const PLACE_TTL_MS = 24 * 3_600_000;
const placeCache = new Map<string, { at: number; place: { meta: MetaGeoPlace; named: NamedPlace } | null }>();
export function _resetCopyRegionCache(): void {
  placeCache.clear();
}

export type GoogleCampaignPlaces = Coverage & {
  campaign_id: string;
  campaign_name: string | null;
  everywhere_reason?: "no_location_criteria" | "unnamed_place";
  has_exclusions?: true;
};

export async function readGoogleCampaignPlaces(tenant_id: string, objects: readonly AdObject[] = []): Promise<GoogleCampaignPlaces[]> {
  const live = objects.filter((o) => o.platform === "google" && o.active);
  const { gadsSearch } = await import("@/services/tools/google-ads/_client");
  const { readGooglePlaces } = await import("@/services/ad-locations/places");
  const [camps, goals, crit] = (await Promise.all([
    gadsSearch(tenant_id, "SELECT campaign.id, campaign.name, campaign.bidding_strategy_type FROM campaign WHERE campaign.status = 'ENABLED'", { complete: true }),
    gadsSearch(tenant_id, "SELECT campaign.id, campaign_conversion_goal.category, campaign_conversion_goal.biddable FROM campaign_conversion_goal WHERE campaign.status = 'ENABLED'", { complete: true }),
    gadsSearch(
      tenant_id,
      "SELECT campaign.id, campaign_criterion.location.geo_target_constant, campaign_criterion.negative FROM campaign_criterion WHERE campaign_criterion.type = 'LOCATION' AND campaign.status = 'ENABLED'",
      { complete: true },
    ),
  ])) as [
    Array<{ campaign?: { id?: string | number; name?: string; biddingStrategyType?: string } }>,
    Array<{ campaign?: { id?: string | number }; campaignConversionGoal?: { category?: string; biddable?: boolean } }>,
    Array<{ campaign?: { id?: string | number }; campaignCriterion?: { negative?: boolean; location?: { geoTargetConstant?: string } } }>,
  ];
  const bidding = new Map(camps.map((r) => [String(r.campaign?.id ?? ""), r.campaign?.biddingStrategyType ?? null]));
  const campaignNames = new Map(camps.map((r) => [String(r.campaign?.id ?? ""), r.campaign?.name ?? null]));
  const ids = new Set([...live.map((o) => o.id), ...[...bidding.keys()].filter(Boolean)]);
  const cats = new Map<string, string[]>();
  for (const r of goals) {
    const id = String(r.campaign?.id ?? "");
    if (r.campaignConversionGoal?.biddable !== true || !r.campaignConversionGoal.category) continue;
    cats.set(id, [...(cats.get(id) ?? []), r.campaignConversionGoal.category]);
  }
  const geo = new Map<string, number[]>();
  const unreadable = new Set<string>();
  const excludes = new Set<string>();
  for (const r of crit) {
    const id = String(r.campaign?.id ?? "");
    if (r.campaignCriterion?.negative === true) {
      excludes.add(id);
      continue;
    }
    const g = Number(String(r.campaignCriterion?.location?.geoTargetConstant ?? "").split("/").pop());
    if (!Number.isInteger(g) || g <= 0) unreadable.add(id);
    else geo.set(id, [...(geo.get(id) ?? []), g]);
  }
  const names = await readGooglePlaces(tenant_id, [...geo.values()].flat());
  const out: GoogleCampaignPlaces[] = [];
  for (const id of ids) {
    const targets = geo.get(id);
    const places: NamedPlace[] | "everywhere" = !targets?.length || unreadable.has(id)
      ? "everywhere"
      : targets.map((g) => {
          const p = names.get(g);
          if (!p) return { kind: "country" as const, country: "?" };
          const [head, tail] = p.name.split(",").map((x) => x.trim());
          if (p.kind === "Country") return { kind: "country" as const, country: p.country_code };
          if (p.kind === "State") return { kind: "state" as const, country: p.country_code, name: head };
          if (p.kind === "City") return { kind: "city" as const, country: p.country_code, name: head, ...(p.country_code === "US" ? { state: tail } : {}) };
          return { kind: "market" as const, country: p.country_code };
        });
    const unnamed = unreadable.has(id) || (Array.isArray(places) && places.some((p) => p.country === "?"));
    out.push({
      campaign_id: id,
      campaign_name: campaignNames.get(id) ?? live.find((o) => o.id === id)?.name ?? null,
      goals: googleGoalKeys(bidding.get(id), cats.get(id) ?? []),
      places: unnamed ? "everywhere" : places,
      ...(unnamed ? { everywhere_reason: "unnamed_place" as const } : places === "everywhere" ? { everywhere_reason: "no_location_criteria" as const } : {}),
      ...(excludes.has(id) ? { has_exclusions: true as const } : {}),
    });
  }
  return out;
}

async function googleCoverage(tenant_id: string, objects: readonly AdObject[]): Promise<Coverage[]> {
  return (await readGoogleCampaignPlaces(tenant_id, objects)).map(({ goals, places }) => ({ goals, places }));
}

async function resolveRegion(tenant_id: string, label: string, country: string, now: number): Promise<{ meta: MetaGeoPlace; named: NamedPlace } | null> {
  const key = `${tenant_id}|${country}|${label}`;
  const hit = placeCache.get(key);
  if (hit && now - hit.at < PLACE_TTL_MS) return hit.place;
  const { resolvePlaceDetailed } = await import("@/services/ad-locations/places");
  const { US_STATE_CODES } = await import("@/services/ad-locations/places");
  const t = label.trim().toLowerCase();
  const stateName = country === "US" ? Object.keys(US_STATE_CODES).find((n) => n.toLowerCase() === t || US_STATE_CODES[n]!.toLowerCase() === t) : undefined;
  const asState = !!stateName;
  let r = await resolvePlaceDetailed(tenant_id, "meta", stateName ?? label, country, asState ? "State" : undefined);
  if (r.status === "ambiguous" && asState) {
    const states = r.candidates.filter((c) => c.kind === "State");
    if (states.length === 1) r = { status: "resolved", place: states[0]! };
  }
  let place: { meta: MetaGeoPlace; named: NamedPlace } | null = null;
  if (r.status === "resolved") {
    const [type, k] = r.place.id.split(":");
    const [head, tail] = r.place.name.split(",").map((x) => x.trim());
    if ((type === "region" || type === "city") && k) {
      place = {
        meta: { type, key: k, name: r.place.name },
        named: type === "region" ? { kind: "state", country, name: head, key: k } : { kind: "city", country, name: head, state: tail, key: k },
      };
    }
  }
  placeCache.set(key, { at: now, place });
  return place;
}

async function readMetaTargets(tenant_id: string): Promise<Map<string, { goal: string | null; geo: GeoLocations | null }>> {
  const { metaAdsCreds, fbGetAllPages } = await import("@/services/tools/meta-ads/_client");
  const account = (await metaAdsCreds(tenant_id)).ad_account_id;
  type Row = { id?: string; optimization_goal?: string; promoted_object?: { custom_event_type?: string; custom_conversion_id?: string }; targeting?: { geo_locations?: GeoLocations } };
  const rows = await fbGetAllPages<Row>(tenant_id, `${account}/adsets`, { fields: "id,optimization_goal,promoted_object,targeting{geo_locations}", limit: 50 });
  const out = new Map<string, { goal: string | null; geo: GeoLocations | null }>();
  for (const r of rows) if (r.id) out.set(r.id, { goal: metaGoalKey(r.optimization_goal, r.promoted_object), geo: r.targeting?.geo_locations ?? null });
  return out;
}

export async function loadCopyRegions(tenant_id: string, inv: Inventory, now: Date = new Date(), metaTargets = readMetaTargets): Promise<CopyTargets> {
  const { topOrderLocations } = await import("@/services/ad-locations/service");
  const { businessCountry } = await import("@/services/ad-locations/country");
  const { US_STATE_CODES } = await import("@/services/ad-locations/places");
  const none: CopyTargets = { regions: [], goals: new Map() };
  const orders = (await topOrderLocations(tenant_id)).slice(0, MAX_REGIONS);
  if (orders.length === 0) return none;
  const country = await businessCountry(tenant_id);
  if (!country) return none;
  if (inv.google.unread) throw new Error("copy-regions: Google campaigns were not read this hour");
  const targets = await metaTargets(tenant_id);
  const metaObjects = inv.meta.objects.map((o) => {
    const t = targets.get(o.id);
    return t ? { ...o, goal: t.goal, geo: t.geo } : { ...o, goal: undefined, geo: undefined };
  });
  const coverage = [...metaCoverage(metaObjects), ...(inv.google.connected ? await googleCoverage(tenant_id, inv.google.objects) : [])];
  const out: CopyRegion[] = [];
  for (const o of orders) {
    const r = await resolveRegion(tenant_id, o.label, country.code, now.getTime());
    if (!r) continue;
    out.push({ label: o.label, share: o.share, place: r.named, meta: r.meta, covered_goals: coveredGoals(r.named, coverage, US_STATE_CODES) });
  }
  return { regions: out, goals: new Map([...targets].map(([id, t]) => [id, t.goal])) };
}

export type RegionRecheck = { ok: true } | { ok: false; why: string };

const LIVE_AD = new Set(["ACTIVE", "PENDING_REVIEW", "IN_PROCESS", "PREAPPROVED"]);

export type RecheckReads = {
  metaAdSets: (tenant_id: string) => Promise<
    Array<{
      id: string;
      name: string | null;
      campaign_name?: string | null;
      has_live_ads?: boolean | null;
      configured_status: string | null;
      optimization_goal?: string;
      promoted_object?: { custom_event_type?: string; custom_conversion_id?: string };
      geo: GeoLocations | null;
      campaign_id: string | null;
    }>
  >;
  google: (tenant_id: string) => Promise<Coverage[]>;
  country: (tenant_id: string) => Promise<string | null>;
  shape: (tenant_id: string) => Promise<string | null>;
};

export const defaultRecheckReads: RecheckReads = {
  metaAdSets: async (tenant_id) => {
    const { metaAdsCreds, fbGetAllPages } = await import("@/services/tools/meta-ads/_client");
    const account = (await metaAdsCreds(tenant_id)).ad_account_id;
    type Row = {
      id?: string;
      name?: string;
      campaign_id?: string;
      campaign?: { name?: string };
      ads?: { data?: Array<{ effective_status?: string }>; paging?: { next?: string } };
      configured_status?: string;
      optimization_goal?: string;
      promoted_object?: { custom_event_type?: string; custom_conversion_id?: string };
      targeting?: { geo_locations?: GeoLocations };
    };
    const rows = await fbGetAllPages<Row>(tenant_id, `${account}/adsets`, {
      fields: "id,name,campaign_id,campaign{name},configured_status,optimization_goal,promoted_object,targeting{geo_locations},ads.limit(100){effective_status}",
      limit: 50,
    });
    return rows
      .filter((r) => !!r.id)
      .map((r) => ({
        id: r.id!,
        name: r.name ?? null,
        campaign_id: r.campaign_id ?? null,
        campaign_name: r.campaign?.name ?? null,
        has_live_ads:
          !r.ads?.data || r.ads.paging?.next || r.ads.data.some((a) => !a.effective_status) ? null : r.ads.data.some((a) => LIVE_AD.has(a.effective_status!)),
        configured_status: r.configured_status ?? null,
        optimization_goal: r.optimization_goal,
        promoted_object: r.promoted_object,
        geo: r.targeting?.geo_locations ?? null,
      }));
  },
  google: async (tenant_id) => {
    const { gadsCustomerId } = await import("@/services/tools/google-ads/_client");
    try {
      await gadsCustomerId(tenant_id);
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (typeof code === "string" && (code.endsWith("_not_connected") || code === "google_ads_not_configured")) return [];
      throw e;
    }
    return googleCoverage(tenant_id, []);
  },
  country: async (tenant_id) => {
    const { businessCountry } = await import("@/services/ad-locations/country");
    return (await businessCountry(tenant_id))?.code ?? null;
  },
  shape: async (tenant_id) => (await import("./business-shape")).resolveBusinessShape(tenant_id),
};

export async function recheckRegionCopy(
  tenant_id: string,
  input: { level: "adset" | "campaign"; source_id: string; places: readonly MetaGeoPlace[]; tag: string },
  reads: RecheckReads = defaultRecheckReads,
): Promise<RegionRecheck> {
  try {
    const { US_STATE_CODES } = await import("@/services/ad-locations/places");
    if ((await reads.shape(tenant_id)) !== "marketplace") return { ok: false, why: "region copies are for marketplaces" };
    const country = await reads.country(tenant_id);
    if (!country) return { ok: false, why: "the business country is unknown" };
    const sets = await reads.metaAdSets(tenant_id);
    const mine = (s: (typeof sets)[number]) => (s.name ?? "").includes(input.tag) || (s.campaign_name ?? "").includes(input.tag);
    const on = (s: (typeof sets)[number]) =>
      s.configured_status !== "PAUSED" && s.configured_status !== "DELETED" && s.configured_status !== "ARCHIVED" && s.has_live_ads !== false && !mine(s);
    const sourceSets = input.level === "adset" ? sets.filter((s) => s.id === input.source_id) : sets.filter((s) => s.campaign_id === input.source_id && s.configured_status === "ACTIVE");
    const goals = new Set(sourceSets.map((s) => metaGoalKey(s.optimization_goal, s.promoted_object)));
    const goal = goals.size === 1 ? [...goals][0] : null;
    if (!goal) return { ok: false, why: "the source's goal is unknown or not one goal" };
    const coverage: Coverage[] = [
      ...sets.filter(on).map((s) => ({ goals: [metaGoalKey(s.optimization_goal, s.promoted_object) ?? ANY_GOAL], places: placesOfMetaGeo(s.geo) })),
      ...(await reads.google(tenant_id)),
    ];
    for (const p of input.places) {
      const [head, tail] = (p.name ?? "").split(",").map((x) => x.trim());
      const target: NamedPlace =
        p.type === "country"
          ? { kind: "country", country: p.key.toUpperCase() }
          : p.type === "region"
            ? { kind: "state", country, key: p.key, ...(head ? { name: head } : {}) }
            : { kind: "city", country, key: p.key, ...(head ? { name: head } : {}), ...(tail ? { state: tail } : {}) };
      if (target.kind === "country" || !target.name) return { ok: false, why: "the copy's place cannot be checked" };
      const covered = coveredGoals(target, coverage, US_STATE_CODES);
      if (covered.includes(ANY_GOAL) || covered.includes(goal)) return { ok: false, why: `${p.name ?? p.key} now has a live ad after the same result` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, why: `coverage could not be read: ${(e as Error).message.slice(0, 160)}` };
  }
}
