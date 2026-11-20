
import { composioProxy, type OwnedComposioAccount } from "@/services/connectors/composio/api";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { ExpectedToolError } from "@/services/tools/types";
import { tiktokAdsErrorCode } from "./errors";

const PAGE_SIZE = 50;
const MAX_PAGES = 20;
const MAX_ADVERTISERS = 200;
const INFO_BATCH = 100;
export const ADVERTISER_INFO_FIELDS = ["advertiser_id", "name", "currency", "status", "timezone"];
const REPORT_METRICS = ["spend", "impressions", "clicks", "conversion", "total_complete_payment_rate"] as const;

export type TiktokSums = { spend: number; impressions: number; clicks: number; conversions: number; conv_value: number };

export type TiktokAdvertiser = {
  advertiser_id: string;
  name: string;
  currency: string | null;
  status: string | null;
  timezone: string | null;
};

export type TiktokCampaignRow = {
  campaign_id: string;
  name: string;
  status: "ACTIVE" | "PAUSED" | "DELETED" | string;
  secondary_status: string | null;
  objective: string | null;
  budget: number | null;
  budget_mode: string | null;
};

export const ZERO_SUMS: TiktokSums = { spend: 0, impressions: 0, clicks: 0, conversions: 0, conv_value: 0 };

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const q = (v: unknown) => encodeURIComponent(typeof v === "string" ? v : JSON.stringify(v));

export function addSums(a: TiktokSums, b: TiktokSums): TiktokSums {
  return {
    spend: a.spend + b.spend,
    impressions: a.impressions + b.impressions,
    clicks: a.clicks + b.clicks,
    conversions: a.conversions + b.conversions,
    conv_value: a.conv_value + b.conv_value,
  };
}

export async function tiktokAdsAccount(tenantId: string): Promise<OwnedComposioAccount> {
  const account = await resolveOwnedComposioAccount(tenantId, "tiktok_ads");
  if (!account) {
    throw new ExpectedToolError(
      "tiktok_ads_not_connected",
      "TikTok Ads is not connected for this workspace. Connect it from the TikTok Ads channel page.",
    );
  }
  return account;
}

export async function tt(account: OwnedComposioAccount, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await composioProxy(body ? { account, method: "POST", endpoint: path, body } : { account, method: "GET", endpoint: path });
  if (!r.ok) {
    throw new ExpectedToolError(
      r.status === 401 || r.status === 403 ? "tiktok_ads_token_revoked" : "tiktok_ads_read_failed",
      `TikTok read failed (HTTP ${r.status}).`,
    );
  }
  const envelope: unknown = r.json;
  if (!isRecord(envelope) || typeof envelope.code !== "number" || !Number.isInteger(envelope.code)) {
    throw badResponse();
  }
  const code = envelope.code;
  if (code !== 0) {
    const errorCode = tiktokAdsErrorCode(code);
    throw new ExpectedToolError(
      errorCode === "tiktok_ads_token_invalid" ? "tiktok_ads_token_revoked" : errorCode,
      `TikTok answered code ${code}: ${str(envelope.message) ?? "unknown error"}`,
    );
  }
  if (!isRecord(envelope.data)) throw badResponse();
  return envelope.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function badResponse(): ExpectedToolError {
  return new ExpectedToolError("tiktok_ads_bad_response", "TikTok returned an invalid report response. Try again later.");
}

function list(data: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(data.list) || !data.list.every(isRecord)) throw badResponse();
  return data.list;
}

function totalPages(data: Record<string, unknown>): number {
  const info = isRecord(data.page_info) ? data.page_info : {};
  const total = typeof info.total_page === "number" && Number.isInteger(info.total_page) ? info.total_page : 1;
  return Math.min(Math.max(total, 1), MAX_PAGES);
}

