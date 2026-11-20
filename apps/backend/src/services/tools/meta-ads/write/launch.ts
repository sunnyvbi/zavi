
import { endWithinTest, metaTestEndTime } from "@/services/growth/cgo-test-end";
import { fbGet, fbPost, getAdAccountCurrency, metaAdsCreds } from "../_client";
import { ExpectedToolError } from "@/services/tools/types";
import { beforeSend, isDefinitePlatformRejection } from "@/services/decisions/ad-budget";
import { assertGraphWriteSucceeded, detectCbo, toBudgetMinorUnits } from "./_helpers";
import { isWritableCurrency, minorUnitsPerMajor, normalizeCurrency } from "./_currency";
import { pickThumbnailUri } from "./_library-ad-shapers";
import { resolveMetaAdCapability } from "./_library-ad-capability";
import { capabilityRefusal } from "./create_library_ad";
import { isMetaAdsWriteEnabled } from "./_flag-check";
import { metaCreateCampaign } from "./campaign_writes";
import { metaPlaceKeys, readMetaAdSetTargeting, shapeGeoLocations, type MetaGeoPlace } from "./replace_ad_set_geo";
import { checkTargetingPlacements, withAudienceMode } from "./_targeting-validate";
import { normalizeMetaTime, type LaunchCampaignBody } from "./_decision-bodies";
import {
  LAUNCH_STATUS,
  STANDARD_ENHANCEMENTS_SUBCODE,
  nameHasTag,
  readCopiedAdId,
  readCopyResult,
  shapeCopiedAdRequest,
  shapeCopyAdSetRequest,
  shapeCopyAdWithCleanCreativeRequest,
  shapeCopyCampaignRequest,
  shapeLaunchAdRequest,
  shapeLaunchAdSetRequest,
  shapeLaunchCreativeRequest,
  shapeSetDailyBudgetRequest,
  shapeWebsiteAudienceRequest,
  taggedName,
  withoutStandardEnhancements,
  type LaunchCta,
} from "./_launch-shapers";

type Child = { id: string; name: string; status: string };

const ON = "ACTIVE";

async function listChildren(tenant_id: string, parentId: string, edge: "ads" | "adsets"): Promise<Child[]> {
  const r = (await fbGet(tenant_id, `${parentId}/${edge}`, { fields: "id,name,status", limit: 200 })) as {
    data?: Array<{ id?: string; name?: string; status?: string }>;
    paging?: { next?: string };
  };
  if (r.paging?.next) {
    throw new ExpectedToolError("meta_ads_too_many_objects", `more than 200 ${edge} under ${parentId}; Zavi will not copy it unattended`);
  }
  return (r.data ?? [])
    .filter((x) => typeof x.id === "string")
    .map((x) => ({ id: String(x.id), name: String(x.name ?? ""), status: String(x.status ?? "") }));
}

export type DuplicateSource =
  | {
      ok: true;
      level: "adset" | "campaign";
      source_id: string;
      source_name: string;
      campaign_id: string;
      source_daily_usd: number | null;
      currency: string;
    }
  | { ok: false; code: string; error: string };

export async function readDuplicateSource(
  tenant_id: string,
  level: "adset" | "campaign",
  source_id: string,
): Promise<DuplicateSource> {
  const currency = await getAdAccountCurrency(tenant_id);
  if (!isWritableCurrency(currency)) {
    return { ok: false, code: "meta_ads_unsupported_currency", error: `cap_refuse: Meta budget writes support USD and INR ad accounts only; got ${currency}` };
  }
  const minor = minorUnitsPerMajor(currency);
  const account = (await metaAdsCreds(tenant_id)).ad_account_id;
  if (level === "adset") {
    const a = (await fbGet(tenant_id, source_id, {
      fields: "id,account_id,name,status,campaign_id,daily_budget,lifetime_budget,campaign{id,status,daily_budget,lifetime_budget}",
    })) as {
      id?: string;
      account_id?: string;
      name?: string;
      status?: string;
      campaign_id?: string;
      daily_budget?: string | null;
      lifetime_budget?: string | null;
      campaign?: { id?: string; status?: string; daily_budget?: string | null; lifetime_budget?: string | null };
    };
    if (!a?.id || !a.campaign_id) return refuse("meta_ads_duplicate_source_unreadable", `ad set ${source_id} could not be read`);
    if (!sameAccount(a.account_id, account)) return refuse("meta_ads_invalid_target", `ad set ${source_id} is not in this workspace's ad account`);
    if (a.status !== ON || a.campaign?.status !== ON) {
      return refuse(
        "meta_ads_duplicate_source_paused",
        `ad set ${source_id} or its campaign is switched off. Zavi copies only what is running, so a pause is never undone under a new id.`,
      );
    }
    if (detectCbo(a.campaign ?? {})) {
      return refuse(
        "meta_ads_duplicate_cbo_use_campaign",
        `ad set ${source_id} sits in a campaign that sets the budget itself; copy the campaign (meta_ads.duplicate_campaign) instead.`,
      );
    }
    if (Number(a.lifetime_budget ?? 0) > 0) {
      return refuse("meta_ads_duplicate_lifetime_budget", `ad set ${source_id} runs on a lifetime budget; a copy needs a daily one.`);
    }
    const ads = await listChildren(tenant_id, source_id, "ads");
    if (!ads.some((x) => x.status === ON)) {
      return refuse("meta_ads_duplicate_no_live_ad", `ad set ${source_id} has no ad switched on, so a copy would deliver nothing.`);
    }
    const daily = Number(a.daily_budget ?? 0) / minor;
    return { ok: true, level, source_id, source_name: a.name ?? source_id, campaign_id: a.campaign_id, source_daily_usd: daily > 0 ? daily : null, currency: normalizeCurrency(currency) };
  }
  const c = (await fbGet(tenant_id, source_id, { fields: "id,account_id,name,status,daily_budget,lifetime_budget" })) as {
    id?: string;
    account_id?: string;
    name?: string;
    status?: string;
    daily_budget?: string | null;
    lifetime_budget?: string | null;
  };
  if (!c?.id) return refuse("meta_ads_duplicate_source_unreadable", `campaign ${source_id} could not be read`);
  if (!sameAccount(c.account_id, account)) return refuse("meta_ads_invalid_target", `campaign ${source_id} is not in this workspace's ad account`);
  if (c.status !== ON) {
    return refuse(
      "meta_ads_duplicate_source_paused",
      `campaign ${source_id} is switched off. Zavi copies only what is running, so a pause is never undone under a new id.`,
    );
  }
  if (Number(c.lifetime_budget ?? 0) > 0) {
    return refuse("meta_ads_duplicate_lifetime_budget", `campaign ${source_id} runs on a lifetime budget; a copy needs a daily one.`);
  }
  if (!(Number(c.daily_budget ?? 0) > 0)) {
    return refuse(
      "meta_ads_duplicate_not_cbo",
      `campaign ${source_id} does not set the budget itself; copy its best ad set (meta_ads.duplicate_ad_set) instead.`,
    );
  }
  const sets = await listChildren(tenant_id, source_id, "adsets");
  if (!sets.some((x) => x.status === ON)) {
    return refuse("meta_ads_duplicate_no_live_ad", `campaign ${source_id} has no ad set switched on, so a copy would deliver nothing.`);
  }
  return { ok: true, level, source_id, source_name: c.name ?? source_id, campaign_id: source_id, source_daily_usd: Number(c.daily_budget) / minor, currency: normalizeCurrency(currency) };
}

