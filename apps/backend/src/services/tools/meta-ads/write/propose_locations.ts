
import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { isMetaAdsWriteEnabled } from "./_flag-check";
import {
  MAX_META_GEO_PLACES,
  metaGeoFingerprint,
  metaGeoPlaceSchema,
  metaPlaceFacts,
  metaPlacesOf,
  readMetaAdSetTargeting,
  replaceAdSetGeoBodySchema,
  unsupportedGeoKeys,
  type MetaPlaceFacts,
  type ReplaceAdSetGeoBody,
} from "./replace_ad_set_geo";

export const META_LOCATIONS_CLASS = "meta_ads.replace_ad_set_geo_review";

const inputSchema = z.object({
  ad_set_id: z.string().regex(/^[0-9]+$/).describe("The Meta ad set whose places change (from list_ad_sets)."),
  places: z
    .array(metaGeoPlaceSchema.omit({ name: true }))
    .min(1)
    .max(MAX_META_GEO_PLACES)
    .describe("Every place the ad set should show in after the change: {type: country|region|city, key}. Keys from Meta's place search (account_read targeting search). This REPLACES the current places."),
  rationale: rationaleInput(),
});

export type CountryRule = { allowed: ReadonlySet<string>; business: string | null; unread?: boolean };

export function allowedCountries(live: ReadonlyArray<Pick<MetaPlaceFacts, "country_code">>, business: string | null): CountryRule {
  if (live.some((p) => !p.country_code)) return { allowed: new Set(), business: null, unread: true };
  const allowed = new Set(live.map((p) => p.country_code!.toUpperCase()));
  if (business) allowed.add(business.toUpperCase());
  return { allowed, business: business ? business.toUpperCase() : null };
}

export function countryProblem(places: ReadonlyArray<MetaPlaceFacts>, rule: CountryRule): string | null {
  if (rule.unread) return "Zavi could not read which countries this ad set targets today, so no location change was proposed.";
  for (const p of places) {
    const label = p.name ?? p.key;
    if (!p.country_code) return `Zavi could not tell which country ${label} is in, so it was not proposed.`;
    if (!rule.allowed.has(p.country_code)) {
      const ok = [...rule.allowed].sort().join(", ") || "none";
      return `${label} is in ${p.country_code}, outside the countries this ad set may use (${ok}: the countries it targets today${rule.business ? " plus the business country" : ""}). Not proposed.`;
    }
  }
  return null;
}

export type AdRuleCheck = (tenant_id: string, places: ReadonlyArray<MetaPlaceFacts>) => Promise<string | null>;

export type RuleCanon = { level: "country" | "region" | "city"; country?: string; region?: string; city?: string; meta?: string };

export type RulePlaceReader = {
  metaFacts: typeof metaPlaceFacts;
  googleTargets: (tenant_id: string, ids: readonly string[]) => Promise<Map<string, { canonical: string; type: string; country_code: string | null }>>;
};

const liveRuleReader: RulePlaceReader = {
  metaFacts: metaPlaceFacts,
  googleTargets: async (tenant_id, ids) => {
    const out = new Map<string, { canonical: string; type: string; country_code: string | null }>();
    const clean = [...new Set(ids)].filter((x) => /^\d+$/.test(x));
    if (!clean.length) return out;
    const { gadsSearch } = await import("@/services/tools/google-ads/_client");
    for (let i = 0; i < clean.length; i += 100) {
      type Row = { geoTargetConstant?: { id?: string | number; canonicalName?: string; targetType?: string; countryCode?: string } };
      const rows = (await gadsSearch(
        tenant_id,
        `SELECT geo_target_constant.id, geo_target_constant.canonical_name, geo_target_constant.target_type, geo_target_constant.country_code FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${clean.slice(i, i + 100).map((id) => `'geoTargetConstants/${id}'`).join(", ")})`,
      )) as Row[];
      for (const r of rows) {
        const g = r.geoTargetConstant;
        if (g?.id && g.canonicalName) out.set(String(g.id), { canonical: g.canonicalName, type: g.targetType ?? "", country_code: /^[A-Za-z]{2}$/.test(g.countryCode ?? "") ? g.countryCode!.toUpperCase() : null });
      }
    }
    return out;
  },
};

