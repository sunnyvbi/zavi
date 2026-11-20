
import { composioProxy, type OwnedComposioAccount } from "@/services/connectors/composio/api";
import { ExpectedToolError } from "@/services/tools/types";
import { tiktokAdsErrorCode } from "./errors";
import { tt } from "./composio-read";
import { advancedGroupKeys } from "./campaign-advanced";
import type { TiktokLevel, TiktokStatusLevel } from "./held-schema";

const WRITE_TIMEOUT_MS = 60_000;
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;

export type TiktokObject = {
  level: TiktokStatusLevel;
  id: string;
  campaign_id: string;
  ad_group_id: string | null;
  name: string;
  status: string;
  secondary_status?: string | null;
  budget: number | null;
  budget_mode: string | null;
};

const q = (v: unknown) => encodeURIComponent(typeof v === "string" ? v : JSON.stringify(v));
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);

export function isDailyMode(mode: string | null): boolean {
  return mode === "BUDGET_MODE_DAY" || mode === "BUDGET_MODE_DYNAMIC_DAILY_BUDGET";
}

export function tiktokDeliveryFactor(mode: string | null): 1 | 1.25 {
  return mode === "BUDGET_MODE_DYNAMIC_DAILY_BUDGET" ? 1.25 : 1;
}

function statusOf(operation: unknown, secondary: unknown): string {
  if (typeof secondary === "string" && secondary.includes("DELETE")) return "DELETED";
  if (operation === "ENABLE") return "ACTIVE";
  if (operation === "DISABLE") return "PAUSED";
  return str(operation) ?? "UNKNOWN";
}

function budgetOf(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const FIELDS: Record<TiktokStatusLevel, string[]> = {
  campaign: ["campaign_id", "campaign_name", "operation_status", "secondary_status", "budget", "budget_mode"],
  ad_group: ["adgroup_id", "adgroup_name", "campaign_id", "operation_status", "secondary_status", "budget", "budget_mode"],
  ad: ["ad_id", "ad_name", "adgroup_id", "campaign_id", "operation_status", "secondary_status"],
};
const ID_KEY: Record<TiktokStatusLevel, string> = { campaign: "campaign_id", ad_group: "adgroup_id", ad: "ad_id" };
const NAME_KEY: Record<TiktokStatusLevel, string> = { campaign: "campaign_name", ad_group: "adgroup_name", ad: "ad_name" };
const GET_PATH: Record<TiktokStatusLevel, string> = { campaign: "/campaign/get/", ad_group: "/adgroup/get/", ad: "/ad/get/" };

function toObject(level: TiktokStatusLevel, r: Record<string, unknown>): TiktokObject | null {
  const id = str(r[ID_KEY[level]]);
  const campaign = str(r.campaign_id);
  if (!id || !campaign) return null;
  return {
    level,
    id,
    campaign_id: campaign,
    ad_group_id: level === "campaign" ? null : str(r.adgroup_id),
    name: str(r[NAME_KEY[level]]) ?? id,
    status: statusOf(r.operation_status, r.secondary_status),
    secondary_status: str(r.secondary_status),
    budget: budgetOf(r.budget),
    budget_mode: str(r.budget_mode),
  };
}

function rows(data: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(data.list) || !data.list.every((r) => !!r && typeof r === "object" && !Array.isArray(r))) throw new ExpectedToolError("tiktok_ads_bad_response", "TikTok returned an invalid object list. Try again later.");
  return data.list;
}

export async function readTiktokObject(account: OwnedComposioAccount, advertiserId: string, level: TiktokStatusLevel, id: string): Promise<TiktokObject | null> {
  const path = GET_PATH[level];
  const filtering = level === "campaign" ? { campaign_ids: [id] } : level === "ad_group" ? { adgroup_ids: [id] } : { ad_ids: [id] };
  const data = await tt(account, `${path}?advertiser_id=${q(advertiserId)}&filtering=${q(filtering)}&fields=${q(FIELDS[level])}&page_size=10`);
  const found = rows(data).map((r) => toObject(level, r)).filter((o): o is TiktokObject => o !== null && o.id === id);
  return found[0] ?? null;
}

export async function listTiktokAdGroups(account: OwnedComposioAccount, advertiserId: string, campaignIds?: string[]): Promise<TiktokObject[]> {
  return listTiktokChildren(account, advertiserId, "ad_group", campaignIds);
}

export async function listTiktokAds(account: OwnedComposioAccount, advertiserId: string, campaignIds: string[]): Promise<TiktokObject[]> {
  return listTiktokChildren(account, advertiserId, "ad", campaignIds);
}

