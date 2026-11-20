
import type { OwnedComposioAccount } from "@/services/connectors/composio/api";
import { ExpectedToolError } from "@/services/tools/types";
import { assertSafeUrl, SsrfBlockedError } from "@/services/onboarding/enrichment/url-guard";
import { businessCountry, countryName } from "@/services/ad-locations/country";
import { budgetMargin, readActiveAdBudget } from "@/services/decisions/ad-budget";
import { listBusinessCenterIds, tiktokAdsAccount, tt, verifyAdvertisers } from "./composio-read";
import { ensureAdAccounts } from "./ad-accounts";
import { tiktokPost } from "./objects";
import { listTiktokCountries } from "./locations";
import { listZaviVideos, type ZaviVideo } from "./zavi-videos";
import { TIKTOK_MIN_DAILY_USD } from "./held-schema";
import {
  LINK_TIKTOK_ACCOUNT_STEPS,
  isUsableTimeZone,
  TIKTOK_LAUNCH_CAMPAIGN_TYPES,
  USABLE_IDENTITY_TYPES,
  launchRefusal,
  type UsableIdentityType,
  type VideoFacts,
} from "./launch-schema";

export type LaunchIdentity = { identity_id: string; identity_type: UsableIdentityType; identity_authorized_bc_id: string | null; display_name: string | null };
export type LaunchLocation = { location_id: string; country_code: string; name: string; level?: string };
export type LaunchBlocker = { code: string; what: string; fix: string };

export type LaunchReadiness = {
  advertiser: { advertiser_id: string; name: string; status: string | null; currency: string | null; timezone: string | null } | null;
  creation: { advertiser_enabled: boolean; usd: boolean; payment: "not_readable"; payment_note: string };
  identities: LaunchIdentity[];
  videos: ZaviVideo[];
  minimum_daily_budget_usd: { ad_group_must_exceed: number; campaign_must_exceed: number };
  budget_shape: string;
  possible_campaign_types: string[];
  allowed_locations: LaunchLocation[];
  ad_budget: { left_usd: number; days_left: number; margin: number } | null | "unreadable";
  notes: string[];
  blockers: LaunchBlocker[];
};

const PAYMENT_NOTE =
  "TikTok does not show Zavi whether this ad account has a payment method. If it has none, TikTok refuses the launch at its first step with \"Complete payment to continue\"; Zavi then creates nothing and gives any hold back.";
const BUDGET_SHAPE = "The campaign runs with no budget of its own (no limit); the daily budget sits on the ad group and must be more than $20.";

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
const q = (v: unknown) => encodeURIComponent(typeof v === "string" ? v : JSON.stringify(v));

function identityRows(data: Record<string, unknown>): Record<string, unknown>[] {
  const list = Array.isArray(data.identity_list) ? data.identity_list : Array.isArray(data.list) ? data.list : null;
  if (!list) throw new ExpectedToolError("tiktok_ads_bad_response", "TikTok returned an invalid identity list.");
  return list.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r));
}

export async function readLaunchIdentities(account: OwnedComposioAccount, advertiserId: string): Promise<{ identities: LaunchIdentity[]; notes: string[] }> {
  const notes: string[] = [];
  const asks: Array<{ path: string; bc: string | null; label: string }> = [
    { path: `/identity/get/?advertiser_id=${q(advertiserId)}&identity_type=TT_USER&page=1&page_size=100`, bc: null, label: "TikTok accounts linked to the ad account" },
  ];
  try {
    for (const bc of await listBusinessCenterIds(account)) {
      asks.push({ path: `/identity/get/?advertiser_id=${q(advertiserId)}&identity_type=BC_AUTH_TT&identity_authorized_bc_id=${q(bc)}&page=1&page_size=100`, bc, label: `TikTok accounts in Business Center ${bc}` });
    }
  } catch (e) {
    notes.push(`Business Centers could not be read (${(e as Error).message}), so their TikTok accounts are not listed.`);
  }
  const byId = new Map<string, LaunchIdentity>();
  let succeeded = 0;
  for (const ask of asks) {
    let data: Record<string, unknown>;
    try {
      data = await tt(account, ask.path);
      succeeded++;
    } catch (e) {
      notes.push(`${ask.label} could not be read (${(e as Error).message}).`);
      continue;
    }
    for (const r of identityRows(data)) {
      if (r.can_push_video === false) continue;
      const id = str(r.identity_id);
      const type = str(r.identity_type);
      if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !(USABLE_IDENTITY_TYPES as readonly string[]).includes(type ?? "")) continue;
      const bc = type === "BC_AUTH_TT" ? str(r.identity_authorized_bc_id) ?? ask.bc : null;
      if (type === "BC_AUTH_TT" && (!bc || !/^\d{1,32}$/.test(bc))) continue;
      byId.set(id, { identity_id: id, identity_type: type as UsableIdentityType, identity_authorized_bc_id: bc, display_name: str(r.display_name) });
    }
  }
  if (succeeded === 0) throw new ExpectedToolError("tiktok_ads_read_failed", `TikTok accounts for ad account ${advertiserId} could not be read.`);
  return { identities: [...byId.values()], notes };
}

