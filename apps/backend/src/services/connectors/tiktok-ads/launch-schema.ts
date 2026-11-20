
import { z } from "zod";
import { advancedGroupShape } from "./campaign-advanced";
import { tiktokAgeGroupsSchema, tiktokGenderSchema, tiktokLanguagesSchema } from "./targeting";
export { TIKTOK_AGE_GROUPS } from "./targeting";
import { ExpectedToolError } from "@/services/tools/types";
import { aboveFloor, TIKTOK_MAX_DAILY_USD, TIKTOK_MIN_DAILY_USD } from "./held-schema";

export const TIKTOK_LAUNCH_CAMPAIGN_TYPES = ["TRAFFIC"] as const;
export type TiktokLaunchCampaignType = (typeof TIKTOK_LAUNCH_CAMPAIGN_TYPES)[number];

export const USABLE_IDENTITY_TYPES = ["BC_AUTH_TT", "TT_USER"] as const;
export type UsableIdentityType = (typeof USABLE_IDENTITY_TYPES)[number];

export const TIKTOK_LAUNCH_CTAS = ["LEARN_MORE", "SHOP_NOW", "SIGN_UP", "CONTACT_US", "APPLY_NOW", "BOOK_NOW", "ORDER_NOW", "GET_QUOTE", "SUBSCRIBE"] as const;

export const VIDEO_SPEC = { ratio: 9 / 16, ratioTolerance: 0.02, minSeconds: 5, maxSeconds: 60, placement: "PLACEMENT_TIKTOK" } as const;

export const TIKTOK_MAX_LOCATIONS = 25;

export const LAUNCH_MEASURED_LINE = "Measured: clicks and site visits (not sales).";

export const LINK_TIKTOK_ACCOUNT_STEPS =
  "In TikTok Business Center go to Accounts > TikTok accounts and link the TikTok account the ad should post as, then give that TikTok account access to this ad account.";

const tiktokId = z.string().regex(/^\d{1,32}$/, "must be a numeric TikTok id");
const identityId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "must be a TikTok identity id");
const videoId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, "must be a TikTok video id");