async function allPages(account: OwnedComposioAccount, path: string, complete = false): Promise<Record<string, unknown>[]> {
  const sep = path.includes("?") ? "&" : "?";
  const at = (page: number) => tt(account, `${path}${sep}page=${page}&page_size=${complete ? 1000 : PAGE_SIZE}`);
  const first = await at(1);
  const rows = [...list(first)];
  let data = first;
  let pages = 1;
  for (let page = 1; ; page++) {
    const info = isRecord(data.page_info) ? data.page_info : {};
    if (complete && page === 1 && info.total_page === undefined && rows.length >= 1000) throw badResponse();
    if (complete && info.total_page !== undefined && (typeof info.total_page !== "number" || !Number.isInteger(info.total_page) || info.total_page < 0)) throw badResponse();
    if (complete && typeof info.total_page === "number" && info.total_page > MAX_PAGES) {
      throw new ExpectedToolError("tiktok_ads_read_failed", `TikTok returned more than ${MAX_PAGES} pages; the report is incomplete.`);
    }
    pages = Math.max(pages, totalPages(data));
    if (page >= pages) break;
    data = await at(page + 1);
    rows.push(...list(data));
  }
  return rows;
}

export async function listBusinessCenterIds(account: OwnedComposioAccount): Promise<string[]> {
  return (await allPages(account, "/bc/get/"))
    .map((b) => (b.bc_info as { bc_id?: unknown } | undefined)?.bc_id)
    .filter((id): id is string => typeof id === "string");
}

export async function listAdvertiserIds(account: OwnedComposioAccount): Promise<string[]> {
  const bcs = await listBusinessCenterIds(account);
  const assets = await Promise.all(bcs.map((bc) => allPages(account, `/bc/asset/get/?bc_id=${q(bc)}&asset_type=ADVERTISER`)));
  const ids = new Set<string>();
  for (const a of assets.flat()) if (typeof a.asset_id === "string" && /^\d{1,32}$/.test(a.asset_id)) ids.add(a.asset_id);
  return [...ids].slice(0, MAX_ADVERTISERS);
}

export async function verifyAdvertisers(account: OwnedComposioAccount, ids: string[]): Promise<TiktokAdvertiser[]> {
  const wanted = [...new Set(ids)];
  const out: TiktokAdvertiser[] = [];
  for (let i = 0; i < wanted.length; i += INFO_BATCH) {
    const batch = wanted.slice(i, i + INFO_BATCH);
    const info = list(
      await tt(account, `/advertiser/info/?advertiser_ids=${q(batch)}&fields=${q(ADVERTISER_INFO_FIELDS)}`),
    );
    const byId = new Map(info.map((r) => [String(r.advertiser_id ?? ""), r]));
    for (const id of batch) {
      const r = byId.get(id);
      if (!r) continue;
      out.push({
        advertiser_id: id,
        name: str(r.name) ?? id,
        currency: str(r.currency),
        status: str(r.status)?.replace(/^STATUS_/, "") ?? null,
        timezone: str(r.timezone),
      });
    }
  }
  return out;
}

const ADVERTISER_GEO_FIELDS = ["advertiser_id", "country", "display_timezone"];

export type TiktokAdvertiserGeo = { advertiser_id: string; country: string | null; display_timezone: string | null };

export async function readAdvertiserGeo(account: OwnedComposioAccount, ids: string[]): Promise<TiktokAdvertiserGeo[]> {
  const wanted = [...new Set(ids)];
  const out: TiktokAdvertiserGeo[] = [];
  for (let i = 0; i < wanted.length; i += INFO_BATCH) {
    const batch = wanted.slice(i, i + INFO_BATCH);
    const info = list(await tt(account, `/advertiser/info/?advertiser_ids=${q(batch)}&fields=${q(ADVERTISER_GEO_FIELDS)}`));
    const byId = new Map(info.map((r) => [String(r.advertiser_id ?? ""), r]));
    for (const id of batch) {
      const r = byId.get(id);
      if (!r) continue;
      out.push({ advertiser_id: id, country: str(r.country), display_timezone: str(r.display_timezone) });
    }
  }
  return out;
}