export function canonOfFacts(p: MetaPlaceFacts, normalize: (s: string) => string): RuleCanon | null {
  if (!p.country_code) return null;
  const country = p.country_code.toLowerCase();
  const bare = (p.name ?? "").split(",")[0]!.trim();
  if (p.type === "country") return { level: "country", country, meta: `country:${p.key.toUpperCase()}` };
  if (p.type === "region") return { level: "region", country, region: normalize(bare || p.key), meta: `region:${p.key}` };
  return { level: "city", country, city: normalize(bare || p.key), ...(p.region_name ? { region: normalize(p.region_name) } : {}), meta: `city:${p.key}` };
}

export function ruleInside(p: RuleCanon, s: RuleCanon): boolean | null {
  if (p.meta && s.meta && p.meta === s.meta) return true;
  const depth = { country: 1, region: 2, city: 3 } as const;
  if (depth[p.level] < depth[s.level]) return false;
  if (!p.country || !s.country) return null;
  if (p.country !== s.country) return false;
  if (s.level === "country") return true;
  if (p.level === "region" && s.level === "region" && p.meta && s.meta) return false;
  if (s.level === "region") return p.region !== undefined && p.region === s.region ? true : null;
  return p.region !== undefined && p.region === s.region && p.city !== undefined && p.city === s.city ? true : null;
}

export function judgeRulePlace(p: RuleCanon, allowed: ReadonlyArray<RuleCanon | null>, blocked: ReadonlyArray<RuleCanon | null>): "ok" | "blocked" | "outside" | "unknown" {
  let unknown = false;
  for (const b of blocked) {
    if (!b) return "unknown";
    const a = ruleInside(p, b);
    const c = ruleInside(b, p);
    if (a === true || c === true) return "blocked";
    if (a === null || c === null) unknown = true;
  }
  if (allowed.length > 0) {
    if (allowed.some((x) => x === null)) return "unknown";
    const hits = allowed.map((x) => ruleInside(p, x!));
    if (hits.includes(true)) return unknown ? "unknown" : "ok";
    return hits.includes(null) || unknown ? "unknown" : "outside";
  }
  return unknown ? "unknown" : "ok";
}

export async function checkAdRulesWith(tenant_id: string, places: ReadonlyArray<MetaPlaceFacts>, reader: RulePlaceReader = liveRuleReader): Promise<string | null> {
  try {
    const { readAdGuard } = await import("@/services/rules/ad-guard");
    const guard = await readAdGuard(tenant_id);
    if (guard.allowed_places.length + guard.blocked_places.length === 0) return null;
    const { regionName, placeName } = await import("@/services/rules/ad-guard-match");
    const { parseMetaPlaceId } = await import("@/services/ad-locations/places");
    const norm = (s: string) => regionName(s) || placeName(s);
    const all = [...guard.allowed_places, ...guard.blocked_places];
    const metaIds = all.filter((g) => g.platform === "meta").map((g) => parseMetaPlaceId(g.id));
    const metaFacts = await reader.metaFacts(tenant_id, metaIds.filter((x): x is NonNullable<typeof x> => !!x));
    const metaBy = new Map(metaFacts.map((f) => [`${f.type}:${f.type === "country" ? f.key.toUpperCase() : f.key}`, f]));
    const google = await reader.googleTargets(tenant_id, all.filter((g) => g.platform === "google").map((g) => g.id));
    const canonOf = (g: (typeof all)[number]): RuleCanon | null => {
      if (g.platform === "meta") {
        const id = parseMetaPlaceId(g.id);
        const f = id ? metaBy.get(`${id.type}:${id.type === "country" ? id.key.toUpperCase() : id.key}`) : undefined;
        return f ? canonOfFacts(f, norm) : null;
      }
      const t = google.get(g.id);
      if (!t?.country_code) return null;
      const parts = t.canonical.split(",").map((x) => x.trim()).filter(Boolean);
      const country = t.country_code.toLowerCase();
      if (t.type === "Country") return { level: "country", country };
      if (t.type === "State" || t.type === "Province" || t.type === "Region") return { level: "region", country, region: norm(parts[0] ?? "") };
      if (t.type === "City") return { level: "city", country, city: norm(parts[0] ?? ""), ...(parts.length >= 3 ? { region: norm(parts[parts.length - 2]!) } : {}) };
      return null;
    };
    const allowed = guard.allowed_places.map(canonOf);
    const blocked = guard.blocked_places.map(canonOf);
    for (const p of places) {
      const canon = canonOfFacts(p, norm);
      const label = p.name ?? p.key;
      if (!canon) return `Zavi could not check ${label} against your saved ad rules, so it was not proposed.`;
      const v = judgeRulePlace(canon, allowed, blocked);
      if (v === "blocked") return `${label} is a place your saved ad rules say ads must never show in. Not proposed.`;
      if (v === "outside") return `${label} is outside the area your saved ad rules allow. Not proposed.`;
      if (v === "unknown") return `Zavi could not check ${label} against your saved ad rules, so it was not proposed.`;
    }
    return null;
  } catch {
    return "Zavi could not read your saved ad rules just now, so no location change was proposed. Try again later.";
  }
}

