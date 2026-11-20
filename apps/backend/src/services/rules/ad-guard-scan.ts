
import { readAdGuard, adGuardEmpty, type AdGuard, type GuardPlace } from "./ad-guard";
import { canonFromGoogle, canonFromMetaSaved, canonLabel, inside, judgePlace, phraseIn, placeName, regionName, type Canon } from "./ad-guard-match";

export type LiveTarget = { platform: "meta" | "google"; object_id: string; name: string; places: Canon[] | null };
export type LiveAd = { platform: "meta" | "google"; ad_id: string; name: string; text: string | null; partial?: boolean };

export type ScanDeps = {
  readGuard: (tenant_id: string) => Promise<AdGuard>;
  savedCanons: (tenant_id: string, places: readonly GuardPlace[]) => Promise<Array<Canon | null>>;
  readTargets: (tenant_id: string) => Promise<LiveTarget[]>;
  readAds: (tenant_id: string) => Promise<LiveAd[]>;
  didYouMean?: (tenant_id: string, platform: "meta" | "google", city: string, allowed: readonly Canon[]) => Promise<string | null>;
  ask: (tenant_id: string, topic: string, ask: string) => Promise<boolean>;
  alreadyAsked?: (tenant_id: string, topics: readonly string[]) => Promise<Set<string>>;
};

export const AD_GUARD_QUESTIONS_MAX = 10;

export type ScanResult = { tenant_id: string; outcome: "no_rules" | "checked"; asked: number; violations: number; unchecked: number } | { tenant_id: string; outcome: "error"; error: string };

const title = (s: string) => s.replace(/\b\w/g, (m) => m.toUpperCase());

