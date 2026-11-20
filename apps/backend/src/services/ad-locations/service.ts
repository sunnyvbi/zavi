
import { asTenantId, tenantClient, tenantRpc, type TenantId } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { gadsGetCampaign } from "@/services/tools/google-ads/_client";
import {
  GEO_LEVEL_BY_CHANNEL_TYPE,
  MAX_GEO_PLACES,
  geoFingerprint,
  geoShape,
  liveGeoIds,
  readGoogleGeoTargets,
  type ReplaceGeoTargetsBody,
} from "@/services/tools/google-ads/write/replace_geo_targets";
import {
  metaGeoFingerprint,
  metaPlacesOf,
  readMetaAdSetTargeting,
  unsupportedGeoKeys,
  verifyMetaPlaces,
  type ReplaceAdSetGeoBody,
} from "@/services/tools/meta-ads/write/replace_ad_set_geo";
import { businessAddress, businessCountry, countryName, type Country } from "./country";
import {
  googlePlaceNames,
  metaDisplayPlaces,
  parseMetaPlaceId,
  readGooglePlaces,
  resolvePlace,
  searchPlatformPlaces,
  type AdPlace,
  type AdPlatform,
} from "./places";

export type AdLocationChannel = "google_ads" | "youtube_ads" | "meta_ads";
export const AD_LOCATION_CHANNELS: readonly AdLocationChannel[] = ["google_ads", "youtube_ads", "meta_ads"];
export const isAdLocationChannel = (s: string): s is AdLocationChannel => (AD_LOCATION_CHANNELS as readonly string[]).includes(s);

export const MAX_PLACES = MAX_GEO_PLACES;

const CHANNEL: Record<AdLocationChannel, { platform: AdPlatform; create_class: string; label: string }> = {
  google_ads: { platform: "google", create_class: "google_ads.create_campaign", label: "Google Ads" },
  youtube_ads: { platform: "google", create_class: "google_ads.create_campaign", label: "YouTube Ads" },
  meta_ads: { platform: "meta", create_class: "meta_ads.create_ad_set", label: "Meta Ads" },
};

export const channelLabel = (c: AdLocationChannel) => CHANNEL[c].label;

export function createBelongsTo(channel: AdLocationChannel, channelType: string | null): boolean {
  if (channel === "meta_ads") return true;
  return channel === "youtube_ads" ? channelType === "DEMAND_GEN" : channelType !== "DEMAND_GEN";
}

export type CgoCampaign = { channel: AdLocationChannel; platform: AdPlatform; object_id: string; name: string | null; launched_at: string };

type LaunchRow = { id: string; at: string | null; channel_type: string | null; name: string | null };