export const checkAdRules: AdRuleCheck = (tenant_id, places) => checkAdRulesWith(tenant_id, places);

export type ProposeLocationDeps = {
  readTargeting: typeof readMetaAdSetTargeting;
  placeFacts: typeof metaPlaceFacts;
  businessCountry: (tenant_id: string) => Promise<string | null>;
  adRules: AdRuleCheck;
  dailyBudget: (tenant_id: string, ad_set_id: string) => Promise<{ object_daily_budget?: number; currency?: string }>;
};

const liveDeps: ProposeLocationDeps = {
  readTargeting: readMetaAdSetTargeting,
  placeFacts: metaPlaceFacts,
  businessCountry: async (tenant_id) => (await (await import("@/services/ad-locations/country")).businessCountry(tenant_id))?.code ?? null,
  adRules: checkAdRules,
  dailyBudget: async (tenant_id, ad_set_id) => (await import("@/services/tools/_object-daily-budget")).metaObjectDailyBudget(tenant_id, ad_set_id),
};

const refuse = (msg: string): never => {
  throw new ExpectedToolError("meta_ads_locations_refused", msg);
};

export async function buildLocationProposal(tenant_id: string, raw: unknown, deps: ProposeLocationDeps = liveDeps): Promise<ReplaceAdSetGeoBody> {
  const input = inputSchema.parse(raw);
  const { name: liveName, targeting } = await deps.readTargeting(tenant_id, input.ad_set_id);
  const geo = targeting.geo_locations;
  if (unsupportedGeoKeys(geo).length) refuse("This ad set targets postcodes, pins or areas Zavi can't edit, so change its places in Meta Ads Manager. Not proposed.");
  const seen = new Set<string>();
  const unique = input.places.filter((p) => {
    const k = `${p.type}:${p.type === "country" ? p.key.toUpperCase() : p.key}`;
    return !seen.has(k) && (seen.add(k), true);
  });
  const livePlaces = metaPlacesOf(geo);
  const keys = (xs: ReadonlyArray<{ type: string; key: string }>) => xs.map((p) => `${p.type}:${p.type === "country" ? p.key.toUpperCase() : p.key}`).sort().join(",");
  if (keys(unique) === keys(livePlaces)) refuse("These are the places the ad set already shows in. Not proposed.");
  let liveFacts: MetaPlaceFacts[];
  let proposed: MetaPlaceFacts[];
  try {
    [liveFacts, proposed] = await Promise.all([deps.placeFacts(tenant_id, livePlaces), deps.placeFacts(tenant_id, unique)]);
  } catch (e) {
    if (e instanceof ExpectedToolError) throw e;
    throw new ExpectedToolError("meta_ads_locations_unverified", "Zavi couldn't check these places with Meta just now. Not proposed; try again later.");
  }
  const country = countryProblem(proposed, allowedCountries(liveFacts, await deps.businessCountry(tenant_id).catch(() => null)));
  if (country) refuse(country);
  const rules = await deps.adRules(tenant_id, proposed);
  if (rules) refuse(rules);
  const budget = await deps.dailyBudget(tenant_id, input.ad_set_id).catch(() => ({}) as { object_daily_budget?: number; currency?: string });
  const name = liveName ?? undefined;
  return replaceAdSetGeoBodySchema.parse({
    ad_set_id: input.ad_set_id,
    places: proposed.map(({ country_code: _c, region_name: _r, ...p }) => p),
    before_names: liveFacts.map((p) => p.name ?? p.key),
    before_places: liveFacts.map(({ country_code: _c, region_name: _r, ...p }) => p),
    expected_fingerprint: metaGeoFingerprint(geo),
    ...(name ? { name: name.slice(0, 255) } : {}),
    rationale: input.rationale,
    over_cap: true,
    origin: "zavi_location_proposal",
    ...(budget.object_daily_budget ? { budget_daily: budget.object_daily_budget } : {}),
    ...(budget.object_daily_budget && budget.currency && /^[A-Z]{3}$/.test(budget.currency) ? { budget_currency: budget.currency } : {}),
  });
}

