
import { getConnectorToken } from "@/services/connectors/core/token";
import type { AccountRead, LedgerCampaign } from "@/services/decisions/ad-budget-reconcile";
import { DailySpend, dayChunks, ledgerConnected, onOffStatus, requireUsd, spendAmount, zoneDate } from "@/services/connectors/core/budget-ledger";
import { listTikTokAdvertisers } from "./client";
import { TIKTOK_ADS_ACCESS_TOKEN_KEY, TIKTOK_ADS_SLUG } from "./constants";
import { tiktokAdsGet } from "./http";
import { TIKTOK_ADS_ROW_SLUG, ensureAdAccounts } from "./ad-accounts";
import { listAdvertiserIds, tiktokAdsAccount, tt, verifyAdvertisers } from "./composio-read";
import { composioConnectionStoppedError } from "@/services/connectors/composio/account";
import { ExpectedToolError } from "@/services/tools/types";
import { tiktokDeliveryFactor } from "./objects";

type Get = <T>(path: string, params: Record<string, unknown>) => Promise<T>;
type Advertiser = { advertiser_id: string; currency?: string | null; timezone?: string | null };

function query(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) search.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  return search.toString();
}

async function connection(tenantId: string): Promise<{ get: Get; advertisers: Advertiser[] } | null> {
  if (await ledgerConnected(tenantId, TIKTOK_ADS_ROW_SLUG, LABEL)) {
    const account = await tiktokAdsAccount(tenantId).catch(async (e: unknown) => {
      if (e instanceof ExpectedToolError && e.code === "tiktok_ads_not_connected") {
        throw (await composioConnectionStoppedError(tenantId, "tiktok_ads", LABEL)) ?? e;
      }
      throw e;
    });
    const state = await ensureAdAccounts(tenantId);
    if (!state.connected) throw new Error(`${LABEL} is linked but its ad accounts could not be read; reconnect it.`);
    const discovered = await listAdvertiserIds(account);
    if (discovered.length >= 200) throw new Error(`${LABEL} login reaches more ad accounts than one read covers; spend is unknown.`);
    const ids = [...new Set([...state.accounts.map((a) => a.advertiser_id), ...discovered])];
    const advertisers = ids.length ? await verifyAdvertisers(account, ids) : [];
    if (advertisers.length === 0) throw new Error(`${LABEL} is linked but no ad account could be read; pick one on the TikTok Ads channel page.`);
    const confirmed = new Set(advertisers.map((a) => a.advertiser_id));
    const lost = ids.filter((id) => !confirmed.has(id));
    if (lost.length) throw new Error(`${LABEL} no longer answers for ad account ${lost.join(", ")}; reconnect it or remove it on the TikTok Ads channel page. Spend is unknown.`);
    return {
      get: async <T>(path: string, params: Record<string, unknown>) => (await tt(account, `/${path}/?${query(params)}`)) as T,
      advertisers,
    };
  }
  if (!(await ledgerConnected(tenantId, TIKTOK_ADS_SLUG, LABEL))) return null;
  const token = await getConnectorToken(tenantId, TIKTOK_ADS_SLUG, TIKTOK_ADS_ACCESS_TOKEN_KEY);
  if (!token) throw new Error(`${LABEL} is connected but its token is missing; reconnect it.`);
  return { get: (path, params) => tiktokAdsGet(token, path, params), advertisers: await listTikTokAdvertisers(tenantId) };
}

const LABEL = "TikTok Ads";
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
const REPORT_MAX_DAYS = 30;

type Campaign = { campaign_id: string; campaign_name?: string; operation_status?: string; budget?: number | string; budget_mode?: string };
type AdGroup = { adgroup_id: string; adgroup_name?: string; campaign_id?: string; operation_status?: string; secondary_status?: string; budget?: number | string; budget_mode?: string };
type ReportRow = { dimensions?: { campaign_id?: string; stat_time_day?: string }; metrics?: { spend?: string | number } };
type Page<T> = { list?: T[]; page_info?: { page?: number; total_page?: number } };

async function allPages<T>(get: Get, path: string, params: Record<string, unknown>): Promise<T[]> {
  const out: T[] = [];
  let total = 1;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await get<Page<T>>(path, { ...params, page, page_size: PAGE_SIZE });
    if (!Array.isArray(data?.list) || !data.list.every((r) => r && typeof r === "object" && !Array.isArray(r))) throw new Error(`${LABEL} returned an invalid list; spend is unknown.`);
    out.push(...data.list);
    const reported = data.page_info?.total_page;
    if ((reported !== undefined && (typeof reported !== "number" || !Number.isInteger(reported) || reported < 0)) || (page === 1 && reported === undefined && data.list.length >= PAGE_SIZE)) throw new Error(`${LABEL} returned incomplete pagination; spend is unknown.`);
    total = Math.max(total, reported ?? 1);
    if (total > MAX_PAGES) break;
    if (page >= total) return out;
  }
  throw new Error(`${LABEL} returned more than ${MAX_PAGES} pages; spend is unknown.`);
}

type TiktokDailyCapacity = { daily_delivery_factor?: 1.25 };
function budgetOf(c: Pick<Campaign, "budget" | "budget_mode">): Pick<LedgerCampaign, "budget_kind" | "budget_usd"> & TiktokDailyCapacity {
  const amount = c.budget == null || c.budget === "" ? null : Number(c.budget);
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return { budget_kind: "none", budget_usd: null };
  if (c.budget_mode === "BUDGET_MODE_TOTAL") return { budget_kind: "lifetime", budget_usd: amount };
  if (c.budget_mode === "BUDGET_MODE_DAY" || c.budget_mode === "BUDGET_MODE_DYNAMIC_DAILY_BUDGET") return { budget_kind: "daily", budget_usd: amount, ...(tiktokDeliveryFactor(c.budget_mode) === 1.25 ? { daily_delivery_factor: 1.25 as const } : {}) };
  return { budget_kind: "none", budget_usd: null };
}