export async function listAdvertisers(account: OwnedComposioAccount, ids?: string[]): Promise<TiktokAdvertiser[]> {
  const advertiserIds = ids ?? (await listAdvertiserIds(account));
  if (!advertiserIds.length) return [];
  const info = list(
    await tt(
      account,
      `/advertiser/info/?advertiser_ids=${q(advertiserIds)}&fields=${q(ADVERTISER_INFO_FIELDS)}`,
    ),
  );
  const byId = new Map(info.map((i) => [String(i.advertiser_id ?? ""), i]));
  return advertiserIds.map((id) => {
    const i = byId.get(id) ?? {};
    return {
      advertiser_id: id,
      name: str(i.name) ?? id,
      currency: str(i.currency),
      status: str(i.status)?.replace(/^STATUS_/, "") ?? null,
      timezone: str(i.timezone),
    };
  });
}

function campaignStatus(operation: unknown, secondary: unknown): string {
  if (typeof secondary === "string" && secondary.includes("DELETE")) return "DELETED";
  if (operation === "ENABLE") return "ACTIVE";
  if (operation === "DISABLE") return "PAUSED";
  return str(operation) ?? "UNKNOWN";
}

export async function listCampaigns(account: OwnedComposioAccount, advertiserId: string): Promise<TiktokCampaignRow[]> {
  const rows = await allPages(account, `/campaign/get/?advertiser_id=${q(advertiserId)}`, true);
  return rows.flatMap((r) => {
    const id = str(r.campaign_id);
    if (!id) return [];
    return [
      {
        campaign_id: id,
        name: str(r.campaign_name) ?? id,
        status: campaignStatus(r.operation_status, r.secondary_status),
        secondary_status: str(r.secondary_status),
        objective: str(r.objective_type),
        budget: typeof r.budget === "number" || typeof r.budget === "string" ? num(r.budget) : null,
        budget_mode: str(r.budget_mode),
      },
    ];
  });
}

const VIEWS_METRIC = "video_watched_2s";
const REPORT_LEVELS = {
  campaign: ["AUCTION_CAMPAIGN", "campaign_id"],
  ad_group: ["AUCTION_ADGROUP", "adgroup_id"],
  ad: ["AUCTION_AD", "ad_id"],
} as const;
export type TiktokReportLevel = keyof typeof REPORT_LEVELS;
export type TiktokViewSums = TiktokSums & { views: number | null };

async function levelReport(
  account: OwnedComposioAccount,
  advertiserId: string,
  level: TiktokReportLevel,
  from: string,
  to: string,
  withViews: boolean,
): Promise<Map<string, TiktokViewSums>> {
  const [dataLevel, dim] = REPORT_LEVELS[level];
  const metrics = withViews ? [...REPORT_METRICS, VIEWS_METRIC] : REPORT_METRICS;
  const path =
    `/report/integrated/get/?advertiser_id=${q(advertiserId)}&report_type=BASIC&data_level=${dataLevel}` +
    `&dimensions=${q([dim])}&metrics=${q(metrics)}&start_date=${from}&end_date=${to}`;
  const out = new Map<string, TiktokViewSums>();
  for (const row of await allPages(account, path, true)) {
    const raw = isRecord(row.dimensions) ? row.dimensions[dim] : undefined;
    const id = typeof raw === "number" && level !== "campaign" ? String(raw) : raw;
    const m = (row.metrics ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || !id) throw badResponse();
    const metric = (key: (typeof REPORT_METRICS)[number]): number => {
      const value = strictNum(m[key]);
      if (value === null || value < 0) throw badResponse();
      return value;
    };
    const views = withViews ? strictNum(m[VIEWS_METRIC]) : null;
    out.set(id, {
      spend: metric("spend"),
      impressions: metric("impressions"),
      clicks: metric("clicks"),
      conversions: metric("conversion"),
      conv_value: metric("total_complete_payment_rate"),
      views: views !== null && views >= 0 ? views : null,
    });
  }
  return out;
}

export async function campaignReport(
  account: OwnedComposioAccount,
  advertiserId: string,
  from: string,
  to: string,
): Promise<Map<string, TiktokSums>> {
  const out = new Map<string, TiktokSums>();
  for (const [id, { views: _views, ...sums }] of await levelReport(account, advertiserId, "campaign", from, to, false)) out.set(id, sums);
  return out;
}