export async function newestCgoCampaign(tenant_id: string, channel: AdLocationChannel): Promise<CgoCampaign | null> {
  const db = tenantClient(asTenantId(tenant_id));
  const cls = CHANNEL[channel].create_class;
  const byType = <Q extends { eq: (k: string, v: unknown) => Q; neq: (k: string, v: unknown) => Q }>(q: Q, col: string): Q =>
    channel === "meta_ads" ? q : channel === "youtube_ads" ? q.eq(`${col}->>channel_type`, "DEMAND_GEN") : q.neq(`${col}->>channel_type`, "DEMAND_GEN");
  const [dec, act] = await Promise.all([
    byType(
      db
        .from("decisions")
        .select("id, dispatched_at, channel_type:body->>channel_type, name:body->>name")
        .eq("status", "acted")
        .eq("approved_by_source", "cgo")
        .eq("decision_class", cls),
      "body",
    )
      .order("dispatched_at", { ascending: false })
      .limit(10),
    byType(
      db
        .from("channel_actions")
        .select("id, executed_at, channel_type:exec_payload->>channel_type, name:exec_payload->>name")
        .eq("exec_status", "executed")
        .eq("approved_by_source", "cgo")
        .eq("exec_class", cls),
      "exec_payload",
    )
      .order("executed_at", { ascending: false })
      .limit(10),
  ]);
  if (dec.error) throw new Error(`decisions read failed: ${dec.error.message}`);
  if (act.error) throw new Error(`channel_actions read failed: ${act.error.message}`);
  const rows: LaunchRow[] = [
    ...((dec.data ?? []) as Array<Record<string, string | null>>).map((r) => ({ id: String(r.id), at: r.dispatched_at ?? null, channel_type: r.channel_type ?? null, name: r.name ?? null })),
    ...((act.data ?? []) as Array<Record<string, string | null>>).map((r) => ({ id: String(r.id), at: r.executed_at ?? null, channel_type: r.channel_type ?? null, name: r.name ?? null })),
  ]
    .filter((r) => r.at && createBelongsTo(channel, r.channel_type))
    .sort((a, b) => (a.at! < b.at! ? 1 : a.at! > b.at! ? -1 : 0));
  if (rows.length === 0) return null;
  const { data: holds, error } = await db
    .from("ad_budget_reservations")
    .select("idem_key, object_id")
    .in("idem_key", rows.map((r) => `${r.id}:create`));
  if (error) throw new Error(`ad budget holds read failed: ${error.message}`);
  const objectOf = new Map(((holds ?? []) as Array<{ idem_key: string; object_id: string | null }>).map((h) => [h.idem_key, h.object_id]));
  for (const r of rows) {
    const object_id = objectOf.get(`${r.id}:create`);
    if (object_id && /^[0-9]{1,64}$/.test(object_id)) {
      return { channel, platform: CHANNEL[channel].platform, object_id, name: r.name, launched_at: r.at! };
    }
  }
  return null;
}

export type LivePlaces = {
  targeting: "single" | "mixed" | "unsupported";
  places: AdPlace[];
  country_wide: Country | null;
  fingerprint: string;
  google?: { level: "campaign" | "ad_group"; ad_groups: number };
};

const plain = (p: AdPlace): AdPlace => ({ id: p.id, name: p.name, kind: p.kind, ...(p.source ? { source: p.source } : {}), ...(p.reason ? { reason: p.reason } : {}) });

export async function readLivePlaces(tenant_id: string, c: CgoCampaign): Promise<LivePlaces> {
  if (c.platform === "google") {
    const live = await gadsGetCampaign(tenant_id, c.object_id);
    const level = GEO_LEVEL_BY_CHANNEL_TYPE[live.channel_type];
    if (!level) return { targeting: "unsupported", places: [], country_wide: null, fingerprint: "" };
    const targets = await readGoogleGeoTargets(tenant_id, live, level);
    const ids = liveGeoIds(targets);
    const shape = geoShape(targets);
    const named = await googlePlaceNames(tenant_id, ids);
    const only = shape === "single" && named.length === 1 && named[0].kind === "Country" && named[0].country_code ? named[0].country_code : null;
    return {
      targeting: shape === "none" ? "unsupported" : shape,
      places: named.map(plain),
      country_wide: only ? { code: only, name: countryName(only) } : null,
      fingerprint: geoFingerprint(targets),
      google: { level, ad_groups: level === "ad_group" ? targets.owners.length : 0 },
    };
  }
  const { targeting } = await readMetaAdSetTargeting(tenant_id, c.object_id);
  const geo = targeting.geo_locations;
  const places = metaPlacesOf(geo);
  const only = places.length === 1 && places[0].type === "country" ? places[0].key : null;
  return {
    targeting: unsupportedGeoKeys(geo).length ? "unsupported" : "single",
    places: metaDisplayPlaces(places),
    country_wide: only ? { code: only, name: countryName(only) } : null,
    fingerprint: metaGeoFingerprint(geo),
  };
}

export type ChoiceRow = { state: "noted" | "country" | "places"; places: AdPlace[]; decision_id: string | null };

export async function readChoice(tenant_id: string, c: Pick<CgoCampaign, "platform" | "object_id">): Promise<ChoiceRow | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("ad_location_choices")
    .select("state, places, decision_id")
    .eq("platform", c.platform)
    .eq("object_id", c.object_id)
    .maybeSingle();
  if (error) throw new Error(`ad location choice read failed: ${error.message}`);
  if (!data) return null;
  const r = data as { state: ChoiceRow["state"]; places: unknown; decision_id: string | null };
  return { state: r.state, places: Array.isArray(r.places) ? (r.places as AdPlace[]) : [], decision_id: r.decision_id };
}