export async function recheckLocationChange(tenant_id: string, body: ReplaceAdSetGeoBody, deps: ProposeLocationDeps = liveDeps): Promise<string | null> {
  if (body.origin !== "zavi_location_proposal" && body.origin !== "zavi_location_undo") return null;
  try {
    const proposed = await deps.placeFacts(tenant_id, body.places.map(({ type, key }) => ({ type, key })));
    if (body.origin === "zavi_location_proposal") {
      const { targeting } = await deps.readTargeting(tenant_id, body.ad_set_id);
      const live = await deps.placeFacts(tenant_id, metaPlacesOf(targeting.geo_locations));
      const country = countryProblem(proposed, allowedCountries(live, await deps.businessCountry(tenant_id)));
      if (country) return country;
    }
    return await deps.adRules(tenant_id, proposed);
  } catch {
    return "Zavi could not check this location change against the allowed countries and your saved ad rules just now, so nothing was changed. Approve it again later.";
  }
}

export function locationToolResult(id: string, body: ReplaceAdSetGeoBody): Record<string, unknown> {
  const places = body.places.map((p) => p.name ?? p.key);
  if (id === "channel_action_suppressed") return { filed: false, suppressed: true, places };
  return { decision_id: id, decision_class: META_LOCATIONS_CLASS, places, waits_for: "an owner or admin" };
}

export const metaProposeLocationsTool: ToolSpec = {
  name: "meta_ads_propose_locations",
  effect: "write",
  description:
    "Propose new places for ONE Meta ad set (countries, regions, cities; replaces its current places) as a card an owner or admin approves. The budget never changes. Places must be in the countries the ad set targets today or the business country, and never where the saved ad rules rule out; anything else is refused.",
  input_schema: inputSchema,
  async execute(ctx, rawInput) {
    if (!(await isMetaAdsWriteEnabled())) throw new ExpectedToolError("meta_ads_write_disabled", "Meta Ads write is disabled at the platform level.");
    if (typeof ctx.emit_decision !== "function") throw new ExpectedToolError("meta_ads_propose_no_emit", "Cannot emit a decision in this context (no emit_decision plumbed).");
    if ((ctx as { meta_rail?: unknown }).meta_rail !== "channel_actions") {
      throw new ExpectedToolError("meta_ads_locations_wrong_run", "A location change can only be proposed from a Meta Ads channel run, as a channel card. Nothing was written.");
    }
    const body = await buildLocationProposal(ctx.tenant_id, rawInput);
    return locationToolResult(await ctx.emit_decision(META_LOCATIONS_CLASS, body), body);
  },
};