function refuse(code: string, msg: string): DuplicateSource {
  return { ok: false, code, error: `${code}: ${msg}` };
}

export type DuplicateResult = {
  level: "adset" | "campaign";
  object_id: string;
  campaign_id: string;
  name: string;
  status: string;
  effective_status: string | null;
  daily_budget_usd: number;
  switched_off: string[];
  skipped_ads?: string[];
  reused: boolean;
};

export async function metaDuplicate(
  tenant_id: string,
  input: {
    level: "adset" | "campaign";
    source_id: string;
    campaign_id: string;
    daily_budget_usd: number;
    name: string;
    tag: string;
    onCopied?: (copied_id: string) => Promise<void>;
    places?: readonly MetaGeoPlace[];
    testEndsOn?: string;
    beforeLive?: (copied_id: string) => Promise<void>;
  },
): Promise<DuplicateResult> {
  const name = taggedName(input.name, input.tag);

  let copiedId: string | null = null;
  let mapped: Mapped[] = [];
  let reused = false;
  const { currency, found } = await beforeSend(async () => {
    const currency = await getAdAccountCurrency(tenant_id);
    if (input.level === "adset") {
      const siblings = await listChildren(tenant_id, input.campaign_id, "adsets");
      return { currency, found: siblings.find((s) => nameHasTag(s.name, input.tag))?.id ?? null };
    }
    const creds = await metaAdsCreds(tenant_id);
    const r = (await fbGet(tenant_id, `${creds.ad_account_id}/campaigns`, {
      fields: "id,name",
      filtering: JSON.stringify([{ field: "name", operator: "CONTAIN", value: input.tag }]),
      limit: 10,
    })) as { data?: Array<{ id?: string; name?: string }> };
    return { currency, found: (r.data ?? []).find((c) => nameHasTag(c.name, input.tag))?.id ?? null };
  });
  copiedId = found;
  if (copiedId) {
    reused = true;
  } else {
    const req =
      input.level === "adset"
        ? shapeCopyAdSetRequest({ source_ad_set_id: input.source_id, tag: input.tag })
        : shapeCopyCampaignRequest({ source_campaign_id: input.source_id, tag: input.tag });
    const res = readCopyResult(await fbPost(tenant_id, req.path, req.params), input.level);
    if (!res.copied_id) {
      throw new ExpectedToolError("meta_ads_write_failed", `Meta copied nothing back for ${input.source_id}`);
    }
    copiedId = res.copied_id;
    mapped = res.children;
  }
  const copy = copiedId;
  if (input.onCopied) await input.onCopied(copy);

  try {
    const b = shapeSetDailyBudgetRequest({ object_id: copy, daily_budget_usd: input.daily_budget_usd, name }, currency);
    assertGraphWriteSucceeded(await fbPost(tenant_id, b.path, b.params), "copy budget");
    const set = (await fbGet(tenant_id, copy, { fields: "id,name,status,daily_budget" })) as {
      name?: string;
      status?: string;
      daily_budget?: string | number | null;
    };
    const want = toBudgetMinorUnits(input.daily_budget_usd, currency);
    if (Number(set?.daily_budget) !== want || !nameHasTag(set?.name, input.tag)) {
      throw new ExpectedToolError(
        "meta_ads_launch_not_live",
        `Meta reports the copy ${copy} at a daily budget of ${set?.daily_budget ?? "unreadable"} (minor units), not ${want}, or without its launch tag.`,
        { object_id: copy },
      );
    }

    const childrenMayGoOn = !reused || set?.status !== LAUNCH_STATUS;
    let skipped_ads: string[] = [];
    let keepOff = new Set<string>();
    if (childrenMayGoOn) {
      const filled = await copyLiveChildren(tenant_id, input.level, input.source_id, copy, input.tag);
      mapped = [...mapped, ...filled.mapped];
      skipped_ads = filled.skipped;
      keepOff = filled.empty;
    }

    if (input.places?.length) {
      const sets = input.level === "adset" ? [copy] : (await listChildren(tenant_id, copy, "adsets")).map((c) => c.id);
      if (sets.length === 0) throw new ExpectedToolError("meta_ads_launch_not_live", `The copy ${copy} has no ad set to set its places on.`, { object_id: copy });
      for (const id of sets) await setCopyPlaces(tenant_id, id, input.places);
    }

    if (childrenMayGoOn) {
      const sets = input.level === "adset" ? [copy] : (await listChildren(tenant_id, copy, "adsets")).map((c) => c.id);
      for (const id of sets) await setCopyAudienceMode(tenant_id, id);
    }

    if (input.testEndsOn && childrenMayGoOn) {
      const sets = input.level === "adset" ? [copy] : (await listChildren(tenant_id, copy, "adsets")).map((c) => c.id);
      if (sets.length === 0) throw new ExpectedToolError("meta_ads_test_end_unverified", `The copy ${copy} has no ad set to give the test's end date to.`, { object_id: copy });
      for (const id of sets) await setCopyTestEnd(tenant_id, id, input.testEndsOn);
    }

    const switched_off = await alignCopiedChildren(tenant_id, input.level, input.source_id, copy, mapped, childrenMayGoOn, keepOff);

    if (input.beforeLive && childrenMayGoOn && set?.status !== LAUNCH_STATUS) await input.beforeLive(copy);

    if (set?.status !== LAUNCH_STATUS) {
      assertGraphWriteSucceeded(await fbPost(tenant_id, copy, { status: LAUNCH_STATUS }), "switch on the copy");
    }
    const back = (await fbGet(tenant_id, copy, { fields: "id,name,status,effective_status" })) as {
      status?: string;
      effective_status?: string;
      name?: string;
    };
    if (back?.status !== LAUNCH_STATUS) {
      throw new ExpectedToolError(
        "meta_ads_launch_not_live",
        `Meta reports the copy ${copy} as ${back?.status ?? "unreadable"}, not ${LAUNCH_STATUS}.`,
        { object_id: copy },
      );
    }
    return {
      level: input.level,
      object_id: copy,
      campaign_id: input.level === "adset" ? input.campaign_id : copy,
      name: back.name ?? name,
      status: back.status,
      effective_status: back.effective_status ?? null,
      daily_budget_usd: input.daily_budget_usd,
      switched_off,
      ...(skipped_ads.length ? { skipped_ads } : {}),
      reused,
    };
  } catch (e) {
    if (await switchOffConfirmed(tenant_id, copy)) {
      if (isDefinitePlatformRejection(e)) throw e;
      throw new ExpectedToolError(
        "meta_ads_launch_switched_off",
        `The copy ${copy} was switched off because the launch did not finish: ${(e as Error).message}`,
        { object_id: copy },
      );
    }
    throw new ExpectedToolError(
      "meta_ads_launch_outcome_unknown",
      `The copy ${copy} may be live: the launch did not finish (${(e as Error).message}) and switching it off could not be confirmed. Check it in Ads Manager.`,
      { object_id: copy },
    );
  }
}