export const tiktokLaunchBody = z
  .object({
    ...advancedGroupShape,
    advertiser_id: tiktokId,
    advertiser_name: z.string().min(1).max(300),
    campaign_type: z.enum(TIKTOK_LAUNCH_CAMPAIGN_TYPES),
    name: z.string().min(1).max(80),
    locations: z.array(z.object({ location_id: tiktokId, country_code: z.string().regex(/^[A-Z]{2}$/), name: z.string().min(1).max(200), level: z.string().max(20).optional() })).min(1).max(TIKTOK_MAX_LOCATIONS),
    age_groups: tiktokAgeGroupsSchema.optional(),
    gender: tiktokGenderSchema.optional(),
    languages: tiktokLanguagesSchema.optional(),
    language_names: z.array(z.string().min(1).max(100)).max(50).optional(),
    daily_budget_usd: z.number().positive().max(TIKTOK_MAX_DAILY_USD),
    budget_mode: z.literal("BUDGET_MODE_DYNAMIC_DAILY_BUDGET").optional(),
    start_time: z.string().datetime({ offset: true }),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    video: z.object({
      video_id: videoId,
      source: z.enum(["zavi", "link", "upload", "library"]),
      artifact_id: z.string().uuid().optional(),
      link_host: z.string().max(253).optional(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      duration_s: z.number().positive(),
    }),
    identity: z.object({
      identity_id: identityId,
      identity_type: z.enum(USABLE_IDENTITY_TYPES),
      identity_authorized_bc_id: tiktokId.optional(),
      display_name: z.string().max(200).nullable(),
    }),
    ad_text: z.string().min(1).max(100),
    call_to_action: z.enum(TIKTOK_LAUNCH_CTAS),
    landing_url: z.string().url().max(2000),
    hold_estimate_usd: z.number().nonnegative().nullable(),
    rationale: z.string().min(1).max(1000),
    origin: z.enum(["specialist", "user_initiated_ledger"]).default("specialist"),
  })
  .strict()
  .refine((b) => aboveFloor(b.daily_budget_usd, "ad_group"), "the daily budget must be above TikTok's ad group floor")
  .refine((b) => b.identity.identity_type !== "BC_AUTH_TT" || !!b.identity.identity_authorized_bc_id, "a Business Center identity names its Business Center")
  .refine((b) => b.landing_url.startsWith("https://"), "the landing page must be https")
  .refine((b) => !b.end_date || Date.parse(`${b.end_date}T00:00:00Z`) > Date.parse(b.start_time) + 3_600_000, "the end date must be after the start");

export type TiktokLaunchBody = z.infer<typeof tiktokLaunchBody>;

export function launchRefusal(code: string, what: string, fix?: string): ExpectedToolError {
  return new ExpectedToolError(code, fix ? `${what} Fix: ${fix}` : what, fix ? { fix } : undefined);
}

export function floorRefusal(dailyUsd: number): ExpectedToolError | null {
  if (aboveFloor(dailyUsd, "ad_group")) return null;
  return launchRefusal(
    "tiktok_ads_budget_below_floor",
    `A $${dailyUsd.toFixed(2)} daily budget is not above TikTok's floor: an ad group's daily budget must be more than $${TIKTOK_MIN_DAILY_USD.ad_group}.`,
    `choose a daily budget above $${TIKTOK_MIN_DAILY_USD.ad_group}.`,
  );
}

export type VideoFacts = { width: number | null; height: number | null; duration_s: number | null; allowed_placements: string[] | null; displayable: boolean | null };

export function videoRefusal(v: VideoFacts): ExpectedToolError | null {
  const fix = "use Zavi's supported video profile: vertical 9:16, 5 to 60 seconds (AI UGC Videos makes one).";
  if (v.width === null || v.height === null || v.duration_s === null || v.allowed_placements === null) {
    return launchRefusal("tiktok_ads_video_unreadable", "TikTok has not reported this video's size, length and placements yet.", "try again in a minute; if it persists, use another video.");
  }
  if (v.displayable === false) return launchRefusal("tiktok_ads_video_unusable", "TikTok says this video cannot be shown in an ad.", fix);
  const ratio = v.width / v.height;
  if (!(v.height > v.width) || Math.abs(ratio - VIDEO_SPEC.ratio) > VIDEO_SPEC.ratioTolerance) {
    return launchRefusal("tiktok_ads_video_not_vertical", `This video is ${v.width}x${v.height}, not vertical 9:16.`, fix);
  }
  if (v.duration_s < VIDEO_SPEC.minSeconds || v.duration_s > VIDEO_SPEC.maxSeconds) {
    return launchRefusal("tiktok_ads_video_length", `This video runs ${v.duration_s} seconds; Zavi currently supports videos of 5 to 60 seconds.`, fix);
  }
  if (!v.allowed_placements.includes(VIDEO_SPEC.placement)) {
    return launchRefusal("tiktok_ads_video_placement", "TikTok does not allow this video on the TikTok placement itself.", fix);
  }
  return null;
}

export function tiktokLaunchTag(actionId: string): string {
  const hex = actionId.replace(/[^0-9a-f]/gi, "").toLowerCase();
  if (hex.length < 10) throw new ExpectedToolError("tiktok_ads_body_invalid", "This launch card's id cannot tag a launch. Nothing was created.");
  return `zv${hex.slice(0, 10)}`;
}

const NAME_MAX = 100;

export function taggedLaunchName(base: string, level: "campaign" | "ad group" | "ad", tag: string): string {
  const suffix = ` · ${level} · ${tag}`;
  const clean = `Zavi · ${base.replace(/\s+/g, " ").trim() || "TikTok launch"}`;
  return `${clean.slice(0, NAME_MAX - suffix.length)}${suffix}`;
}

export const nameHasTag = (name: unknown, tag: string): boolean => typeof name === "string" && name.includes(tag);

export function withLaunchUtm(landingUrl: string, tag: string): string {
  const u = new URL(landingUrl);
  const add = (k: string, v: string) => {
    if (!u.searchParams.has(k)) u.searchParams.append(k, v);
  };
  add("utm_source", "tiktok");
  add("utm_medium", "paid_social");
  if (u.searchParams.has("utm_campaign")) add("zavi_launch", tag);
  else add("utm_campaign", tag);
  return u.toString();
}

export function isUsableTimeZone(tz: string | null | undefined): tz is string {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function scheduleWireTime(iso: string, kind: "start" | "end"): string {
  const ms = Date.parse(iso);
  const limit = Date.parse(kind === "start" ? "2028-01-01T00:00:00Z" : "2038-01-01T00:00:00Z");
  if (!Number.isFinite(ms) || ms > limit || ms % 1000 !== 0) throw launchRefusal("tiktok_ads_schedule_invalid", `Choose a valid ${kind} time with whole seconds, no later than ${kind === "start" ? "2028" : "2038"}-01-01 UTC.`);
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

export function scheduleStart(startIso: string, now: Date, timeZone: string): string {
  if (!isUsableTimeZone(timeZone)) throw new ExpectedToolError("tiktok_ads_timezone_unknown", `TikTok reports the ad account's time zone as "${timeZone}", which Zavi cannot read. Nothing was created.`);
  const ms = Math.max(Date.parse(startIso), now.getTime() + 5 * 60_000);
  if (!Number.isFinite(ms)) throw launchRefusal("tiktok_ads_schedule_invalid", "Choose a valid start time.");
  return scheduleWireTime(new Date(Math.ceil(ms / 1000) * 1000).toISOString(), "start");
}

export function scheduleEnd(endDate: string, timeZone: string): string {
  if (!isUsableTimeZone(timeZone)) throw new ExpectedToolError("tiktok_ads_timezone_unknown", `TikTok reports the ad account's time zone as "${timeZone}", which Zavi cannot read. Nothing was created.`);
  const iso = `${endDate}T00:00:00Z`;
  if (!Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString().slice(0, 10) !== endDate) throw launchRefusal("tiktok_ads_schedule_invalid", "Choose a valid end date.");
  return scheduleWireTime(iso, "end");
}

export function launchHoldUsd(dailyUsd: number, daysLeft: number, margin: number, flightDays?: number, deliveryFactor: 1 | 1.25 = 1): number {
  const daily = Math.ceil(Number((dailyUsd * deliveryFactor * 100).toFixed(6))) / 100;
  const days = flightDays != null && flightDays >= 0 ? Math.min(daysLeft, flightDays) : daysLeft;
  return Math.ceil(Number((daily * days * margin * 100).toFixed(6))) / 100;
}

export function flightDaysTo(endDate: unknown, now: Date): number | undefined {
  if (typeof endDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return undefined;
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.max(0, Math.round((Date.parse(`${endDate}T00:00:00Z`) - today) / 86_400_000));
}

export type LaunchState = "live" | "pending_review" | "scheduled" | "disapproved" | "on_unconfirmed";

export function launchState(s: { campaign: string | null; ad_group: string | null; ad: string | null }): LaunchState {
  const all = [s.campaign, s.ad_group, s.ad].map((x) => String(x ?? "").toUpperCase());
  const ad = String(s.ad ?? "").toUpperCase();
  if (all.some((x) => /DENY|REJECT/.test(x))) return "disapproved";
  if (all.some((x) => /AUDIT|REVIEW/.test(x) && !/DELIVERY_OK$/.test(x))) return "pending_review";
  if (all.some((x) => /NOT_START/.test(x))) return "scheduled";
  if (/^AD_STATUS_(PARTIAL_AUDIT_)?DELIVERY_OK$/.test(ad) && !all.some((x) => /DISABLE|BALANCE|EXCEED|FROZEN|PUNISH|CONTRACT|NOT_DELIVER/.test(x))) return "live";
  return "on_unconfirmed";
}