const onOff = (op: string | undefined) => onOffStatus(op === "ENABLE" ? true : op === "DISABLE" ? false : null, op);

export async function readTiktokAccountsForBudget(tenantId: string, start: Date, now = new Date()): Promise<AccountRead[]> {
  const conn = await connection(tenantId);
  if (!conn) return [];
  const { get, advertisers } = conn;
  requireUsd(LABEL, advertisers.map((a) => a.currency));
  const reads: AccountRead[] = [];
  for (const adv of advertisers) {
    const window = { since: start.toISOString().slice(0, 10), until: zoneDate(now, adv.timezone) };
    const campaigns = await allPages<Campaign>(get, "campaign/get", {
      advertiser_id: adv.advertiser_id,
      fields: ["campaign_id", "campaign_name", "operation_status", "budget", "budget_mode"],
    });
    if (campaigns.some((c) => !c.campaign_id)) throw new Error(`${LABEL} returned a campaign without its id; spend is unknown.`);
    const adGroups = await allPages<AdGroup>(get, "adgroup/get", {
      advertiser_id: adv.advertiser_id,
      fields: ["adgroup_id", "adgroup_name", "campaign_id", "operation_status", "secondary_status", "budget", "budget_mode"],
    });
    const byCampaign = new Map(campaigns.map((c) => [c.campaign_id, c]));
    const ended = (g: AdGroup) => g.secondary_status === "ADGROUP_STATUS_TIME_DONE";
    const campaignStatus = (c: Campaign) => {
      const children = adGroups.filter((g) => g.campaign_id === c.campaign_id);
      return c.operation_status === "ENABLE" && children.length > 0 && children.every(ended) ? "ENDED" : onOff(c.operation_status);
    };
    const daily = new DailySpend();
    if (window.since <= window.until)
      for (const chunk of dayChunks(window.since, window.until, REPORT_MAX_DAYS)) {
        const rows = await allPages<ReportRow>(get, "report/integrated/get", {
          advertiser_id: adv.advertiser_id,
          report_type: "BASIC",
          data_level: "AUCTION_CAMPAIGN",
          dimensions: ["campaign_id", "stat_time_day"],
          metrics: ["spend"],
          start_date: chunk.since,
          end_date: chunk.until,
        });
        for (const r of rows) {
          const id = r.dimensions?.campaign_id;
          const day = r.dimensions?.stat_time_day?.slice(0, 10);
          if (!id || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`${LABEL} returned a report row without a campaign or day; spend is unknown.`);
          daily.add(id, day, spendAmount(LABEL, r.metrics?.spend));
        }
      }
    reads.push({
      platform: "tiktok",
      account_id: adv.advertiser_id,
      window,
      campaigns: [
        ...campaigns.map((c) => ({
          object_id: c.campaign_id,
          level: "campaign" as const,
          campaign_id: c.campaign_id,
          name: c.campaign_name ?? null,
          ...budgetOf(c),
          status: campaignStatus(c),
          currency: adv.currency ?? "UNKNOWN",
        })),
        ...adGroups.map((g) => {
          if (!g.adgroup_id || !g.campaign_id) throw new Error(`${LABEL} returned an ad group without an id or campaign; spend is unknown.`);
          const parent = byCampaign.get(g.campaign_id);
          const onCampaign = parent ? budgetOf(parent).budget_kind !== "none" : false;
          const own = ended(g) ? "ENDED" : onOff(g.operation_status);
          return {
            object_id: g.adgroup_id,
            level: "ad_group" as const,
            campaign_id: g.campaign_id,
            name: g.adgroup_name ?? null,
            ...(onCampaign ? { budget_kind: "campaign_level" as const, budget_usd: null } : budgetOf(g)),
            status: own === "ACTIVE" && parent?.operation_status === "DISABLE" ? "CAMPAIGN_PAUSED" : own,
            currency: adv.currency ?? "UNKNOWN",
          };
        }),
      ],
      spend: daily.toRows(window.until, 1),
    });
  }
  return reads;
}

export async function tiktokSpendCapacity(tenantId: string, now = new Date()): Promise<{ connected: boolean; capacity_usd: number | null }> {
  try {
    const reads = await readTiktokAccountsForBudget(tenantId, now, now);
    let capacity = 0;
    for (const account of reads) {
      const campaignOn = new Map(account.campaigns.filter((c) => c.level === "campaign").map((c) => [c.object_id, c.status === "ACTIVE"]));
      for (const o of account.campaigns) {
        if (o.status !== "ACTIVE") continue;
        if (o.level === "ad_group" && campaignOn.get(o.campaign_id ?? "") !== true) continue;
        if (o.budget_kind === "campaign_level") continue;
        if (o.level === "campaign" && o.budget_kind === "none") continue;
        if (o.budget_kind !== "daily" || o.budget_usd == null) return { connected: true, capacity_usd: null };
        capacity += o.budget_usd * ((o as LedgerCampaign & TiktokDailyCapacity).daily_delivery_factor ?? 1);
      }
    }
    return { connected: reads.length > 0, capacity_usd: Math.round(capacity * 100) / 100 };
  } catch {
    return { connected: true, capacity_usd: null };
  }
}