async function writeChoice(
  tenant_id: string,
  c: Pick<CgoCampaign, "channel" | "platform" | "object_id">,
  row: { state: ChoiceRow["state"]; places: AdPlace[]; decision_id: string | null; chosen_by: string | null },
): Promise<void> {
  if (row.places.length > MAX_PLACES) throw new ExpectedToolError("ad_locations_too_many", `Pick up to ${MAX_PLACES} places.`);
  const { error } = await tenantClient(asTenantId(tenant_id))
    .from("ad_location_choices")
    .upsert(
      {
        channel_slug: c.channel,
        platform: c.platform,
        object_id: c.object_id,
        state: row.state,
        places: row.places.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
        decision_id: row.decision_id,
        chosen_by: row.chosen_by,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,platform,object_id" },
    );
  if (error) throw new Error(`ad location choice write failed: ${error.message}`);
}

async function decisionFate(tenant_id: string, decision_id: string | null): Promise<{ state: "in_flight" | "acted" | "stopped" | "none"; error: string | null }> {
  if (!decision_id) return { state: "none", error: null };
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("decisions").select("status, dispatch_error").eq("id", decision_id).maybeSingle();
  if (error || !data) return { state: "none", error: null };
  const d = data as { status: string | null; dispatch_error: string | null };
  if (d.status === "acted") return { state: "acted", error: null };
  if ((d.status === "proposed" || d.status === "approved") && !d.dispatch_error) return { state: "in_flight", error: null };
  return { state: "stopped", error: founderReason(d.dispatch_error) };
}

export function founderReason(dispatchError: string | null): string | null {
  if (!dispatchError) return null;
  const m = /^[a-z0-9_]+:\s*(.+)$/s.exec(dispatchError.trim());
  const text = (m ? m[1] : dispatchError).trim();
  return /^[A-Z]/.test(text) && text.length <= 300 ? text : "The ad platform did not take the change.";
}

export async function topOrderLocations(tenant_id: string): Promise<Array<{ label: string; share: number }>> {
  const { getMarketplaceIntel } = await import("@/services/tools/growth/marketplace_intelligence");
  const { isSentinelRegion } = await import("@/services/marketplace-intel/regions");
  const intel = await getMarketplaceIntel(tenant_id);
  if (!intel.configured) return [];
  return rankOrderLocations(
    intel.regions.map((r) => ({ label: r.region_label, key: r.region_key, bookings_n: r.bookings_n, suppressed: r.suppressed })),
    isSentinelRegion,
  );
}

export function rankOrderLocations(
  rows: ReadonlyArray<{ label: string; key: string; bookings_n: number; suppressed?: boolean }>,
  isSentinel: (key: string) => boolean,
): Array<{ label: string; share: number }> {
  let total = 0;
  const by = new Map<string, number>();
  for (const r of rows) {
    const n = Number(r.bookings_n) || 0;
    if (n <= 0 || isSentinel(r.key) || !r.label.trim()) continue;
    total += n;
    if (!r.suppressed) by.set(r.label.trim(), (by.get(r.label.trim()) ?? 0) + n);
  }
  if (total === 0) return [];
  return [...by.entries()].map(([label, n]) => ({ label, share: n / total })).sort((a, b) => b.share - a.share);
}

async function hasDatabase(tenant_id: string): Promise<boolean> {
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("tenant_db_config").select("type").maybeSingle();
  return !error && !!data;
}

export type LocationStatus =
  | { state: "none" }
  | {
      state: "needs_you" | "saved" | "unsupported";
      channel: AdLocationChannel;
      campaign: { id: string; name: string | null };
      country: Country | null;
      places: AdPlace[];
      targeting: "single" | "mixed" | "unsupported";
      ad_groups: number;
      pending: boolean;
      last_error: string | null;
      order_cities: string[];
      fingerprint: string;
    };

export async function locationStatus(tenant_id: string, channel: AdLocationChannel): Promise<LocationStatus> {
  const c = await newestCgoCampaign(tenant_id, channel);
  if (!c) return { state: "none" };
  const [live, choice, biz] = await Promise.all([readLivePlaces(tenant_id, c), readChoice(tenant_id, c), businessCountry(tenant_id)]);
  const fate = choice && choice.state !== "noted" ? await decisionFate(tenant_id, choice.decision_id) : { state: "none" as const, error: null };
  const pending = fate.state === "in_flight";
  const chose =
    pending ||
    (choice?.state === "country" && fate.state !== "stopped") ||
    (choice?.state === "places" && fate.state === "acted" && !live.country_wide);
  const needs = live.targeting !== "unsupported" && !!live.country_wide && !chose;
  let order_cities: string[] = [];
  if (needs) order_cities = (await topOrderLocations(tenant_id).catch(() => [])).slice(0, 3).map((o) => o.label.split(",")[0]!.trim());
  return {
    state: live.targeting === "unsupported" ? "unsupported" : needs ? "needs_you" : "saved",
    channel,
    campaign: { id: c.object_id, name: c.name },
    country: live.country_wide ?? biz,
    places: pending && choice ? choice.places : live.places,
    targeting: live.targeting,
    ad_groups: live.google?.ad_groups ?? 0,
    pending,
    last_error: fate.state === "stopped" ? fate.error : null,
    order_cities,
    fingerprint: live.fingerprint,
  };
}

const pct = (share: number) => `${Math.max(1, Math.round(share * 100))}%`;

export function countryPhrase(name: string): string {
  return /^(United |Netherlands$|Philippines$|Czech Republic$|Bahamas$|Gambia$)/.test(name) ? `the ${name}` : name;
}

export type LocationSuggestions = {
  orders: "confirmed" | "not_set_up" | "no_db";
  country: Country | null;
  places: AdPlace[];
  picked: string[];
};

export async function locationSuggestions(tenant_id: string, channel: AdLocationChannel): Promise<LocationSuggestions> {
  const c = await newestCgoCampaign(tenant_id, channel);
  if (!c) throw new ExpectedToolError("ad_locations_no_campaign", "There is no campaign Zavi started on this channel yet.");
  const [db, biz, address, live] = await Promise.all([hasDatabase(tenant_id), businessCountry(tenant_id), businessAddress(tenant_id), readLivePlaces(tenant_id, c)]);
  const country = live.country_wide ?? biz;
  const ranked = db ? await topOrderLocations(tenant_id).catch(() => []) : [];
  const orders: LocationSuggestions["orders"] = !db ? "no_db" : ranked.length ? "confirmed" : "not_set_up";
  const places: AdPlace[] = [];
  if (country) {
    const top = ranked.slice(0, 5);
    const resolved = await Promise.all(top.map((o) => resolvePlace(tenant_id, c.platform, o.label, country.code)));
    resolved.forEach((p, i) => {
      if (!p || places.some((x) => x.id === p.id)) return;
      places.push({ ...plain(p), source: "orders", reason: places.length === 0 ? `${pct(top[i].share)} of your orders in the last 90 days` : `${pct(top[i].share)} of your orders` });
    });
    if (address) {
      const home = await resolvePlace(tenant_id, c.platform, address, country.code);
      if (home && !places.some((x) => x.id === home.id)) places.push({ ...plain(home), source: "address", reason: "Where you are" });
    }
  }
  return { orders, country, places, picked: places.filter((p) => p.source === "orders").map((p) => p.id) };
}

export async function searchPlaces(tenant_id: string, channel: AdLocationChannel, q: string): Promise<AdPlace[]> {
  const biz = await businessCountry(tenant_id);
  const rows = await searchPlatformPlaces(tenant_id, CHANNEL[channel].platform, q, biz?.code);
  return rows.slice(0, 8).map(plain);
}

export type SaveInput = {
  campaign_id: string;
  fingerprint: string;
  places: Array<{ id: string; name?: string }>;
  apply_to_all?: boolean;
};
export type SaveResult = {
  ok: true;
  state: "country" | "places";
  decision_id: string | null;
  approved: boolean;
  places: AdPlace[];
};

export async function saveLocations(tenant_id: TenantId, user_id: string, channel: AdLocationChannel, input: SaveInput): Promise<SaveResult> {
  if (input.places.length > MAX_PLACES) throw new ExpectedToolError("ad_locations_too_many", `Pick up to ${MAX_PLACES} places.`);
  const c = await newestCgoCampaign(tenant_id, channel);
  if (!c) throw new ExpectedToolError("ad_locations_no_campaign", "There is no campaign Zavi started on this channel yet.");
  if (input.campaign_id !== c.object_id) {
    throw new ExpectedToolError("ad_locations_campaign_changed", "Zavi started a newer campaign on this channel. Open the card again to pick places for it.");
  }
  const live = await readLivePlaces(tenant_id, c);
  if (live.targeting === "unsupported") {
    throw new ExpectedToolError("ad_locations_unsupported", "Zavi can't change where this campaign shows. Change it in the ad platform.");
  }
  if (live.fingerprint !== input.fingerprint) {
    throw new ExpectedToolError("ad_locations_campaign_changed", "Where this campaign shows changed since you opened it. Open the card again to pick from what it shows now.");
  }
  if (live.targeting === "mixed" && input.apply_to_all !== true) {
    throw new ExpectedToolError("ad_locations_mixed", "This campaign's ad groups show in different places. Choose to apply your places to every ad group.");
  }
  const biz = await businessCountry(tenant_id);
  const country = live.country_wide ?? biz;

  let places: AdPlace[];
  let state: "country" | "places";
  if (input.places.length === 0) {
    if (live.country_wide && live.targeting === "single") {
      await writeChoice(tenant_id, c, { state: "country", places: [], decision_id: null, chosen_by: user_id });
      await logSave(tenant_id, c, "country_kept");
      return { ok: true, state: "country", decision_id: null, approved: false, places: live.places };
    }
    if (!country) throw new ExpectedToolError("ad_locations_no_country", "Zavi does not know your business's country, so pick at least one place.");
    places = await validatePlaces(tenant_id, c.platform, [{ id: c.platform === "google" ? await googleCountryTarget(tenant_id, country) : `country:${country.code}` }]);
    state = "country";
  } else {
    places = await validatePlaces(tenant_id, c.platform, input.places);
    state = "places";
  }

  const common = {
    ...(c.name ? { name: c.name } : {}),
    about: "Where your ads show, picked by you on the channel page.",
    rationale: "Places picked by the founder for this campaign only.",
    over_cap: true as const,
    origin: "user_initiated_ledger" as const,
    before_names: live.places.map((p) => p.name),
    expected_fingerprint: live.fingerprint,
  };
  let decision_class: string;
  let body: ReplaceGeoTargetsBody | ReplaceAdSetGeoBody;
  if (c.platform === "google") {
    decision_class = "google_ads.replace_geo_targets_review";
    body = {
      campaign_id: c.object_id,
      level: live.google?.level ?? "campaign",
      scope: live.google?.level === "ad_group" ? "all_ad_groups" : "campaign",
      location_ids: places.map((p) => Number(p.id)),
      place_names: places.map((p) => p.name),
      ...common,
    };
  } else {
    decision_class = "meta_ads.replace_ad_set_geo_review";
    body = {
      ad_set_id: c.object_id,
      places: places.map((p) => ({ ...parseMetaPlaceId(p.id)!, name: p.name })),
      ...common,
    };
  }
  const { data, error } = await tenantRpc(tenant_id, "emit_decision", {
    p_agent_run_id: null,
    p_decision_class: decision_class,
    p_body: body as object,
  });
  if (error || typeof data !== "string") throw new Error(`could not stage the change: ${error?.message ?? "no decision id"}`);
  await writeChoice(tenant_id, c, { state, places, decision_id: data, chosen_by: user_id });

  const { decideOnDecision } = await import("@/services/approvals/decide-service");
  const decided = await decideOnDecision({ decision_id: data, tenant_id, action: "approve", actor: { user_id } });
  const approved = decided.code === "ok";
  await logSave(tenant_id, c, approved ? "approved" : `staged_${decided.code}`);
  return { ok: true, state, decision_id: data, approved, places };
}

async function logSave(tenant_id: string, c: CgoCampaign, outcome: string): Promise<void> {
  try {
    const { logEvent } = await import("@/services/logging/logEvent");
    await logEvent({ level: "info", source: "ad-locations", code: `ad_locations.save_${outcome}`, tenant_id, meta: { platform: c.platform } });
  } catch {
  }
}

async function googleCountryTarget(tenant_id: string, country: Country): Promise<string> {
  const { readBusinessCountryGeoId } = await import("@/services/tools/google-ads/write/_launch-defaults");
  const id = await readBusinessCountryGeoId(tenant_id);
  if (id === null) throw new ExpectedToolError("ad_locations_no_country", `Zavi couldn't find ${country.name} in Google Ads, so pick at least one place.`);
  return String(id);
}

async function validatePlaces(tenant_id: string, platform: AdPlatform, picks: ReadonlyArray<{ id: string; name?: string }>): Promise<AdPlace[]> {
  const seen = new Set<string>();
  const unique = picks.filter((p) => !seen.has(p.id) && (seen.add(p.id), true));
  if (unique.length > MAX_PLACES) throw new ExpectedToolError("ad_locations_too_many", `Pick up to ${MAX_PLACES} places.`);
  if (platform === "google") {
    if (!unique.every((p) => /^[0-9]{1,12}$/.test(p.id))) throw new ExpectedToolError("ad_locations_bad_place", "One of the places is not a Google Ads place. Search for it again.");
    let known: Awaited<ReturnType<typeof readGooglePlaces>>;
    try {
      known = await readGooglePlaces(tenant_id, unique.map((p) => Number(p.id)));
    } catch {
      throw new ExpectedToolError("ad_locations_unverified", "Zavi couldn't check these places with Google Ads just now. Try again in a minute.");
    }
    return unique.map((p) => {
      const hit = known.get(Number(p.id));
      if (!hit) throw new ExpectedToolError("ad_locations_bad_place", "One of the places is not a place Google Ads knows. Search for it again.");
      return plain(hit);
    });
  }
  const parsed = unique.map((p) => {
    const m = parseMetaPlaceId(p.id);
    if (!m) throw new ExpectedToolError("ad_locations_bad_place", "One of the places is not a Meta place. Search for it again.");
    return m;
  });
  let verified: Awaited<ReturnType<typeof verifyMetaPlaces>>;
  try {
    verified = await verifyMetaPlaces(tenant_id, parsed);
  } catch (e) {
    if (e instanceof ExpectedToolError) throw e;
    throw new ExpectedToolError("ad_locations_unverified", "Zavi couldn't check these places with Meta just now. Try again in a minute.");
  }
  return metaDisplayPlaces(verified);
}

export type LocationNoteCandidate = { channel: AdLocationChannel; label: string; country: string; platform: AdPlatform; object_id: string };

export async function locationNoteItems(tenant_id: string): Promise<LocationNoteCandidate[]> {
  const out: LocationNoteCandidate[] = [];
  for (const channel of AD_LOCATION_CHANNELS) {
    try {
      const c = await newestCgoCampaign(tenant_id, channel);
      if (!c || (await readChoice(tenant_id, c))) continue;
      const live = await readLivePlaces(tenant_id, c);
      if (live.targeting !== "single" || !live.country_wide) continue;
      out.push({ channel, label: CHANNEL[channel].label, country: live.country_wide.name, platform: c.platform, object_id: c.object_id });
    } catch (e) {
      console.warn(`[ad-locations] note check failed for ${tenant_id}/${channel}: ${(e as Error).message}`);
    }
  }
  return out;
}

export async function markLocationsNoted(tenant_id: string, told: readonly LocationNoteCandidate[]): Promise<void> {
  for (const t of told) {
    try {
      if (await readChoice(tenant_id, t)) continue;
      await writeChoice(tenant_id, t, { state: "noted", places: [], decision_id: null, chosen_by: null });
    } catch (e) {
      console.warn(`[ad-locations] note mark failed for ${tenant_id}/${t.channel}: ${(e as Error).message}`);
    }
  }
}