async function listTiktokChildren(account: OwnedComposioAccount, advertiserId: string, level: "ad_group" | "ad", campaignIds?: string[]): Promise<TiktokObject[]> {
  const filtering = campaignIds ? `&filtering=${q({ campaign_ids: campaignIds })}` : "";
  const out: TiktokObject[] = [];
  let total = 1;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await tt(account, `${GET_PATH[level]}?advertiser_id=${q(advertiserId)}${filtering}&fields=${q(FIELDS[level])}&page=${page}&page_size=${PAGE_SIZE}`);
    const batch = rows(data);
    for (const r of batch) {
      const o = toObject(level, r);
      if (!o) throw new ExpectedToolError("tiktok_ads_bad_response", "TikTok returned a child object without its id or campaign.");
      out.push(o);
    }
    const info = data.page_info && typeof data.page_info === "object" ? (data.page_info as { total_page?: unknown }) : {};
    if ((info.total_page !== undefined && (typeof info.total_page !== "number" || !Number.isInteger(info.total_page) || info.total_page < 0)) || (page === 1 && info.total_page === undefined && batch.length >= PAGE_SIZE)) throw new ExpectedToolError("tiktok_ads_bad_response", "TikTok returned incomplete object pagination.");
    total = Math.max(total, typeof info.total_page === "number" ? info.total_page : 1);
    if (total > MAX_PAGES) break;
    if (page >= total) return out;
  }
  throw new ExpectedToolError("tiktok_ads_read_failed", `TikTok returned more than ${MAX_PAGES} pages of ${level === "ad" ? "ads" : "ad groups"}.`);
}

export async function tiktokPost(account: OwnedComposioAccount, endpoint: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await composioProxy({ account, method: "POST", endpoint, body }, AbortSignal.timeout(WRITE_TIMEOUT_MS));
  if (!r.ok) {
    if (r.status === 0 || r.status >= 500) {
      throw new ExpectedToolError("tiktok_ads_outcome_unknown", `TikTok did not answer the change (HTTP ${r.status || "no response"}). It may have landed.`);
    }
    if (r.status === 401 || r.status === 403) throw new ExpectedToolError("tiktok_ads_token_revoked", "TikTok Ads needs to be reconnected. Nothing was changed.");
    if (r.status === 429) throw new ExpectedToolError("tiktok_ads_rate_limited", "TikTok rate-limited the change. Nothing was changed; approve again later.");
    throw new ExpectedToolError("tiktok_ads_write_refused", `TikTok refused the change (HTTP ${r.status}). Nothing was changed.`);
  }
  const code = (r.json as { code?: unknown }).code;
  if (typeof code !== "number") {
    throw new ExpectedToolError("tiktok_ads_outcome_unknown", "TikTok answered the change without a result code. It may have landed.");
  }
  if (code === 0) {
    const data = (r.json as { data?: unknown }).data;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : { list: Array.isArray(data) ? data : [] };
  }
  const mapped = tiktokAdsErrorCode(code);
  const message = typeof (r.json as { message?: unknown }).message === "string" ? String((r.json as { message: string }).message).slice(0, 300) : "unknown error";
  const meta = { tiktok_code: code, tiktok_message: message };
  if (mapped === "tiktok_ads_token_invalid") throw new ExpectedToolError("tiktok_ads_token_revoked", "TikTok Ads needs to be reconnected. Nothing was changed.", meta);
  if (mapped === "tiktok_ads_rate_limited") throw new ExpectedToolError("tiktok_ads_rate_limited", "TikTok rate-limited the change. Nothing was changed; approve again later.", meta);
  throw new ExpectedToolError("tiktok_ads_write_refused", `TikTok refused the change (code ${code}: ${message}). Nothing was changed.`, meta);
}

export async function writeTiktokDailyBudget(account: OwnedComposioAccount, advertiserId: string, level: TiktokLevel, id: string, dailyUsd: number): Promise<void> {
  const budget = Math.round(dailyUsd * 100) / 100;
  if (level === "campaign") await tiktokPost(account, "/campaign/update/", { advertiser_id: advertiserId, campaign_id: id, budget });
  else await tiktokPost(account, "/adgroup/budget/update/", { advertiser_id: advertiserId, budget: [{ adgroup_id: id, budget }] });
}

export async function writeTiktokStatus(account: OwnedComposioAccount, advertiserId: string, level: TiktokStatusLevel, id: string, status: "ACTIVE" | "PAUSED"): Promise<void> {
  const operation_status = status === "ACTIVE" ? "ENABLE" : "DISABLE";
  if (level === "campaign") await tiktokPost(account, "/campaign/status/update/", { advertiser_id: advertiserId, campaign_ids: [id], operation_status });
  else if (level === "ad_group") await tiktokPost(account, "/adgroup/status/update/", { advertiser_id: advertiserId, adgroup_ids: [id], operation_status });
  else await tiktokPost(account, "/ad/status/update/", { advertiser_id: advertiserId, ad_ids: [id], operation_status });
}

export type LaunchLevel = "campaign" | "ad_group" | "ad";