export async function viewsReport(
  account: OwnedComposioAccount,
  advertiserId: string,
  level: TiktokReportLevel,
  from: string,
  to: string,
): Promise<Map<string, TiktokViewSums>> {
  try {
    return await levelReport(account, advertiserId, level, from, to, true);
  } catch {
    return levelReport(account, advertiserId, level, from, to, false);
  }
}

export const TIKTOK_EVIDENCE_METRICS = ["spend", "impressions", "clicks", "conversion", "complete_payment", "total_complete_payment_rate", "value_per_complete_payment"] as const;
export type TiktokEvidenceMetric = (typeof TIKTOK_EVIDENCE_METRICS)[number];
export type TiktokStrictRow = Record<TiktokEvidenceMetric, number | null>;
const REPORT_PAGE = 1000;
const REPORT_MAX_PAGES = 10;

function strictNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function strictReport(
  account: OwnedComposioAccount,
  advertiserId: string,
  level: "campaign" | "ad_group",
  from: string,
  to: string,
): Promise<Map<string, TiktokStrictRow>> {
  const dim = level === "campaign" ? "campaign_id" : "adgroup_id";
  const base =
    `/report/integrated/get/?advertiser_id=${q(advertiserId)}&report_type=BASIC&data_level=${level === "campaign" ? "AUCTION_CAMPAIGN" : "AUCTION_ADGROUP"}` +
    `&dimensions=${q([dim])}&metrics=${q(TIKTOK_EVIDENCE_METRICS)}&start_date=${from}&end_date=${to}&page_size=${REPORT_PAGE}`;
  const out = new Map<string, TiktokStrictRow>();
  for (let page = 1; ; page++) {
    const data = await tt(account, `${base}&page=${page}`);
    for (const row of list(data)) {
      const raw = isRecord(row.dimensions) ? row.dimensions[dim] : undefined;
      const id = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : null;
      if (!id) throw badResponse();
      const m = isRecord(row.metrics) ? row.metrics : {};
      const r = Object.fromEntries(TIKTOK_EVIDENCE_METRICS.map((k) => [k, strictNum(m[k])])) as TiktokStrictRow;
      r.total_complete_payment_rate = checkedPurchaseValue(r, `${advertiserId}/${id}`);
      out.set(id, r);
    }
    const info = isRecord(data.page_info) ? data.page_info : {};
    const total = typeof info.total_page === "number" && Number.isInteger(info.total_page) ? info.total_page : 1;
    if (page >= total) return out;
    if (page >= REPORT_MAX_PAGES) {
      throw new ExpectedToolError("tiktok_ads_read_failed", `TikTok returned more than ${REPORT_MAX_PAGES} report pages.`);
    }
  }
}

function warnUnknown(value: number, why: string, where: string): null {
  console.warn(`[tiktok-ads] purchase value check failed for ${where}: total_complete_payment_rate=${value} with ${why}; reported as unknown`);
  return null;
}

export function checkedPurchaseValue(r: Pick<TiktokStrictRow, "complete_payment" | "total_complete_payment_rate" | "value_per_complete_payment">, where: string): number | null {
  const value = r.total_complete_payment_rate;
  if (value === null) return null;
  const count = r.complete_payment;
  const per = r.value_per_complete_payment;
  if (count === 0) return value === 0 ? 0 : warnUnknown(value, "no purchases", where);
  if (count === null || per === null) return null;
  const expected = count * per;
  if (Math.abs(expected - value) <= Math.max(0.02 * Math.abs(expected), 0.05)) return value;
  console.warn(`[tiktok-ads] purchase value check failed for ${where}: total_complete_payment_rate=${value}, complete_payment x value_per_complete_payment=${expected}; reported as unknown`);
  return null;
}

export function tiktokCampaignsUrl(advertiserId: string): string {
  return `https://ads.tiktok.com/i18n/perf/campaign?aadvid=${advertiserId}`;
}
