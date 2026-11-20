import { z } from "zod";
import {
  LINKEDIN_AUDIENCE_FACETS, LINKEDIN_AUDIENCE_URNS, LINKEDIN_AUDIENCE_LABELS,
  linkedinAudienceSchema, type LinkedInAudience, type LinkedInAudienceOption,
} from "@zavi/shared";
import { ExpectedToolError } from "@/services/tools/types";
import { getAccountBinding } from "@/services/ads-wallet/bindings";
import { resolveLinkedinAccount } from "@/services/ads-wallet/adapters/linkedin-account";
import { linkedinAdsToken, listLinkedInAdAccounts } from "./client";
import { linkedinAdsGet } from "./http";
import { readAction, assertReviewable } from "./action-read";

const fail = (): never => { throw new ExpectedToolError("linkedin_ads_targeting_invalid", "LinkedIn could not verify the selected audience. Search again and choose its current targeting options."); };
const entitySchema = z.object({ urn: z.string(), name: z.string().min(1).max(300), facetUrn: z.string(), isTargetable: z.boolean().optional() });

export async function linkedinTargetingToken(tenantId: string, accountId: string, bindingId?: string) {
  if (bindingId) {
    const binding = await getAccountBinding(tenantId, bindingId);
    const resolved = await resolveLinkedinAccount(tenantId, binding);
    if (resolved.account.id !== accountId) return fail();
    return resolved.token;
  }
  const accounts = await listLinkedInAdAccounts(tenantId);
  if (!accounts.some(a => a.id === accountId)) return fail();
  return linkedinAdsToken(tenantId);
}

export const linkedinTargetingSearchSchema = z.object({
  facet: z.enum(LINKEDIN_AUDIENCE_FACETS), query: z.string().trim().max(120).default(""),
  account_id: z.string().regex(/^\d{1,20}$/), account_binding_id: z.string().uuid().optional(),
}).strict();

export async function searchLinkedinTargeting(tenantId: string, actionId: string, input: unknown) {
  const ask = linkedinTargetingSearchSchema.parse(input);
  assertReviewable(await readAction(tenantId, actionId));
  const typeahead = ask.facet === "titles" || ask.facet === "industries";
  if (typeahead && ask.query.length < 2)
    throw new ExpectedToolError("linkedin_ads_targeting_invalid", "Enter at least two characters to search LinkedIn.");
  const token = await linkedinTargetingToken(tenantId, ask.account_id, ask.account_binding_id);
  const response = await linkedinAdsGet<{ elements?: unknown[] }>(token, "adTargetingEntities", {
    q: typeahead ? "typeahead" : "adTargetingFacet", facet: `urn:li:adTargetingFacet:${ask.facet}`,
    queryVersion: "QUERY_USES_URNS", locale: { language: "en", country: "US" },
    ...(typeahead ? { query: ask.query } : {}),
  });
  if (!Array.isArray(response.elements)) return fail();
  const options: LinkedInAudienceOption[] = [];
  for (const raw of response.elements) {
    const parsed = entitySchema.safeParse(raw);
    if (!parsed.success) return fail();
    const e = parsed.data;
    if (e.facetUrn !== `urn:li:adTargetingFacet:${ask.facet}` || !LINKEDIN_AUDIENCE_URNS[ask.facet].test(e.urn)) return fail();
    if (e.isTargetable === false || (!typeahead && ask.query && !e.name.toLowerCase().includes(ask.query.toLowerCase()))) continue;
    if (!options.some(o => o.urn === e.urn)) options.push({ urn: e.urn, name: e.name });
  }
  return { options: options.slice(0, 20) };
}

export async function verifyLinkedinAudience(token: string, raw: unknown): Promise<{ audience: LinkedInAudience; rows: Array<{ item: string; before: string; after: string }> }> {
  const audience = linkedinAudienceSchema.parse(raw);
  const urns = [...new Set(LINKEDIN_AUDIENCE_FACETS.flatMap(f => audience[f]))];
  if (!urns.length) return { audience, rows: [] };
  const response = await linkedinAdsGet<{ elements?: unknown[] }>(token, "adTargetingEntities", { q: "urns", urns, queryVersion: "QUERY_USES_URNS", locale: { language: "en", country: "US" } });
  if (!Array.isArray(response.elements)) return fail();
  const entities = response.elements.map(e => entitySchema.parse(e));
  const rows = [];
  for (const facet of LINKEDIN_AUDIENCE_FACETS) {
    audience[facet] = [...new Set(audience[facet])];
    const names = audience[facet].map(urn => {
      const matches = entities.filter(e => e.urn === urn && e.facetUrn === `urn:li:adTargetingFacet:${facet}` && e.isTargetable !== false);
      if (matches.length !== 1) return fail();
      return matches[0].name;
    });
    rows.push({ item: LINKEDIN_AUDIENCE_LABELS[facet], before: "Not chosen", after: names.length ? names.join(" or ") : "Not restricted" });
  }
  return { audience, rows };
}