async function setCopyPlaces(tenant_id: string, ad_set_id: string, places: readonly MetaGeoPlace[]): Promise<void> {
  const { targeting } = await readMetaAdSetTargeting(tenant_id, ad_set_id);
  const geo_locations = shapeGeoLocations(places, targeting.geo_locations);
  const rest: Record<string, unknown> = { ...targeting };
  delete rest.excluded_geo_locations;
  assertGraphWriteSucceeded(await fbPost(tenant_id, ad_set_id, { targeting: JSON.stringify({ ...rest, geo_locations }) }), "copy places");
  const want = metaPlaceKeys(geo_locations).join(",");
  const back = await readMetaAdSetTargeting(tenant_id, ad_set_id);
  const excluded = (back.targeting as { excluded_geo_locations?: unknown }).excluded_geo_locations;
  if (metaPlaceKeys(back.targeting.geo_locations).join(",") !== want || (excluded && Object.values(excluded as object).some((v) => Array.isArray(v) && v.length > 0))) {
    throw new ExpectedToolError("meta_ads_launch_not_live", `Meta does not show the copy ${ad_set_id} in the places it was given (${want}).`, { object_id: ad_set_id });
  }
}

type AudienceMode = { advantage_audience?: unknown; custom_audience?: unknown; lookalike?: unknown };

function audienceModeOf(t: Record<string, unknown>): AudienceMode {
  const auto = (t.targeting_automation ?? {}) as { advantage_audience?: unknown };
  const relax = t.targeting_relaxation_types as { custom_audience?: unknown; lookalike?: unknown } | undefined;
  return { advantage_audience: auto.advantage_audience, custom_audience: relax?.custom_audience, lookalike: relax?.lookalike };
}

function sameAudienceMode(have: AudienceMode, want: AudienceMode, proven: "before_write" | "after_write"): boolean {
  const flag = have.advantage_audience === undefined && want.advantage_audience === 1 ? 1 : have.advantage_audience;
  if (flag !== want.advantage_audience) return false;
  for (const k of ["custom_audience", "lookalike"] as const) {
    if (want[k] === undefined) continue;
    if (have[k] === undefined ? proven === "before_write" : have[k] !== want[k]) return false;
  }
  return true;
}

async function setCopyAudienceMode(tenant_id: string, ad_set_id: string): Promise<void> {
  const { targeting } = await readMetaAdSetTargeting(tenant_id, ad_set_id);
  const placementErr = checkTargetingPlacements(targeting);
  if (placementErr) throw new ExpectedToolError("meta_ads_invalid_targeting", `The copy ${ad_set_id}: ${placementErr}.`, { object_id: ad_set_id });
  const mode = withAudienceMode(targeting);
  const want = { ...mode, targeting_automation: { ...((targeting.targeting_automation as object) ?? {}), ...(mode.targeting_automation as object) } };
  if (sameAudienceMode(audienceModeOf(targeting), audienceModeOf(want), "before_write")) return;
  assertGraphWriteSucceeded(await fbPost(tenant_id, ad_set_id, { targeting: JSON.stringify(want) }), "copy audience");
  const back = await readMetaAdSetTargeting(tenant_id, ad_set_id);
  if (!sameAudienceMode(audienceModeOf(back.targeting), audienceModeOf(want), "after_write")) {
    throw new ExpectedToolError(
      "meta_ads_launch_not_live",
      `Meta does not show the copy ${ad_set_id} with Advantage audience ${String(audienceModeOf(want).advantage_audience)}.`,
      { object_id: ad_set_id },
    );
  }
}

type Mapped = { source_id: string; copied_id: string; type: string };

export function isStandardEnhancementsRefusal(e: unknown): boolean {
  return (
    e instanceof ExpectedToolError &&
    e.code === "meta_ads_write_failed" &&
    new RegExp(`"error_subcode"\\s*:\\s*${STANDARD_ENHANCEMENTS_SUBCODE}\\b`).test(e.message)
  );
}