export async function allowedLaunchLocations(tenantId: string, live?: { account: OwnedComposioAccount; advertiser_id: string }): Promise<{ locations: LaunchLocation[]; blocker: LaunchBlocker | null; note: string | null }> {
  const country = await businessCountry(tenantId);
  if (!country) {
    return { locations: [], blocker: { code: "tiktok_ads_no_country", what: "The company has no country on file, so Zavi does not know where the ads may show.", fix: "set the company's country in Settings > Company." }, note: null };
  }
  if (!live) return { locations: [], blocker: { code: "tiktok_ads_account_not_chosen", what: "No TikTok ad account is chosen for Zavi.", fix: "choose the ad account on the TikTok Ads channel page (Ad account card)." }, note: null };
  const match = (await listTiktokCountries(live.account, live.advertiser_id)).find((c) => c.country_code === country.code);
  if (!match) {
    return { locations: [], blocker: null, note: `TikTok does not let this ad account target ${country.name}, so there is no default place: the launch needs places picked with Where on the Create new ad form or found with tiktok_ads_search_locations.` };
  }
  return { locations: [{ location_id: match.location_id, country_code: country.code, name: countryName(country.code), level: "COUNTRY" }], blocker: null, note: null };
}

export async function readLaunchReadiness(tenantId: string, opts: { advertiser_id?: string; videos?: boolean } = {}): Promise<LaunchReadiness> {
  const account = await tiktokAdsAccount(tenantId);
  const out: LaunchReadiness = {
    advertiser: null,
    creation: { advertiser_enabled: false, usd: false, payment: "not_readable", payment_note: PAYMENT_NOTE },
    identities: [],
    videos: [],
    minimum_daily_budget_usd: { ad_group_must_exceed: TIKTOK_MIN_DAILY_USD.ad_group, campaign_must_exceed: TIKTOK_MIN_DAILY_USD.campaign },
    budget_shape: BUDGET_SHAPE,
    possible_campaign_types: [...TIKTOK_LAUNCH_CAMPAIGN_TYPES],
    allowed_locations: [],
    ad_budget: null,
    notes: [],
    blockers: [],
  };
  const state = await ensureAdAccounts(tenantId);
  const chosen = opts.advertiser_id ?? state.selected_id;
  const saved = chosen ? state.accounts.find((a) => a.advertiser_id === chosen) : undefined;
  if (!chosen || !saved) {
    out.blockers.push({ code: "tiktok_ads_account_not_chosen", what: "No TikTok ad account is chosen for Zavi.", fix: "choose the ad account on the TikTok Ads channel page (Ad account card)." });
    return out;
  }
  const live = (await verifyAdvertisers(account, [chosen]))[0];
  if (!live) {
    out.blockers.push({ code: "tiktok_ads_account_unreachable", what: `TikTok no longer answers for ad account ${chosen} on this login.`, fix: "reconnect TikTok Ads with the login that manages this ad account." });
    return out;
  }
  out.advertiser = { advertiser_id: live.advertiser_id, name: live.name, status: live.status, currency: live.currency, timezone: live.timezone };
  out.creation.advertiser_enabled = live.status === "ENABLE";
  out.creation.usd = live.currency === "USD";
  if (!out.creation.advertiser_enabled) {
    out.blockers.push({ code: "tiktok_ads_account_not_ready", what: `TikTok reports ad account ${live.name} as ${live.status ?? "unknown"}, so it will not run ads.`, fix: "finish the ad account's setup in TikTok Ads Manager (business details, verification and a payment method)." });
  }
  if (!isUsableTimeZone(live.timezone)) {
    out.blockers.push({ code: "tiktok_ads_timezone_unknown", what: `TikTok reports ad account ${live.name}'s time zone as ${live.timezone ? `"${live.timezone}"` : "missing"}, so Zavi cannot set when the ads start.`, fix: "check the ad account's time zone in TikTok Ads Manager (Account settings), then ask again." });
  }
  if (!out.creation.usd) {
    out.blockers.push({ code: "tiktok_ads_currency_unsupported", what: `Ad account ${live.name} bills in ${live.currency ?? "an unknown currency"}; Zavi launches on USD ad accounts only.`, fix: "use a USD TikTok ad account." });
  }
  const ids = await readLaunchIdentities(account, chosen);
  out.identities = ids.identities;
  out.notes.push(...ids.notes);
  if (out.identities.length === 0) {
    out.blockers.push({ code: "tiktok_ads_no_identity", what: "No TikTok account is linked that an ad can run as (TikTok no longer accepts ads without one).", fix: LINK_TIKTOK_ACCOUNT_STEPS });
  }
  if (opts.videos !== false) {
    try {
      out.videos = await listZaviVideos(tenantId);
    } catch (e) {
      out.notes.push((e as Error).message);
    }
    if (out.videos.length === 0) {
      out.blockers.push({ code: "tiktok_ads_no_usable_video", what: "Zavi has made no video for this company yet.", fix: "make one with the AI UGC Videos channel, or send Zavi an https link to a vertical 9:16 video of 5 to 60 seconds." });
    }
  }
  const loc = await allowedLaunchLocations(tenantId, { account, advertiser_id: chosen });
  out.allowed_locations = loc.locations;
  if (loc.blocker) out.blockers.push(loc.blocker);
  if (loc.note) out.notes.push(loc.note);
  try {
    const b = await readActiveAdBudget(tenantId);
    out.ad_budget = b ? { left_usd: b.left_usd, days_left: b.days_left, margin: budgetMargin(b) } : null;
  } catch {
    out.ad_budget = "unreadable";
  }
  return out;
}

