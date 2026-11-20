
import type { OwnedComposioAccount } from "@/services/connectors/composio/api";
import { ExpectedToolError } from "@/services/tools/types";
import { tt } from "./composio-read";

export type TiktokGeoLevel = "COUNTRY" | "PROVINCE" | "CITY" | "DISTRICT" | "DMA" | "ZIP_CODE";
export type TiktokPlace = { location_id: string; name: string; level: TiktokGeoLevel; country_code: string };

const LAUNCH_GEO = { objective_type: "TRAFFIC", placements: ["PLACEMENT_TIKTOK"], promotion_type: "WEBSITE" } as const;
const SEARCH_LEVELS: TiktokGeoLevel[] = ["COUNTRY", "PROVINCE", "CITY", "DMA"];
const MAX_IDS = 1000;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const q = (v: unknown) => encodeURIComponent(typeof v === "string" ? v : JSON.stringify(v));
const bad = () => new ExpectedToolError("tiktok_ads_bad_response", "TikTok returned an invalid location answer. Try again later.");

export async function listTiktokCountries(account: OwnedComposioAccount, advertiserId: string): Promise<TiktokPlace[]> {
  const data = await tt(account, `/tool/region/?advertiser_id=${q(advertiserId)}&objective_type=${LAUNCH_GEO.objective_type}&placements=${q(LAUNCH_GEO.placements)}&promotion_type=${LAUNCH_GEO.promotion_type}&level_range=TO_COUNTRY`);
  const rows = Array.isArray(data.region_info) ? data.region_info : Array.isArray(data.list) ? data.list : null;
  if (!rows) throw bad();
  const out: TiktokPlace[] = [];
  for (const r of rows) {
    if (!isRecord(r) || r.level !== "COUNTRY") continue;
    const location_id = str(r.location_id);
    const country_code = str(r.region_code);
    const name = str(r.name);
    if (location_id && country_code && name) out.push({ location_id, name, level: "COUNTRY", country_code });
  }
  return out;
}

type Tag = { geo: TiktokPlace & { parent_id: string | null }; enabled: boolean };

function tagOf(r: unknown): Tag | null {
  if (!isRecord(r) || r.targeting_type !== "GEO" || !isRecord(r.geo)) return null;
  const location_id = str(r.geo.geo_id);
  const level = str(r.geo.geo_type) as TiktokGeoLevel | null;
  const name = str(r.name);
  const country_code = str(r.geo.region_code);
  if (!location_id || !level || !name || !country_code) return null;
  const status = isRecord(r.status_info) ? r.status_info.status : null;
  return { geo: { location_id, name, level, country_code, parent_id: str(r.geo.parent_id) }, enabled: status === "ENABLED" };
}

export function placeLabel(tag: Tag["geo"], parents: Map<string, Tag["geo"]>): string {
  const parts = [tag.name];
  let p = tag.parent_id ? parents.get(tag.parent_id) : undefined;
  for (let i = 0; p && i < 4; i++) {
    if (p.name !== parts[parts.length - 1]) parts.push(p.name);
    p = p.parent_id ? parents.get(p.parent_id) : undefined;
  }
  return parts.join(", ");
}

function parse(data: Record<string, unknown>): { tags: Tag[]; parents: Map<string, Tag["geo"]> } {
  if (!Array.isArray(data.targeting_tag_list)) throw bad();
  const parents = new Map<string, Tag["geo"]>();
  for (const r of Array.isArray(data.parent_tags) ? data.parent_tags : []) {
    const t = tagOf(r);
    if (t) parents.set(t.geo.location_id, t.geo);
  }
  const tags = data.targeting_tag_list.map(tagOf).filter((t): t is Tag => t !== null);
  for (const t of tags) parents.set(t.geo.location_id, t.geo);
  return { tags, parents };
}

export async function searchTiktokLocations(account: OwnedComposioAccount, advertiserId: string, query: string, countryCode?: string): Promise<TiktokPlace[]> {
  const keyword = query.trim().slice(0, 100);
  if (keyword.length < 2) return [];
  const data = await tt(account, "/tool/targeting/search/", {
    advertiser_id: advertiserId,
    ...LAUNCH_GEO,
    search_type: "FUZZY_SEARCH",
    keywords: [keyword],
    geo_types: SEARCH_LEVELS,
    ...(countryCode ? { region_codes: [countryCode.toUpperCase()] } : {}),
  });
  const { tags, parents } = parse(data);
  return tags.filter((t) => t.enabled).map((t) => ({ location_id: t.geo.location_id, name: placeLabel(t.geo, parents), level: t.geo.level, country_code: t.geo.country_code }));
}