export function missingCopies(sources: Child[], copies: Child[]): Child[] {
  const have = new Map<string, number>();
  for (const c of copies) have.set(c.name, (have.get(c.name) ?? 0) + 1);
  const out: Child[] = [];
  for (const s of sources) {
    const n = have.get(s.name) ?? 0;
    if (n > 0) have.set(s.name, n - 1);
    else out.push(s);
  }
  return out;
}

async function copyLiveChildren(
  tenant_id: string,
  level: "adset" | "campaign",
  sourceId: string,
  copyId: string,
  tag: string,
): Promise<{ mapped: Mapped[]; skipped: string[];  empty: Set<string> }> {
  const mapped: Mapped[] = [];
  const skipped: string[] = [];
  const empty = new Set<string>();
  const account = (await metaAdsCreds(tenant_id)).ad_account_id;
  if (level === "adset") {
    const r = await copyLiveAds(tenant_id, account, sourceId, copyId, mapped, skipped);
    if (r.made === 0 && r.refusal) throw r.refusal;
    return { mapped, skipped, empty };
  }
  const srcSets = await listChildren(tenant_id, sourceId, "adsets");
  const copySets = await listChildren(tenant_id, copyId, "adsets");
  for (const src of missingCopies(srcSets.filter((x) => x.status === ON), copySets)) {
    const req = shapeCopyAdSetRequest({ source_ad_set_id: src.id, tag, campaign_id: copyId, rename: "none" });
    const res = readCopyResult(await fbPost(tenant_id, req.path, req.params), "adset");
    if (!res.copied_id) throw new ExpectedToolError("meta_ads_write_failed", `Meta copied nothing back for ad set ${src.id}`);
    mapped.push({ type: "adset", source_id: src.id, copied_id: res.copied_id });
    copySets.push({ id: res.copied_id, name: src.name, status: "PAUSED" });
  }
  let made = 0;
  let refusal: unknown = null;
  for (const s of copySets) {
    const src = sourceOf(s, srcSets, mapped);
    if (!src || src.status !== ON) continue;
    const r = await copyLiveAds(tenant_id, account, src.id, s.id, mapped, skipped);
    made += r.made;
    if (r.made === 0) empty.add(s.id);
    refusal ??= r.refusal;
  }
  if (made === 0) {
    if (refusal) throw refusal;
    throw new ExpectedToolError("meta_ads_duplicate_no_live_ad", `campaign ${sourceId} has no ad switched on, so a copy would deliver nothing.`);
  }
  return { mapped, skipped, empty };
}

async function copyLiveAds(
  tenant_id: string,
  account: string,
  srcSetId: string,
  copySetId: string,
  mapped: Mapped[],
  skipped: string[],
): Promise<{ made: number; refusal: unknown }> {
  const live = (await listChildren(tenant_id, srcSetId, "ads")).filter((x) => x.status === ON);
  const missing = missingCopies(live, await listChildren(tenant_id, copySetId, "ads"));
  let made = live.length - missing.length;
  let refusal: unknown = null;
  for (const ad of missing) {
    try {
      mapped.push({ type: "ad", source_id: ad.id, copied_id: await copyOneAd(tenant_id, account, ad, copySetId) });
      made += 1;
    } catch (e) {
      const leftOut = isDefinitePlatformRejection(e) || (e instanceof ExpectedToolError && e.code === "meta_ads_invalid_media");
      if (!leftOut) throw e;
      console.warn(`[meta launch] ad ${ad.id} not copied into ${copySetId}: ${(e as Error).message.slice(0, 300)}`);
      skipped.push(ad.id);
      refusal ??= e;
    }
  }
  return { made, refusal };
}

export async function copyOneAd(tenant_id: string, account: string, ad: Child, copySetId: string): Promise<string> {
  const src = (await fbGet(tenant_id, ad.id, { fields: "creative{id,degrees_of_freedom_spec}" })) as {
    creative?: { id?: string; degrees_of_freedom_spec?: unknown };
  };
  const creative_id = src?.creative?.id;
  if (!creative_id) throw new ExpectedToolError("meta_ads_invalid_media", `ad ${ad.id} has no creative Zavi can reuse`);
  try {
    const req = shapeCopiedAdRequest({ ad_account_id: account, ad_set_id: copySetId, creative_id: String(creative_id), name: ad.name });
    const r = (await fbPost(tenant_id, req.path, req.params)) as { id?: string };
    assertGraphWriteSucceeded(r, "copied ad create");
    if (!r?.id) throw new ExpectedToolError("meta_ads_write_failed", `Meta returned no id for the copy of ad ${ad.id}`);
    return String(r.id);
  } catch (e) {
    if (!isStandardEnhancementsRefusal(e)) throw e;
    const req = shapeCopyAdWithCleanCreativeRequest({
      source_ad_id: ad.id,
      ad_set_id: copySetId,
      degrees_of_freedom_spec: withoutStandardEnhancements(src.creative?.degrees_of_freedom_spec),
    });
    const id = readCopiedAdId(await fbPost(tenant_id, req.path, req.params));
    if (!id) throw new ExpectedToolError("meta_ads_write_failed", `Meta copied nothing back for ad ${ad.id}`);
    return id;
  }
}

async function setCopyTestEnd(tenant_id: string, ad_set_id: string, testEndsOn: string): Promise<void> {
  const now = (await fbGet(tenant_id, ad_set_id, { fields: "id,end_time" })) as { end_time?: string } | null;
  const own = now?.end_time && Date.parse(normalizeMetaTime(now.end_time)) > Date.now() ? normalizeMetaTime(now.end_time) : undefined;
  const want = metaTestEndTime(own, testEndsOn);
  if (want !== own) assertGraphWriteSucceeded(await fbPost(tenant_id, ad_set_id, { end_time: want }), "copy end date");
  const back = (await fbGet(tenant_id, ad_set_id, { fields: "id,end_time" })) as { end_time?: string } | null;
  if (!back?.end_time || Date.parse(normalizeMetaTime(back.end_time)) !== Date.parse(want)) {
    throw new ExpectedToolError("meta_ads_test_end_unverified", `Meta reads the copied ad set ${ad_set_id}'s end as ${back?.end_time ?? "none"}, not ${want}, so this test was not switched on.`, { object_id: ad_set_id });
  }
}

