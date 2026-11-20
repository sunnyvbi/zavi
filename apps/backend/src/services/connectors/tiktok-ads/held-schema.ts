
import { z } from "zod";
import { adConstraint } from "@zavi/shared";

export const TIKTOK_UPDATE_BUDGET_CLASS = "tiktok_ads.update_budget";
export const TIKTOK_SET_STATUS_CLASS = "tiktok_ads.set_status";
export const TIKTOK_HELD_CLASSES: ReadonlySet<string> = new Set([TIKTOK_UPDATE_BUDGET_CLASS, TIKTOK_SET_STATUS_CLASS]);
export const TIKTOK_CREATE_LAUNCH_CLASS = "tiktok_ads.create_launch";
export const TIKTOK_CHAT_EDIT_CLASSES: ReadonlySet<string> = new Set([TIKTOK_UPDATE_BUDGET_CLASS, TIKTOK_SET_STATUS_CLASS]);

export const TIKTOK_MIN_DAILY_USD = { campaign: 50, ad_group: adConstraint("tiktok_ads")!.min_daily_usd } as const;
export const TIKTOK_MAX_DAILY_USD = 100_000;

const tiktokId = z.string().regex(/^\d{1,32}$/, "must be a numeric TikTok id");
export const tiktokLevel = z.enum(["campaign", "ad_group"]);
export type TiktokLevel = z.infer<typeof tiktokLevel>;
export const tiktokStatusLevel = z.enum(["campaign", "ad_group", "ad"]);
export type TiktokStatusLevel = z.infer<typeof tiktokStatusLevel>;

const common = {
  advertiser_id: tiktokId,
  advertiser_name: z.string().min(1).max(300),
  object_id: tiktokId,
  campaign_id: tiktokId,
  ad_group_id: tiktokId.optional(),
  ad_id: tiktokId.optional(),
  name: z.string().min(1).max(512),
  rationale: z.string().min(1).max(1000),
  origin: z.enum(["specialist", "user_initiated_chat", "user_initiated_ledger"]).default("specialist"),
};

export function aboveFloor(dailyUsd: number, level: TiktokLevel): boolean {
  return Math.round(dailyUsd * 100) > TIKTOK_MIN_DAILY_USD[level] * 100;
}

function idsAgree(b: { level: TiktokStatusLevel; object_id: string; campaign_id: string; ad_group_id?: string; ad_id?: string }): boolean {
  if (b.level === "campaign") return b.ad_group_id === undefined && b.ad_id === undefined && b.object_id === b.campaign_id;
  if (b.level === "ad_group") return b.ad_id === undefined && b.ad_group_id === b.object_id;
  return b.ad_group_id !== undefined && b.ad_id === b.object_id;
}

export const tiktokBudgetBody = z
  .object({
    ...common,
    level: tiktokLevel,
    expected_current_daily_budget_usd: z.number().positive(),
    expected_current_status: z.string().min(1),
    expected_current_budget_mode: z.string().optional(),
    daily_budget_usd: z.number().positive().max(TIKTOK_MAX_DAILY_USD),
  })
  .strict()
  .refine(idsAgree, "object ids do not match the level")
  .refine((b) => aboveFloor(b.daily_budget_usd, b.level), "not above TikTok's daily budget floor")
  .refine((b) => Math.round(b.daily_budget_usd * 100) !== Math.round(b.expected_current_daily_budget_usd * 100), "the budget does not change");

export const tiktokStatusBody = z
  .object({
    ...common,
    level: tiktokStatusLevel,
    status: z.enum(["ACTIVE", "PAUSED"]),
    expected_current_status: z.enum(["ACTIVE", "PAUSED"]),
    daily_budget_usd: z.number().nonnegative().nullable(),
    resume_plan: z.object({
      revision: z.string().regex(/^[a-f0-9]{64}$/),
      sources: z.array(z.object({ object_id: tiktokId, level: tiktokLevel, daily_budget_usd: z.number().positive(), budget_mode: z.string() }).strict()).max(20000),
    }).strict().optional(),
  })
  .strict()
  .refine(idsAgree, "object ids do not match the level")
  .refine((b) => b.status !== b.expected_current_status, "the status does not change")
  .refine((b) => b.status === "PAUSED" || b.daily_budget_usd !== null, "a resume needs the object's daily budget")
  .refine((b) => b.status === "PAUSED" || b.resume_plan !== undefined || (b.daily_budget_usd ?? 0) > 0, "a legacy resume needs a positive daily budget")
  .refine((b) => b.level !== "ad" || b.status === "PAUSED" || b.resume_plan !== undefined, "an ad resume needs its parent budget snapshot");

const RUNNER_KEYS = [
  "brain_citations",
  "playbook_run_id",
  "on_goal_hint",
  "metadata",
  "tone",
  "summary",
  "confidence",
  "label",
  "caveat",
  "note",
  "framing",
  "headline",
  "severity",
  "disclaimer",
] as const;

export function tiktokActionFields(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const out = { ...(body as Record<string, unknown>) };
  for (const k of RUNNER_KEYS) delete out[k];
  return out;
}

export type TiktokBudgetBody = z.infer<typeof tiktokBudgetBody>;
export type TiktokStatusBody = z.infer<typeof tiktokStatusBody>;

export function tiktokActionRaisesSpend(cls: string | null | undefined, body: unknown): boolean {
  if (cls === "tiktok_ads.update_settings") return true;
  if (cls === TIKTOK_CREATE_LAUNCH_CLASS) return true;
  if (cls !== TIKTOK_UPDATE_BUDGET_CLASS && cls !== TIKTOK_SET_STATUS_CLASS) return false;
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (cls === TIKTOK_SET_STATUS_CLASS) return b.status !== "PAUSED";
  const to = Number(b.daily_budget_usd);
  const from = Number(b.expected_current_daily_budget_usd);
  return !(Number.isFinite(to) && Number.isFinite(from) && to <= from);
}

const RAW_READ = /^(GET|LIST|SEARCH|FETCH|QUERY|CHECK|ESTIMATE|PREVIEW|REPORT|RUN_REPORT|DOWNLOAD)(_|$)/;
const RAW_SPEND_OBJECT = /(CAMPAIGN|ADGROUP|AD_GROUP|SMART_PLUS|GMV_MAX|BUDGET|BID|SPEND|STATUS|(^|_)ADS?(_|$))/;

export function isTiktokSpendWrite(slug: string, toolkit?: string | null): boolean {
  const s = slug.trim().toUpperCase();
  const prefixed = s.startsWith("TIKTOK_ADS_");
  if (!prefixed && toolkit?.toLowerCase() !== "tiktok_ads") return false;
  const rest = prefixed ? s.slice("TIKTOK_ADS_".length) : s;
  return !RAW_READ.test(rest) && RAW_SPEND_OBJECT.test(rest);
}

export const TIKTOK_RAW_WRITE_MESSAGE =
  "TikTok Ads budgets and on/off are changed only through tiktok_ads__propose_budget_change and tiktok_ads__propose_status_change, and a new campaign only through tiktok_ads__propose_launch, on a TikTok Ads channel run, which check the shared ad budget first. Nothing was sent and nothing was proposed.";