export function throwBlocker(r: LaunchReadiness, codes?: readonly string[]): void {
  const b = r.blockers.find((x) => !codes || codes.includes(x.code));
  if (b) throw launchRefusal(b.code, b.what, b.fix);
}

export async function assertLandingUrl(url: string): Promise<void> {
  try {
    await assertSafeUrl(url);
  } catch (e) {
    if (e instanceof SsrfBlockedError) {
      throw launchRefusal("tiktok_ads_landing_url_unsafe", `The landing page ${url.slice(0, 200)} is not a public https page (${e.code}).`, "use the https address of a public page on the company's site.");
    }
    throw e;
  }
}

export type TiktokVideo = VideoFacts & { video_id: string; cover_url: string | null };

function firstRow(data: Record<string, unknown>): Record<string, unknown> | null {
  const list = Array.isArray(data.list) ? data.list : null;
  const r = list ? list[0] : data;
  return r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

function toVideo(r: Record<string, unknown>): TiktokVideo | null {
  const id = str(r.video_id);
  if (!id) return null;
  return {
    video_id: id,
    width: num(r.width),
    height: num(r.height),
    duration_s: num(r.duration),
    allowed_placements: Array.isArray(r.allowed_placements) ? r.allowed_placements.filter((p): p is string => typeof p === "string") : null,
    displayable: typeof r.displayable === "boolean" ? r.displayable : null,
    cover_url: str(r.video_cover_url),
  };
}

export async function uploadLaunchVideo(account: OwnedComposioAccount, advertiserId: string, videoUrl: string, fileName: string): Promise<string> {
  let data: Record<string, unknown>;
  try {
    data = await tiktokPost(account, "/file/video/ad/upload/", { advertiser_id: advertiserId, upload_type: "UPLOAD_BY_URL", video_url: videoUrl, file_name: fileName.slice(0, 100) });
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "tiktok_ads_write_refused") {
      const msg = String(e.meta?.tiktok_message ?? e.message);
      throw launchRefusal("tiktok_ads_video_unreachable", `TikTok could not take this video (${msg}).`, "use a video link TikTok can download (a public https mp4).");
    }
    if (e instanceof ExpectedToolError && e.code === "tiktok_ads_outcome_unknown") {
      throw launchRefusal("tiktok_ads_video_upload_unconfirmed", "TikTok did not confirm the video upload.", "try again in a minute.");
    }
    throw e;
  }
  const v = firstRow(data);
  const id = v ? str(v.video_id) : null;
  if (!id) throw launchRefusal("tiktok_ads_video_upload_unconfirmed", "TikTok accepted the video but returned no id for it.", "try again in a minute.");
  return id;
}

export async function readLaunchVideo(account: OwnedComposioAccount, advertiserId: string, videoId: string): Promise<TiktokVideo | null> {
  const data = await tt(account, `/file/video/ad/info/?advertiser_id=${q(advertiserId)}&video_ids=${q([videoId])}`);
  const list = Array.isArray(data.list) ? data.list : [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const v = toVideo(r as Record<string, unknown>);
    if (v?.video_id === videoId) return v;
  }
  return null;
}

export async function uploadLaunchImage(account: OwnedComposioAccount, advertiserId: string, imageUrl: string, fileName: string): Promise<string> {
  const data = await tiktokPost(account, "/file/image/ad/upload/", { advertiser_id: advertiserId, upload_type: "UPLOAD_BY_URL", image_url: imageUrl, file_name: fileName.slice(0, 100) });
  const r = firstRow(data);
  const id = r ? str(r.image_id) : null;
  if (!id) throw new ExpectedToolError("tiktok_ads_write_refused", "TikTok accepted the cover image but returned no id for it. Nothing was created.");
  return id;
}