async function switchOffConfirmed(tenant_id: string, id: string): Promise<boolean> {
  try {
    assertGraphWriteSucceeded(await fbPost(tenant_id, id, { status: "PAUSED" }, { safety: true }), "switch off the copy");
    const back = (await fbGet(tenant_id, id, { fields: "id,status" }, { safety: true })) as { status?: string };
    return back?.status === "PAUSED";
  } catch (e) {
    console.error(`[meta launch] could not switch off ${id} after a failed launch: ${(e as Error).message}`);
    return false;
  }
}

function sourceOf(copy: Child, srcs: Child[], mapped: Array<{ source_id: string; copied_id: string }>): Child | null {
  const byMap = mapped.find((m) => m.copied_id === copy.id);
  if (byMap) return srcs.find((s) => s.id === byMap.source_id) ?? null;
  const byName = srcs.filter((s) => s.name === copy.name);
  return byName.length === 1 ? byName[0]! : null;
}

async function alignCopiedChildren(
  tenant_id: string,
  level: "adset" | "campaign",
  sourceId: string,
  copiedId: string,
  mapped: Mapped[],
  mayGoOn: boolean,
  keepOff: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const off: string[] = [];
  const pairs: Array<{ src: Child | null; copy: Child }> = [];
  const pairUp = (srcs: Child[], copies: Child[]) => {
    for (const copy of copies) pairs.push({ src: sourceOf(copy, srcs, mapped), copy });
  };
  if (level === "adset") {
    pairUp(await listChildren(tenant_id, sourceId, "ads"), await listChildren(tenant_id, copiedId, "ads"));
  } else {
    const srcSets = await listChildren(tenant_id, sourceId, "adsets");
    const copySets = await listChildren(tenant_id, copiedId, "adsets");
    pairUp(srcSets, copySets);
    for (const s of copySets) {
      const src = sourceOf(s, srcSets, mapped);
      if (!src || src.status !== ON) continue;
      pairUp(await listChildren(tenant_id, src.id, "ads"), await listChildren(tenant_id, s.id, "ads"));
    }
  }
  for (const { src, copy } of pairs) {
    const on = src?.status === ON && !keepOff.has(copy.id);
    if (on && copy.status !== ON && mayGoOn) {
      assertGraphWriteSucceeded(await fbPost(tenant_id, copy.id, { status: ON }), "switch on a copied object");
    } else if (!on && copy.status === ON) {
      assertGraphWriteSucceeded(await fbPost(tenant_id, copy.id, { status: "PAUSED" }), "switch off a copied object");
    }
    if (!on) off.push(copy.id);
  }
  return off;
}

export type AudienceResult = { audience_id: string; name: string; pixel_id: string; reused: boolean; approximate_count: number | null };

export async function metaCreateWebsiteAudience(
  tenant_id: string,
  input: { retention_days: 30 | 90; pixel_id?: string; tag: string },
): Promise<AudienceResult> {
  const creds = await metaAdsCreds(tenant_id);
  const px = (await fbGet(tenant_id, `${creds.ad_account_id}/adspixels`, { fields: "id,name", limit: 50 })) as {
    data?: Array<{ id?: string }>;
  };
  const pixels = (px.data ?? []).map((p) => String(p.id ?? "")).filter(Boolean);
  let pixel_id: string;
  if (input.pixel_id) {
    if (!pixels.includes(input.pixel_id)) {
      throw new ExpectedToolError("meta_ads_pixel_not_in_account", `pixel ${input.pixel_id} is not one of this ad account's pixels`);
    }
    pixel_id = input.pixel_id;
  } else if (pixels.length === 1) {
    pixel_id = pixels[0];
  } else {
    throw new ExpectedToolError(
      pixels.length === 0 ? "meta_ads_no_pixel" : "meta_ads_pixel_ambiguous",
      pixels.length === 0
        ? "this ad account has no pixel, so there are no website visitors to build an audience from"
        : `this ad account has ${pixels.length} pixels; name the one on the founder's site (pixel_id)`,
      { next_step: "operator_action" },
    );
  }

  const base = `Zavi · Website visitors ${input.retention_days}d`;
  const name = taggedName(base, input.tag);
  const list = (await fbGet(tenant_id, `${creds.ad_account_id}/customaudiences`, { fields: "id,name,rule", limit: 200 })) as {
    data?: Array<{ id?: string; name?: string; rule?: unknown }>;
  };
  const existing = (list.data ?? []).find(
    (a) =>
      nameHasTag(a.name, input.tag) ||
      (typeof a.name === "string" && a.name.startsWith(base) && ruleReadsPixel(a.rule, pixel_id, input.retention_days)),
  );
  let audience_id: string;
  let reused = false;
  if (existing?.id) {
    audience_id = String(existing.id);
    reused = true;
  } else {
    await assertCustomAudienceTermsAccepted(tenant_id, creds.ad_account_id);
    const req = shapeWebsiteAudienceRequest({ ad_account_id: creds.ad_account_id, pixel_id, retention_days: input.retention_days, name });
    const r = (await fbPost(tenant_id, req.path, req.params)) as { id?: string };
    assertGraphWriteSucceeded(r, "custom audience create");
    if (!r.id) throw new ExpectedToolError("meta_ads_write_failed", "Meta returned no audience id");
    audience_id = r.id;
  }
  let approximate_count: number | null = null;
  try {
    const back = (await fbGet(tenant_id, audience_id, { fields: "approximate_count_lower_bound" })) as {
      approximate_count_lower_bound?: number | string;
    };
    const n = Number(back?.approximate_count_lower_bound);
    approximate_count = Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
  }
  return { audience_id, name: existing?.name ?? name, pixel_id, reused, approximate_count };
}

const META_CUSTOM_AUDIENCE_TOS_URL = "https://www.facebook.com/customaudiences/app/tos";