export type LaunchObject = {
  level: LaunchLevel;
  id: string;
  name: string | null;
  campaign_id: string | null;
  adgroup_id: string | null;
  operation_status: string | null;
  secondary_status: string | null;
  raw: Record<string, unknown>;
};

const LAUNCH_PATH: Record<LaunchLevel, { get: string; status: string; idField: string; idsKey: string; nameField: string }> = {
  campaign: { get: "/campaign/get/", status: "/campaign/status/update/", idField: "campaign_id", idsKey: "campaign_ids", nameField: "campaign_name" },
  ad_group: { get: "/adgroup/get/", status: "/adgroup/status/update/", idField: "adgroup_id", idsKey: "adgroup_ids", nameField: "adgroup_name" },
  ad: { get: "/ad/get/", status: "/ad/status/update/", idField: "ad_id", idsKey: "ad_ids", nameField: "ad_name" },
};

const LAUNCH_FIELDS: Record<LaunchLevel, string[]> = {
  campaign: ["campaign_id", "campaign_name", "operation_status", "secondary_status", "objective_type", "budget_mode", "budget"],
  ad_group: ["adgroup_id", "adgroup_name", "campaign_id", "operation_status", "secondary_status", "budget", "budget_mode", "location_ids", "age_groups", "gender", "languages", "placements", "optimization_goal", "schedule_type", "schedule_start_time", "schedule_end_time", ...advancedGroupKeys],
  ad: ["ad_id", "ad_name", "adgroup_id", "campaign_id", "operation_status", "secondary_status", "landing_page_url", "video_id", "identity_id", "ad_text", "call_to_action"],
};

function toLaunchObject(level: LaunchLevel, r: Record<string, unknown>): LaunchObject | null {
  const p = LAUNCH_PATH[level];
  const id = str(r[p.idField]);
  if (!id) return null;
  return {
    level,
    id,
    name: str(r[p.nameField]),
    campaign_id: str(r.campaign_id) ?? (level === "campaign" ? id : null),
    adgroup_id: str(r.adgroup_id) ?? (level === "ad_group" ? id : null),
    operation_status: str(r.operation_status),
    secondary_status: str(r.secondary_status),
    raw: r,
  };
}

export const isDeleted = (o: LaunchObject): boolean => (o.secondary_status ?? "").includes("DELETE");

export async function readLaunchObject(account: OwnedComposioAccount, advertiserId: string, level: LaunchLevel, id: string): Promise<LaunchObject | null> {
  const p = LAUNCH_PATH[level];
  const data = await tt(account, `${p.get}?advertiser_id=${q(advertiserId)}&filtering=${q({ [p.idsKey]: [id] })}&fields=${q(LAUNCH_FIELDS[level])}&page_size=10`);
  return rows(data).map((r) => toLaunchObject(level, r)).find((o): o is LaunchObject => o !== null && o.id === id) ?? null;
}

export async function findTaggedObjects(account: OwnedComposioAccount, advertiserId: string, level: LaunchLevel, tag: string, campaignId?: string): Promise<LaunchObject[]> {
  return findNamedObjects(account, advertiserId, level, (name) => name.includes(tag), campaignId);
}

export async function findLaunchCampaigns(account: OwnedComposioAccount, advertiserId: string, matches: (name: string) => boolean): Promise<LaunchObject[]> {
  return findNamedObjects(account, advertiserId, "campaign", matches);
}

async function findNamedObjects(account: OwnedComposioAccount, advertiserId: string, level: LaunchLevel, matches: (name: string) => boolean, campaignId?: string): Promise<LaunchObject[]> {
  const p = LAUNCH_PATH[level];
  const filtering = campaignId ? `&filtering=${q({ campaign_ids: [campaignId] })}` : "";
  const out: LaunchObject[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await tt(account, `${p.get}?advertiser_id=${q(advertiserId)}${filtering}&fields=${q(LAUNCH_FIELDS[level])}&page=${page}&page_size=${PAGE_SIZE}`);
    for (const r of rows(data)) {
      const o = toLaunchObject(level, r);
      if (o && typeof o.name === "string" && matches(o.name)) out.push(o);
    }
    const info = data.page_info && typeof data.page_info === "object" ? (data.page_info as { total_page?: unknown }) : {};
    const total = typeof info.total_page === "number" ? info.total_page : 1;
    if (page >= total) return out;
  }
  throw new ExpectedToolError("tiktok_ads_read_failed", `TikTok returned more than ${MAX_PAGES} pages of ${level}s.`);
}

export async function setLaunchStatus(account: OwnedComposioAccount, advertiserId: string, level: LaunchLevel, id: string, status: "ENABLE" | "DISABLE"): Promise<void> {
  const p = LAUNCH_PATH[level];
  await tiktokPost(account, p.status, { advertiser_id: advertiserId, [p.idsKey]: [id], operation_status: status });
}