export async function verifyTiktokLocations(account: OwnedComposioAccount, advertiserId: string, ids: string[]): Promise<TiktokPlace[]> {
  const want = [...new Set(ids)];
  if (want.length === 0) return [];
  if (want.length > MAX_IDS) throw new ExpectedToolError("tiktok_ads_location_not_allowed", `A launch names at most ${MAX_IDS} places.`);
  const { tags, parents } = parse(await tt(account, "/tool/targeting/info/", { advertiser_id: advertiserId, scene: "GEO", targeting_ids: want, ...LAUNCH_GEO }));
  const byId = new Map(tags.map((t) => [t.geo.location_id, t]));
  const refused = want.filter((id) => !byId.get(id)?.enabled);
  if (refused.length) {
    const why = refused.map((id) => `${id}${byId.has(id) ? ` (${byId.get(id)!.geo.name}: not targetable on this ad account)` : " (unknown to TikTok)"}`).join(", ");
    throw new ExpectedToolError("tiktok_ads_location_not_allowed", `TikTok does not let this ad account target ${why}. Fix: pick places from tiktok_ads_search_locations.`, { fix: "pick places from tiktok_ads_search_locations." });
  }
  return want.map((id) => {
    const t = byId.get(id)!;
    return { location_id: id, name: placeLabel(t.geo, parents), level: t.geo.level, country_code: t.geo.country_code };
  });
}

export async function readTiktokLocationNames(account: OwnedComposioAccount, advertiserId: string, ids: string[]): Promise<Record<string, string>> {
  const want = [...new Set(ids)];
  if (!want.length) return {};
  if (want.length > MAX_IDS) throw bad();
  const { tags, parents } = parse(await tt(account, "/tool/targeting/info/", { advertiser_id: advertiserId, scene: "GEO", targeting_ids: want, ...LAUNCH_GEO }));
  return Object.fromEntries(tags.filter(t => want.includes(t.geo.location_id)).map(t => [t.geo.location_id, placeLabel(t.geo, parents)]));
}

export async function searchTiktokLocationsLocalFirst(account: OwnedComposioAccount, advertiserId: string, query: string, countryCode?: string): Promise<TiktokPlace[]> {
  const everywhere = searchTiktokLocations(account, advertiserId, query);
  const local = countryCode ? await searchTiktokLocations(account, advertiserId, query, countryCode) : [];
  const seen = new Set(local.map((p) => p.location_id));
  const rows = [...local, ...(await everywhere).filter((p) => !seen.has(p.location_id))];
  const typed = query.trim().toLowerCase();
  const rank = (p: TiktokPlace) => (p.name.toLowerCase().split(",")[0].trim() === typed ? 0 : p.name.toLowerCase().startsWith(typed) ? 1 : 2);
  return rows.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map((x) => x.p);
}

export const placeKind = (level: TiktokGeoLevel): "Country" | "State" | "City" | "Region" => (level === "COUNTRY" ? "Country" : level === "PROVINCE" ? "State" : level === "CITY" || level === "DISTRICT" ? "City" : "Region");

export async function searchTiktokPlacesForTenant(tenantId: string, query: string, countryCode?: string, advertiserId?: string): Promise<Array<TiktokPlace & { kind: ReturnType<typeof placeKind> }>> {
  const { tiktokAdsAccount } = await import("./composio-read");
  const { ensureAdAccounts } = await import("./ad-accounts");
  const [account, state] = await Promise.all([tiktokAdsAccount(tenantId), ensureAdAccounts(tenantId)]);
  const selected = advertiserId ?? state.selected_id;
  if (!selected) throw new ExpectedToolError("tiktok_ads_account_not_chosen", "No TikTok ad account is chosen for Zavi. Choose it on the TikTok Ads channel page.");
  if (!state.connected || !state.accounts.some(a => a.advertiser_id === selected)) throw new ExpectedToolError("tiktok_ads_unknown_account", "That advertiser is not connected to this workspace.");
  const rows = await searchTiktokLocationsLocalFirst(account, selected, query, countryCode);
  return rows.map((p) => ({ ...p, kind: placeKind(p.level) }));
}