export async function assertCustomAudienceTermsAccepted(tenant_id: string, ad_account_id: string): Promise<void> {
  let tos: unknown;
  try {
    tos = ((await fbGet(tenant_id, ad_account_id, { fields: "tos_accepted" })) as { tos_accepted?: unknown })?.tos_accepted;
  } catch {
    return;
  }
  if (customAudienceTermsAccepted(tos)) return;
  const act = ad_account_id.replace(/^act_/, "");
  throw new ExpectedToolError(
    "meta_ads_custom_audience_terms",
    `this ad account has not accepted Meta's Custom Audience terms, so Meta will not create the audience; nothing was sent. The ad account owner accepts them at ${META_CUSTOM_AUDIENCE_TOS_URL}/?act=${act}, then try again.`,
    { next_step: "operator_action", unblockers: [`Open ${META_CUSTOM_AUDIENCE_TOS_URL}/?act=${act} as an admin of the ad account and accept the terms`] },
  );
}

export function customAudienceTermsAccepted(tos: unknown): boolean {
  if (!tos || typeof tos !== "object" || Array.isArray(tos)) return false;
  return Number((tos as Record<string, unknown>).custom_audience_tos) === 1;
}

export function ruleReadsPixel(rule: unknown, pixel_id: string, retention_days: number): boolean {
  let r: unknown = rule;
  if (typeof r === "string") {
    try {
      r = JSON.parse(r);
    } catch {
      return false;
    }
  }
  const rules = (r as { inclusions?: { rules?: unknown } } | null)?.inclusions?.rules;
  if (!Array.isArray(rules) || rules.length === 0) return false;
  return rules.every((x) => {
    const one = x as { event_sources?: Array<{ id?: unknown; type?: unknown }>; retention_seconds?: unknown };
    const sources = Array.isArray(one.event_sources) ? one.event_sources : [];
    return (
      sources.length > 0 &&
      sources.every((src) => String(src.id ?? "") === pixel_id && src.type === "pixel") &&
      Number(one.retention_seconds) === retention_days * 86_400
    );
  });
}

export type CreateAdResult = {
  ad_id: string;
  creative_id: string | null;
  ad_set_id: string;
  status: string;
  effective_status: string | null;
  reused: boolean;
};

function sameAccount(a: unknown, ours: string): boolean {
  return typeof a === "string" && a.replace(/^act_/, "") === ours.replace(/^act_/, "");
}

export async function resolveCreativeMedia(
  tenant_id: string,
  ad_account_id: string,
  input: { image_url?: string; video_asset_id?: string; source_ad_id?: string },
): Promise<{ image_url?: string; image_hash?: string; video_id?: string; thumbnail_url?: string }> {
  let image_url = input.image_url;
  let image_hash: string | undefined;
  let video_id = input.video_asset_id;
  let thumbnail_url: string | undefined;
  if (!image_url && !video_id && input.source_ad_id) {
    const src = (await fbGet(tenant_id, input.source_ad_id, {
      fields: "account_id,creative{image_hash,image_url,video_id,thumbnail_url,object_story_spec}",
    })) as {
      account_id?: string;
      creative?: { image_hash?: string; image_url?: string; video_id?: string; thumbnail_url?: string; object_story_spec?: { video_data?: { video_id?: string; image_url?: string }; link_data?: { image_hash?: string; picture?: string } } };
    };
    if (!sameAccount(src?.account_id, ad_account_id)) {
      throw new ExpectedToolError("meta_ads_invalid_target", `ad ${input.source_ad_id} is not in this workspace's ad account`);
    }
    const c = src.creative ?? {};
    const spec = c.object_story_spec ?? {};
    video_id = c.video_id ?? spec.video_data?.video_id;
    thumbnail_url = c.thumbnail_url ?? spec.video_data?.image_url;
    image_hash = video_id ? undefined : c.image_hash ?? spec.link_data?.image_hash;
    image_url = video_id || image_hash ? undefined : c.image_url ?? spec.link_data?.picture;
    if (!video_id && !image_hash && !image_url) {
      throw new ExpectedToolError("meta_ads_invalid_media", `ad ${input.source_ad_id} has no image or video Zavi can reuse`);
    }
  }
  if (video_id && !thumbnail_url) {
    thumbnail_url = pickThumbnailUri(await fbGet(tenant_id, `${video_id}/thumbnails`, { fields: "uri,is_preferred", limit: 10 })) ?? undefined;
  }

  return { image_url, image_hash, video_id, thumbnail_url };
}

export async function metaCreateLaunchAd(
  tenant_id: string,
  input: {
    ad_set_id: string;
    image_url?: string;
    video_asset_id?: string;
    source_ad_id?: string;
    primary_text: string;
    headline: string;
    link_url: string;
    cta?: LaunchCta;
    name: string;
    tag: string;
  },
): Promise<CreateAdResult> {
  const cap = await resolveMetaAdCapability(tenant_id);
  if (!cap.ok) throw capabilityRefusal(cap);

  const set = (await fbGet(tenant_id, input.ad_set_id, { fields: "id,account_id,status" })) as { id?: string; account_id?: string };
  if (!set?.id || !sameAccount(set.account_id, cap.ad_account_id)) {
    throw new ExpectedToolError("meta_ads_invalid_target", `ad set ${input.ad_set_id} is not in this workspace's ad account`);
  }

  const ads = await listChildren(tenant_id, input.ad_set_id, "ads");
  const mine = ads.find((a) => nameHasTag(a.name, input.tag));
  if (mine) {
    return { ad_id: mine.id, creative_id: null, ad_set_id: input.ad_set_id, status: mine.status, effective_status: null, reused: true };
  }

  const { image_url, image_hash, video_id, thumbnail_url } = await resolveCreativeMedia(tenant_id, cap.ad_account_id, input);

  const name = taggedName(input.name, input.tag);
  const creativeReq = shapeLaunchCreativeRequest({
    ad_account_id: cap.ad_account_id,
    page_id: cap.page_id,
    name,
    primary_text: input.primary_text,
    headline: input.headline,
    link_url: input.link_url,
    cta: input.cta ?? "LEARN_MORE",
    image_url,
    image_hash,
    video_id,
    thumbnail_url,
    tag: input.tag,
  });
  const creativeRes = (await fbPost(tenant_id, creativeReq.path, creativeReq.params)) as { id?: string };
  assertGraphWriteSucceeded(creativeRes, "ad creative create");
  if (!creativeRes.id) throw new ExpectedToolError("meta_ads_write_failed", "Meta returned no creative id");

  const adReq = shapeLaunchAdRequest({ ad_account_id: cap.ad_account_id, ad_set_id: input.ad_set_id, creative_id: creativeRes.id, name });
  const adRes = (await fbPost(tenant_id, adReq.path, adReq.params)) as { id?: string };
  assertGraphWriteSucceeded(adRes, "ad create");
  if (!adRes.id) throw new ExpectedToolError("meta_ads_write_failed", "Meta returned no ad id");

  const back = (await fbGet(tenant_id, adRes.id, { fields: "status,effective_status" })) as { status?: string; effective_status?: string };
  if (back?.status !== LAUNCH_STATUS) {
    throw new ExpectedToolError("meta_ads_launch_not_live", `Meta reports ad ${adRes.id} as ${back?.status ?? "unreadable"}, not ${LAUNCH_STATUS}.`, {
      object_id: adRes.id,
    });
  }
  return {
    ad_id: adRes.id,
    creative_id: creativeRes.id,
    ad_set_id: input.ad_set_id,
    status: back.status,
    effective_status: back.effective_status ?? null,
    reused: false,
  };
}