const LOCATIONS_FACET = "urn:li:adTargetingFacet:locations";
const failLocations = (): never => { throw new ExpectedToolError("linkedin_ads_targeting_invalid", "LinkedIn could not verify the selected locations. Search again and choose current locations."); };
const LOCATION_URN = /^urn:li:geo:\d+$/;
const EU_PLACES = new Set([
  "austria", "belgium", "bulgaria", "croatia", "cyprus", "czechia", "czech republic", "denmark", "estonia", "finland",
  "france", "germany", "greece", "hungary", "ireland", "italy", "latvia", "lithuania", "luxembourg", "malta",
  "netherlands", "poland", "portugal", "romania", "slovakia", "slovenia", "spain", "sweden", "iceland", "liechtenstein", "norway",
  "réunion", "reunion", "french guiana", "guadeloupe", "martinique", "mayotte", "st. martin", "saint martin", "saint-martin",
  "åland islands", "aland islands", "ceuta & melilla", "ceuta", "melilla", "canary islands", "azores", "madeira",
  "europe", "european union", "european economic area", "eurozone", "emea", "benelux", "dach", "nordics", "scandinavia",
  "africa", "south america", "latin america", "latam", "americas", "caribbean", "atlantic",
]);

export function linkedinLocationInEu(name: string) {
  const parts = name.split(",").map(p => p.trim().toLowerCase());
  return EU_PLACES.has(parts[parts.length - 1]) || /\beurope\b/i.test(name);
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const COUNTRY_NAMES = new Set(["hong kong", "macau", "turkey", "taiwan"]);
for (let a = 65; a < 91; a++) for (let b = 65; b < 91; b++) {
  const code = String.fromCharCode(a, b);
  try { const name = regionNames.of(code); if (name && name !== code) COUNTRY_NAMES.add(name.toLowerCase()); } catch { continue; }
}
const NON_EU_REGIONS = new Set(["asia", "north america", "central america", "oceania", "middle east", "asia pacific", "apac"]);

export function linkedinLocationIncludable(name: string) {
  if (linkedinLocationInEu(name)) return false;
  const last = name.split(",").pop()!.trim().toLowerCase();
  return COUNTRY_NAMES.has(last) || NON_EU_REGIONS.has(name.trim().toLowerCase());
}

export const linkedinLocationSearchSchema = z.object({
  q: z.string().trim().min(2).max(120),
  account_id: z.string().regex(/^\d{1,20}$/), account_binding_id: z.string().uuid().optional(),
}).strict();

async function locationTypeahead(token: string, query: string) {
  const response = await linkedinAdsGet<{ elements?: unknown[] }>(token, "adTargetingEntities", {
    q: "typeahead", facet: LOCATIONS_FACET, queryVersion: "QUERY_USES_URNS", locale: { language: "en", country: "US" }, query,
  });
  if (!Array.isArray(response.elements)) return failLocations();
  const locations: Array<{ id: string; name: string }> = [];
  for (const raw of response.elements) {
    const parsed = entitySchema.safeParse(raw);
    if (!parsed.success || parsed.data.facetUrn !== LOCATIONS_FACET || !LOCATION_URN.test(parsed.data.urn)) return failLocations();
    if (parsed.data.isTargetable === false || locations.some(l => l.id === parsed.data.urn)) continue;
    locations.push({ id: parsed.data.urn, name: parsed.data.name });
  }
  return locations.slice(0, 20);
}

export async function searchLinkedinLocations(tenantId: string, actionId: string, input: unknown) {
  const ask = linkedinLocationSearchSchema.parse(input);
  assertReviewable(await readAction(tenantId, actionId));
  const rows = await locationTypeahead(await linkedinTargetingToken(tenantId, ask.account_id, ask.account_binding_id), ask.q);
  return { locations: rows.map(r => ({ ...r, eu: linkedinLocationInEu(r.name), includable: linkedinLocationIncludable(r.name) })) };
}

export async function resolveLinkedinLocationNames(token: string, names: string[]) {
  const wanted = [...new Set(names.map(n => n.trim()).filter(n => n.length >= 2))].slice(0, 10);
  const picks = await Promise.all(wanted.map(async name => {
    const rows = await locationTypeahead(token, name);
    const want = name.toLowerCase();
    const pool = want.includes(",")
      ? rows.filter(r => r.name.toLowerCase() === want)
      : rows.filter(r => r.name.split(",")[0].trim().toLowerCase() === want);
    return pool.length === 1 ? pool[0] : undefined;
  }));
  const found: Array<{ id: string; name: string }> = [];
  const missed: string[] = [];
  picks.forEach((pick, i) => {
    if (!pick) missed.push(wanted[i]);
    else if (!found.some(f => f.id === pick.id)) found.push(pick);
  });
  return { found, missed };
}

export async function verifyLinkedinLocations(token: string, urns: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(urns)];
  if (!unique.length) return new Map();
  if (unique.some(u => !LOCATION_URN.test(u))) return failLocations();
  const response = await linkedinAdsGet<{ elements?: unknown[] }>(token, "adTargetingEntities", { q: "urns", urns: unique, queryVersion: "QUERY_USES_URNS", locale: { language: "en", country: "US" } });
  if (!Array.isArray(response.elements)) return failLocations();
  const names = new Map<string, string>();
  for (const raw of response.elements) {
    const e = entitySchema.safeParse(raw);
    if (e.success && e.data.facetUrn === LOCATIONS_FACET && e.data.isTargetable !== false && unique.includes(e.data.urn)) names.set(e.data.urn, e.data.name);
  }
  if (unique.some(u => !names.has(u))) return failLocations();
  return names;
}