export async function scanTenantAdGuard(tenant_id: string, deps: ScanDeps): Promise<ScanResult> {
  try {
    const guard = await deps.readGuard(tenant_id);
    if (adGuardEmpty(guard)) return { tenant_id, outcome: "no_rules", asked: 0, violations: 0, unchecked: 0 };
    const placesSet = guard.allowed_places.length + guard.blocked_places.length > 0;
    const [allowedC, blockedC] = await Promise.all([deps.savedCanons(tenant_id, guard.allowed_places), deps.savedCanons(tenant_id, guard.blocked_places)]);
    const allowed = allowedC.filter((c): c is Canon => c !== null);
    const blocked = blockedC.filter((c): c is Canon => c !== null);
    const unchecked: string[] = [];
    for (const [k, c] of allowedC.entries()) if (!c) unchecked.push(`your saved place "${guard.allowed_places[k]!.name}"`);
    for (const [k, c] of blockedC.entries()) if (!c) unchecked.push(`your saved place "${guard.blocked_places[k]!.name}"`);
    const asks: Array<{ topic: string; ask: string }> = [];

    if (placesSet && (allowed.length > 0 || blocked.length > 0)) {
      for (const t of await deps.readTargets(tenant_id)) {
        const label = `${t.platform === "meta" ? "Meta ad set" : "Google campaign"} "${t.name}"`;
        if (t.places === null) {
          unchecked.push(label);
          continue;
        }
        let outside: Canon | null = null;
        let hitBlocked: { p: Canon; b: Canon } | null = null;
        let unknown = false;
        for (const p of t.places) {
          const v = judgePlace(p, allowed, blocked, { allowed: allowed.length < allowedC.length, blocked: blocked.length < blockedC.length });
          if (v.ok === null) unknown = true;
          else if (v.ok === false && v.why === "blocked" && !hitBlocked) hitBlocked = { p, b: v.place as Canon };
          else if (v.ok === false && v.why === "outside" && !outside) outside = p;
        }
        if (hitBlocked) {
          asks.push({
            topic: `ad_rule:${t.platform}:${t.object_id}:blocked`,
            ask: `${label} reaches ${canonLabel(hitBlocked.p)}, which your saved rules say ads must never show in (${canonLabel(hitBlocked.b)}). Should it stop showing there?`,
          });
        }
        if (outside) {
          const city = outside.level === "city" && outside.city && deps.didYouMean ? await deps.didYouMean(tenant_id, t.platform, outside.city, allowed).catch(() => null) : null;
          asks.push({
            topic: `ad_rule:${t.platform}:${t.object_id}:outside`,
            ask: `${label} targets ${canonLabel(outside)}: outside your saved service area.${city ? ` Did you mean ${city}?` : " Should it show only inside your saved places?"}`,
          });
        }
        if (unknown && !hitBlocked && !outside) unchecked.push(label);
      }
    }

    if (guard.banned_phrases.length > 0) {
      const seen = new Set<string>();
      let unreadAds = 0;
      for (const ad of await deps.readAds(tenant_id)) {
        if (ad.text === null) {
          unreadAds += 1;
          continue;
        }
        const text = ad.text;
        const hit = guard.banned_phrases.find((p) => phraseIn(text, p));
        if (!hit && ad.partial) unreadAds += 1;
        if (!hit || seen.has(`${ad.platform}:${ad.ad_id}`)) continue;
        seen.add(`${ad.platform}:${ad.ad_id}`);
        asks.push({
          topic: `ad_rule:${ad.platform}:${ad.ad_id}:phrase`,
          ask: `The ${ad.platform === "meta" ? "Meta" : "Google"} ad "${ad.name}" says "${hit}", which your saved rules say ads must never say. Should it be rewritten?`,
        });
      }
      if (unreadAds > 0) unchecked.push(`${unreadAds} ad${unreadAds === 1 ? "" : "s"} whose words this check cannot fully read (image, video, display or other kinds)`);
    }

    const violations = asks.length;
    let combined: { topic: string; ask: string } | null = null;
    if (unchecked.length > 0) {
      const list = unchecked.slice(0, 5).join("; ");
      combined = {
        topic: "ad_rule:unchecked",
        ask: `Zavi could not check ${unchecked.length === 1 ? "one thing" : `${unchecked.length} things`} against your saved places and phrases: ${list}${unchecked.length > 5 ? "; and more" : ""}. They may use a pin, a postcode or a place the ad platform does not name. Check them yourself?`,
      };
    }
    const done = deps.alreadyAsked ? await deps.alreadyAsked(tenant_id, [...asks.map((a) => a.topic), ...(combined ? [combined.topic] : [])]) : new Set<string>();
    const budget = AD_GUARD_QUESTIONS_MAX - (combined && !done.has(combined.topic) ? 1 : 0);
    let asked = 0;
    let tries = 0;
    for (const a of asks) {
      if (asked >= budget || tries >= AD_GUARD_QUESTIONS_MAX * 3) break;
      if (done.has(a.topic)) continue;
      tries += 1;
      if (await deps.ask(tenant_id, a.topic, a.ask).catch(() => false)) asked += 1;
    }
    if (combined && !done.has(combined.topic) && (await deps.ask(tenant_id, combined.topic, combined.ask).catch(() => false))) asked += 1;
    return { tenant_id, outcome: "checked", asked, violations, unchecked: unchecked.length };
  } catch (e) {
    return { tenant_id, outcome: "error", error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}

type MetaGeo = {
  countries?: string[];
  regions?: Array<{ name?: string; country?: string }>;
  cities?: Array<{ name?: string; region?: string; country?: string; radius?: number }>;
  [k: string]: unknown;
};

export function metaGeoCanons(geo: MetaGeo | null | undefined, countryName: (code: string) => string): Canon[] | null {
  if (!geo) return null;
  const known = new Set(["countries", "regions", "cities", "location_types"]);
  if (Object.entries(geo).some(([k, v]) => !known.has(k) && Array.isArray(v) && v.length > 0)) return null;
  if ((geo.cities ?? []).some((c) => Number(c.radius ?? 0) > 0)) return null;
  const cn = (c?: string) => (c ? placeName(countryName(c)) : undefined);
  const out: Canon[] = [
    ...(geo.countries ?? []).map((c) => ({ level: "country" as const, country: cn(c) })),
    ...(geo.regions ?? []).filter((r) => r.name).map((r) => ({ level: "region" as const, region: regionName(r.name), ...(r.country ? { country: cn(r.country) } : {}) })),
    ...(geo.cities ?? []).filter((c) => c.name).map((c) => ({ level: "city" as const, city: regionName(c.name), ...(c.region ? { region: regionName(c.region) } : {}), ...(c.country ? { country: cn(c.country) } : {}) })),
  ];
  return out.length ? out : null;
}

type GTarget = { geoTargetConstant?: { id?: string | number; canonicalName?: string; targetType?: string } };

async function googleCanons(tenant_id: string, ids: readonly string[]): Promise<Map<string, Canon>> {
  const out = new Map<string, Canon>();
  const clean = [...new Set(ids)].filter((x) => /^\d+$/.test(x));
  if (!clean.length) return out;
  const { gadsSearch } = await import("@/services/tools/google-ads/_client");
  for (let i = 0; i < clean.length; i += 100) {
    const rows = (await gadsSearch(
      tenant_id,
      `SELECT geo_target_constant.id, geo_target_constant.canonical_name, geo_target_constant.target_type FROM geo_target_constant WHERE geo_target_constant.resource_name IN (${clean
        .slice(i, i + 100)
        .map((id) => `'geoTargetConstants/${id}'`)
        .join(", ")})`,
    )) as GTarget[];
    const { googleKind } = await import("@/services/ad-locations/places");
    for (const r of rows) {
      const g = r.geoTargetConstant;
      if (!g?.id || !g.canonicalName) continue;
      const c = canonFromGoogle(g.canonicalName, googleKind(g.targetType ?? ""));
      if (c) out.set(String(g.id), c);
    }
  }
  return out;
}

export function defaultScanDeps(): ScanDeps {
  return {
    readGuard: readAdGuard,
    savedCanons: async (tenant_id, places) => {
      const g = await googleCanons(
        tenant_id,
        places.filter((p) => p.platform === "google").map((p) => p.id),
      ).catch((e) => {
        if (/not.?connected|not_configured/i.test(String((e as { code?: string }).code ?? (e as Error).message))) return new Map<string, Canon>();
        throw e;
      });
      return places.map((p) => (p.platform === "google" ? g.get(p.id) ?? null : canonFromMetaSaved(p.name, p.kind)));
    },
    readTargets: async (tenant_id) => {
      const out: LiveTarget[] = [];
      const { countryName } = await import("@/services/ad-locations/country");
      try {
        const { metaAdsCreds, fbGetAllPages } = await import("@/services/tools/meta-ads/_client");
        const account = (await metaAdsCreds(tenant_id)).ad_account_id;
        type Set_ = { id?: string; name?: string; effective_status?: string; targeting?: { geo_locations?: MetaGeo } };
        const sets = await fbGetAllPages<Set_>(tenant_id, `${account}/adsets`, { fields: "id,name,effective_status,targeting{geo_locations}", limit: 100 });
        for (const s of sets) if (s.id && s.effective_status === "ACTIVE") out.push({ platform: "meta", object_id: s.id, name: s.name ?? s.id, places: metaGeoCanons(s.targeting?.geo_locations, countryName) });
      } catch (e) {
        if (!/not.?connected/i.test(String((e as { code?: string }).code ?? (e as Error).message))) throw e;
      }
      try {
        const { gadsSearch } = await import("@/services/tools/google-ads/_client");
        type Camp = { campaign?: { id?: string | number; name?: string; advertisingChannelType?: string } };
        type Crit = { campaign?: { id?: string | number }; campaignCriterion?: { type?: string; location?: { geoTargetConstant?: string }; negative?: boolean } };
        const camps = (await gadsSearch(tenant_id, "SELECT campaign.id, campaign.name, campaign.advertising_channel_type FROM campaign WHERE campaign.status = 'ENABLED'")) as Camp[];
        const crits = (await gadsSearch(
          tenant_id,
          "SELECT campaign.id, campaign_criterion.type, campaign_criterion.location.geo_target_constant, campaign_criterion.negative FROM campaign_criterion WHERE campaign_criterion.type IN ('LOCATION', 'PROXIMITY', 'LOCATION_GROUP') AND campaign.status = 'ENABLED'",
        )) as Crit[];
        const byCamp = new Map<string, string[]>();
        const undecidable = new Set<string>();
        for (const c of crits) {
          const id = String(c.campaign?.id ?? "");
          if (c.campaignCriterion?.negative || c.campaignCriterion?.type !== "LOCATION") {
            if (id) undecidable.add(id);
            continue;
          }
          const geo = /geoTargetConstants\/(\d+)/.exec(c.campaignCriterion?.location?.geoTargetConstant ?? "")?.[1];
          if (id && geo) byCamp.set(id, [...(byCamp.get(id) ?? []), geo]);
        }
        const canons = await googleCanons(tenant_id, [...byCamp.values()].flat());
        for (const c of camps) {
          const id = String(c.campaign?.id ?? "");
          if (!id) continue;
          const geos = byCamp.get(id) ?? [];
          const groupLevel = ["DEMAND_GEN", "VIDEO"].includes(c.campaign?.advertisingChannelType ?? "");
          const places = undecidable.has(id)
            ? null
            : geos.length === 0 ? (groupLevel ? null : [{ level: "world" as const }]) : geos.every((g) => canons.has(g)) ? geos.map((g) => canons.get(g) as Canon) : null;
          out.push({ platform: "google", object_id: id, name: c.campaign?.name ?? id, places });
        }
      } catch (e) {
        if (!/not.?connected|not_configured/i.test(String((e as { code?: string }).code ?? (e as Error).message))) throw e;
      }
      return out;
    },
    readAds: async (tenant_id) => {
      const out: LiveAd[] = [];
      try {
        const { metaAdsCreds, fbGetAllPages } = await import("@/services/tools/meta-ads/_client");
        const account = (await metaAdsCreds(tenant_id)).ad_account_id;
        type Spec = { link_data?: { message?: string; name?: string; description?: string }; video_data?: { message?: string; title?: string } };
        type Feed = { bodies?: Array<{ text?: string }>; titles?: Array<{ text?: string }>; descriptions?: Array<{ text?: string }> };
        type Ad = { id?: string; name?: string; effective_status?: string; creative?: { body?: string; title?: string; object_story_spec?: Spec; asset_feed_spec?: Feed } };
        const ads = await fbGetAllPages<Ad>(tenant_id, `${account}/ads`, { fields: "id,name,effective_status,creative{body,title,object_story_spec,asset_feed_spec}", limit: 100 });
        for (const a of ads) {
          if (!a.id || a.effective_status !== "ACTIVE") continue;
          const c = a.creative ?? {};
          const s = c.object_story_spec ?? {};
          const f = c.asset_feed_spec ?? {};
          const text = [c.body, c.title, s.link_data?.message, s.link_data?.name, s.link_data?.description, s.video_data?.message, s.video_data?.title, ...(f.bodies ?? []).map((x) => x.text), ...(f.titles ?? []).map((x) => x.text), ...(f.descriptions ?? []).map((x) => x.text)]
            .filter(Boolean)
            .join("\n");
          out.push({ platform: "meta", ad_id: a.id, name: a.name ?? a.id, text: text || null });
        }
      } catch (e) {
        if (!/not.?connected/i.test(String((e as { code?: string }).code ?? (e as Error).message))) throw e;
      }
      try {
        const { gadsSearch } = await import("@/services/tools/google-ads/_client");
        type T = Array<{ text?: string }>;
        type Row = {
          adGroupAd?: {
            ad?: {
              id?: string | number;
              name?: string;
              type?: string;
              responsiveSearchAd?: { headlines?: T; descriptions?: T };
              responsiveDisplayAd?: { headlines?: T; longHeadline?: { text?: string }; descriptions?: T };
              expandedTextAd?: { headlinePart1?: string; headlinePart2?: string; headlinePart3?: string; description?: string; description2?: string };
            };
          };
          campaign?: { name?: string };
        };
        const rows = (await gadsSearch(
          tenant_id,
          "SELECT campaign.name, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_display_ad.headlines, ad_group_ad.ad.responsive_display_ad.long_headline, ad_group_ad.ad.responsive_display_ad.descriptions, ad_group_ad.ad.expanded_text_ad.headline_part1, ad_group_ad.ad.expanded_text_ad.headline_part2, ad_group_ad.ad.expanded_text_ad.headline_part3, ad_group_ad.ad.expanded_text_ad.description, ad_group_ad.ad.expanded_text_ad.description2 FROM ad_group_ad WHERE ad_group_ad.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'",
        )) as Row[];
        const READ = new Set(["RESPONSIVE_SEARCH_AD", "EXPANDED_TEXT_AD", "RESPONSIVE_DISPLAY_AD"]);
        for (const r of rows) {
          const ad = r.adGroupAd?.ad;
          if (!ad?.id) continue;
          const name = ad.name || `${r.campaign?.name ?? "Google"} ad`;
          if (!READ.has(ad.type ?? "")) {
            out.push({ platform: "google", ad_id: String(ad.id), name, text: null });
            continue;
          }
          const rsa = ad.responsiveSearchAd ?? {};
          const rda = ad.responsiveDisplayAd ?? {};
          const eta = ad.expandedTextAd ?? {};
          const text = [
            ...(rsa.headlines ?? []).map((x) => x.text),
            ...(rsa.descriptions ?? []).map((x) => x.text),
            ...(rda.headlines ?? []).map((x) => x.text),
            rda.longHeadline?.text,
            ...(rda.descriptions ?? []).map((x) => x.text),
            eta.headlinePart1,
            eta.headlinePart2,
            eta.headlinePart3,
            eta.description,
            eta.description2,
          ]
            .filter(Boolean)
            .join("\n");
          out.push({ platform: "google", ad_id: String(ad.id), name, text: text || null, ...(ad.type === "RESPONSIVE_DISPLAY_AD" ? { partial: true } : {}) });
        }
      } catch (e) {
        if (!/not.?connected|not_configured/i.test(String((e as { code?: string }).code ?? (e as Error).message))) throw e;
      }
      return out;
    },
    didYouMean: async (tenant_id, platform, city, allowed) => {
      const { searchPlatformPlaces } = await import("@/services/ad-locations/places");
      const rows = await searchPlatformPlaces(tenant_id, platform, city);
      for (const r of rows) {
        if (r.kind !== "City") continue;
        const parts = r.name.split(",").map((p) => p.trim());
        const c: Canon = { level: "city", city: regionName(parts[0]), ...(parts[1] ? { region: regionName(parts[1]) } : {}) };
        if (allowed.some((a) => inside(c, a) === true)) return title(`${parts[0]}${parts[1] ? `, ${parts[1]}` : ""}`);
      }
      return null;
    },
    alreadyAsked: async (tenant_id, topics) => {
      const { normalizeTopic, REASK_AFTER_DAYS } = await import("@/services/growth/cgo-questions");
      const { tenantClient, asTenantId } = await import("@/services/tenant-client");
      const since = Date.now() - REASK_AFTER_DAYS * 86_400_000;
      const keyOf = new Map(topics.map((t) => [t, normalizeTopic(t)]));
      const keys = [...new Set(keyOf.values())];
      const live = new Set<string>();
      for (let i = 0; i < keys.length; i += 100) {
        const { data, error } = await tenantClient(asTenantId(tenant_id))
          .from("cgo_questions")
          .select("topic_key, status, asked_at, answered_at")
          .eq("tenant_id", tenant_id)
          .in("topic_key", keys.slice(i, i + 100))
          .or(`status.in.(open,queued),and(status.eq.answered,answered_at.gte.${new Date(since).toISOString()}),and(status.eq.answered,answered_at.is.null,asked_at.gte.${new Date(since).toISOString()})`);
        if (error) throw new Error(`ad guard asked topics: ${error.message}`);
        for (const q of (data ?? []) as Array<{ topic_key: string; status: string; asked_at: string; answered_at: string | null }>)
          if (q.status !== "answered" || Date.parse(q.answered_at ?? q.asked_at) >= since) live.add(q.topic_key);
      }
      return new Set(topics.filter((t) => live.has(keyOf.get(t)!)));
    },
    ask: async (tenant_id, topic, ask) => (await import("@/services/growth/open-advice")).askFounderOutsideReview({ tenant_id, topic, ask }),
  };
}

export async function tenantsWithAdGuard(): Promise<string[]> {
  const { staffCrossTenantClient } = await import("@/services/tenant-client");
  const db = staffCrossTenantClient("Daily saved-ad-rules check: which live tenants saved any rule (ids only)");
  const { data, error } = await db.from("tenant_rule_settings").select("tenant_id").neq("ad_guard", "{}").limit(5000);
  if (error) throw new Error(`ad guard tenants: ${error.message}`);
  const ids = [...new Set(((data ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id))];
  const keep: string[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data: rows, error: tErr } = await db.from("tenants").select("id").in("id", ids.slice(i, i + 200)).eq("kind", "real").is("deleted_at", null);
    if (tErr) throw new Error(`ad guard tenant kinds: ${tErr.message}`);
    keep.push(...((rows ?? []) as Array<{ id: string }>).map((r) => r.id));
  }
  return keep;
}

export async function runAdGuardScan(deps: ScanDeps = defaultScanDeps(), list: () => Promise<string[]> = tenantsWithAdGuard): Promise<{ tenants: number; asked: number; errors: number }> {
  let asked = 0;
  let errors = 0;
  const ids = await list();
  for (const t of ids) {
    const r = await scanTenantAdGuard(t, deps);
    if (r.outcome === "error") {
      errors += 1;
      console.warn(`[ad-guard-scan] ${t}: ${r.error}`);
    } else asked += r.asked;
  }
  return { tenants: ids.length, asked, errors };
}