export type LaunchStage = "campaign" | "ad_set" | "creative" | "ad" | "live";

export type LaunchReceipt = { stage: LaunchStage; id: string; outcome: "created" | "found" | "verified" };

export type LaunchCampaignResult = {
  campaign_id: string;
  ad_set_id: string;
  ad_id: string;
  name: string;
  status: string;
  effective_status: string | null;
  receipts: LaunchReceipt[];
  reused: boolean;
};

type LiveRead = { id?: string; name?: string; status?: string; effective_status?: string; daily_budget?: string | number | null; bid_strategy?: string | null; bid_amount?: string | number | null };

export async function metaLaunchCampaign(
  tenant_id: string,
  input: {
    body: LaunchCampaignBody;
    campaign_name: string;
    tag: string;
    onCampaign?: (campaign_id: string) => Promise<void>;
    testEndsOn?: string;
    beforeLive?: (campaign_id: string) => Promise<void>;
  },
): Promise<LaunchCampaignResult> {
  const keepCampaignOff = input.body.switch_on === false;
  const { campaign: c, ad_set: s, ad } = input.body;
  const { cap, currency } = await beforeSend(async () => ({
    cap: await resolveMetaAdCapability(tenant_id),
    currency: await getAdAccountCurrency(tenant_id),
  }));
  if (!cap.ok) throw capabilityRefusal(cap);
  const receipts: LaunchReceipt[] = [];

  const camp = await metaCreateCampaign(tenant_id, {
    name: input.campaign_name,
    tag: input.tag,
    objective: c.objective,
    special_ad_categories: c.special_ad_categories,
    special_ad_category_country: c.special_ad_category_country,
    daily_budget_usd: c.daily_budget_usd,
    bid_strategy: c.bid_strategy,
  });
  receipts.push({ stage: "campaign", id: camp.id, outcome: camp.reused ? "found" : "created" });
  if (input.onCampaign) await input.onCampaign(camp.id);

  let alreadyLive = false;
  try {
    const liveCamp = (await fbGet(tenant_id, camp.id, { fields: "id,name,status,daily_budget,bid_strategy" })) as LiveRead;
    alreadyLive = camp.reused && liveCamp?.status === LAUNCH_STATUS;
    const wantBudget = toBudgetMinorUnits(c.daily_budget_usd, currency);
    if (!alreadyLive && (Number(liveCamp?.daily_budget) !== wantBudget || liveCamp?.bid_strategy !== c.bid_strategy)) {
      throw new ExpectedToolError(
        "meta_ads_launch_not_as_approved",
        `Meta reports campaign ${camp.id} at a daily budget of ${liveCamp?.daily_budget ?? "unreadable"} (minor units) and bid strategy ${liveCamp?.bid_strategy ?? "unreadable"}, not ${wantBudget} and ${c.bid_strategy} as approved.`,
        { object_id: camp.id, stage: "campaign" },
      );
    }

    let adSetId = (await listChildren(tenant_id, camp.id, "adsets")).find((x) => nameHasTag(x.name, input.tag))?.id;
    const adSetReused = !!adSetId;
    if (adSetId) {
      receipts.push({ stage: "ad_set", id: adSetId, outcome: "found" });
    } else {
      const req = shapeLaunchAdSetRequest(
        {
          ad_account_id: cap.ad_account_id,
          campaign_id: camp.id,
          name: taggedName(s.name ?? c.name, input.tag),
          optimization_goal: s.optimization_goal,
          billing_event: s.billing_event,
          targeting: s.targeting,
          promoted_object: s.promoted_object,
          bid_strategy: c.bid_strategy,
          bid_amount_usd: s.bid_amount_usd,
          ...(s.end_time ? { end_time: s.end_time } : {}),
        },
        currency,
      );
      const r = (await fbPost(tenant_id, req.path, req.params)) as { id?: string };
      assertGraphWriteSucceeded(r, "ad set create");
      if (!r.id) throw new ExpectedToolError("meta_ads_write_failed", "Meta returned no ad set id", { stage: "ad_set" });
      adSetId = r.id;
      receipts.push({ stage: "ad_set", id: adSetId, outcome: "created" });
    }
    if (s.bid_amount_usd !== undefined && !alreadyLive) {
      const liveSet = (await fbGet(tenant_id, adSetId, { fields: "id,bid_amount" })) as LiveRead;
      const wantBid = toBudgetMinorUnits(s.bid_amount_usd, currency);
      if (Number(liveSet?.bid_amount) !== wantBid) {
        throw new ExpectedToolError(
          "meta_ads_launch_not_as_approved",
          `Meta reports ad set ${adSetId} at a bid of ${liveSet?.bid_amount ?? "unreadable"} (minor units), not ${wantBid} as approved.`,
          { object_id: adSetId, stage: "ad_set" },
        );
      }
    }

    let adId = (await listChildren(tenant_id, adSetId, "ads")).find((x) => nameHasTag(x.name, input.tag))?.id;
    if (adId) {
      receipts.push({ stage: "ad", id: adId, outcome: "found" });
    } else {
      const media = await resolveCreativeMedia(tenant_id, cap.ad_account_id, {
        image_url: ad.image_url,
        video_asset_id: ad.video_asset_id,
        source_ad_id: ad.source === "copy" ? ad.source_ad_id : undefined,
      });
      const adName = taggedName(ad.name ?? ad.headline, input.tag);
      const creativeReq = shapeLaunchCreativeRequest({
        ad_account_id: cap.ad_account_id,
        page_id: cap.page_id,
        name: adName,
        primary_text: ad.primary_text,
        headline: ad.headline,
        link_url: ad.link_url,
        cta: ad.cta ?? "LEARN_MORE",
        ...media,
        tag: input.tag,
      });
      const creative = (await fbPost(tenant_id, creativeReq.path, creativeReq.params)) as { id?: string };
      assertGraphWriteSucceeded(creative, "ad creative create");
      if (!creative.id) throw new ExpectedToolError("meta_ads_write_failed", "Meta returned no creative id", { stage: "creative" });
      receipts.push({ stage: "creative", id: creative.id, outcome: "created" });

      const adReq = shapeLaunchAdRequest({ ad_account_id: cap.ad_account_id, ad_set_id: adSetId, creative_id: creative.id, name: adName });
      const made = (await fbPost(tenant_id, adReq.path, adReq.params)) as { id?: string };
      assertGraphWriteSucceeded(made, "ad create");
      if (!made.id) throw new ExpectedToolError("meta_ads_write_failed", "Meta returned no ad id", { stage: "ad" });
      adId = made.id;
      receipts.push({ stage: "ad", id: adId, outcome: "created" });
    }

    if (!alreadyLive && input.testEndsOn) {
      const set = (await fbGet(tenant_id, adSetId, { fields: "id,end_time" })) as { end_time?: string } | null;
      const want = s.end_time ? Date.parse(normalizeMetaTime(s.end_time)) : NaN;
      const got = set?.end_time ? Date.parse(normalizeMetaTime(set.end_time)) : NaN;
      const ok = adSetReused ? Number.isFinite(got) && got > Date.now() && endWithinTest(set?.end_time, input.testEndsOn) : Number.isFinite(want) && got === want && endWithinTest(set?.end_time, input.testEndsOn);
      if (!ok) {
        throw new ExpectedToolError(
          "meta_ads_test_end_unverified",
          `Meta reads the ad set ${adSetId}'s end as ${set?.end_time ?? "none"}, not ${s.end_time ?? `${input.testEndsOn} 00:00 UTC`}, so this test was not switched on.`,
          { object_id: adSetId, stage: "live" },
        );
      }
    }
    if (!alreadyLive && input.beforeLive) await input.beforeLive(camp.id);
    if (!alreadyLive) {
      if (!(await isMetaAdsWriteEnabled())) {
        throw new ExpectedToolError("meta_ads_write_disabled", "Meta writes were switched off before the launch went live.", { stage: "live" });
      }
      for (const id of keepCampaignOff ? [adId, adSetId] : [adId, adSetId, camp.id]) {
        const now = (await fbGet(tenant_id, id, { fields: "id,status" })) as LiveRead;
        if (now?.status !== LAUNCH_STATUS) {
          assertGraphWriteSucceeded(await fbPost(tenant_id, id, { status: LAUNCH_STATUS }), "switch on the launch");
        }
      }
    }
    const [backAd, backSet, backCamp] = (await Promise.all(
      [adId, adSetId, camp.id].map((id) => fbGet(tenant_id, id, { fields: "id,name,status,effective_status" })),
    )) as LiveRead[];
    if (!alreadyLive && keepCampaignOff && backCamp?.status !== "PAUSED") {
      throw new ExpectedToolError(
        "meta_ads_launch_not_as_approved",
        `Meta reports campaign ${camp.id} as ${backCamp?.status ?? "unreadable"}, not PAUSED as built.`,
        { object_id: camp.id, stage: "live" },
      );
    }
    if (!alreadyLive) {
      const checks: Array<[string, string, LiveRead | undefined]> = [["ad", adId, backAd], ["ad set", adSetId, backSet]];
      if (!keepCampaignOff) checks.push(["campaign", camp.id, backCamp]);
      const off = checks.find(([, , b]) => b?.status !== LAUNCH_STATUS);
      if (off) {
        throw new ExpectedToolError(
          "meta_ads_launch_not_live",
          `Meta reports the ${off[0]} ${off[1]} as ${off[2]?.status ?? "unreadable"}, not ${LAUNCH_STATUS}.`,
          { object_id: off[1], stage: "live" },
        );
      }
    }
    receipts.push({ stage: "live", id: camp.id, outcome: "verified" });
    return {
      campaign_id: camp.id,
      ad_set_id: adSetId,
      ad_id: adId,
      name: backCamp?.name ?? camp.name,
      status: backCamp?.status ?? (keepCampaignOff ? "PAUSED" : LAUNCH_STATUS),
      effective_status: backAd?.effective_status ?? null,
      receipts,
      reused: alreadyLive,
    };
  } catch (e) {
    if (alreadyLive) throw e;
    if (await switchOffConfirmed(tenant_id, camp.id)) {
      if (isDefinitePlatformRejection(e)) throw e;
      throw new ExpectedToolError(
        "meta_ads_launch_switched_off",
        `The campaign ${camp.id} was switched off because the launch did not finish (${stageOf(e, receipts)}): ${(e as Error).message}`,
        { object_id: camp.id, receipts },
      );
    }
    throw new ExpectedToolError(
      "meta_ads_launch_outcome_unknown",
      `The campaign ${camp.id} may be live: the launch did not finish (${stageOf(e, receipts)}: ${(e as Error).message}) and switching it off could not be confirmed. Check it in Ads Manager.`,
      { object_id: camp.id, receipts },
    );
  }
}

function stageOf(e: unknown, receipts: LaunchReceipt[]): string {
  const own = e instanceof ExpectedToolError ? (e.meta as { stage?: unknown } | undefined)?.stage : undefined;
  if (typeof own === "string") return `at the ${own} stage`;
  const order: LaunchStage[] = ["campaign", "ad_set", "creative", "ad", "live"];
  const last = receipts.length ? order.indexOf(receipts[receipts.length - 1]!.stage) : -1;
  return `at the ${order[Math.min(last + 1, order.length - 1)]} stage`;
}
