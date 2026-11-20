
import { getSecret } from "@/services/secrets/vault";
import { ExpectedToolError } from "@/services/tools/types";
import type { AdAccount, AdCampaign } from "@/services/connectors/core/ads-shapes";
import { addAdSums, ZERO_AD_SUMS, type AdSums } from "@/services/connectors/core/ad-metrics";
import {
  X_ADS_ACCESS_TOKEN_KEY,
  X_ADS_ACCESS_TOKEN_SECRET_KEY,
  X_ADS_API_BASE,
  xAdsConsumer,
} from "./constants";
import { oauth1Header, type UserToken } from "./oauth1";
import { X_ID_RE, X_LOCATION_ID_RE, X_TWEET_ID_RE } from "./schema";

export type { UserToken };
type Method = "GET" | "POST" | "PUT" | "DELETE";
type XEntity = { id: string; entity_status?: string };

const MICROS = 1_000_000;
const STATS_IDS_PER_CALL = 20;
const STATS_MAX_DAYS = 7;
const CONVERSION_METRICS = ["conversion_purchases", "conversion_sign_ups", "conversion_custom"] as const;
const UNKNOWN_OUTCOME = "so the change may or may not have been made. Check X Ads Manager before trying again.";

type XCampaign = {
  id: string;
  name?: string;
  entity_status?: string;
  servable?: boolean | null;
  reasons_not_servable?: string[] | null;
  daily_budget_amount_local_micro?: number | null;
  total_budget_amount_local_micro?: number | null;
  funding_instrument_id?: string;
  currency?: string;
  deleted?: boolean;
  updated_at?: string;
};

export type XCampaignRow = {
  campaign_id: string;
  account_id: string;
  name: string;
  status: string;
  servable: boolean | null;
  reasons_not_servable: string[];
  daily_budget: number | null;
  total_budget: number | null;
  funding_instrument_id: string | null;
  currency: string | null;
  updated_at: string | null;
};

export type XFundingRow = { id: string; description: string; type: string | null; able_to_fund: boolean; currency: string | null };
export type XLocationRow = { id: string; name: string; type: string | null; country_code: string | null };

export const toMicros = (units: number) => String(Math.round(units * MICROS));
const fromMicros = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v / MICROS : null);

export function assertId(id: string, what: string, re = X_ID_RE): string {
  if (!re.test(id)) throw new ExpectedToolError("x_ads_bad_id", `x_ads: invalid ${what}`);
  return id;
}

function errorDetail(body: unknown): string {
  const errors = (body as { errors?: Array<{ code?: unknown; message?: unknown }> } | null)?.errors;
  if (!Array.isArray(errors)) return "";
  return errors
    .slice(0, 3)
    .map((e) => [e.code, e.message].filter((x) => typeof x === "string" && x).join(": "))
    .filter(Boolean)
    .join("; ")
    .slice(0, 300);
}

function httpError(status: number, write: boolean, detail: string): ExpectedToolError {
  const suffix = detail ? ` (${detail})` : "";
  if (write && status >= 500) return new ExpectedToolError("x_ads_outcome_unknown", `X Ads answered HTTP ${status}, ${UNKNOWN_OUTCOME}`);
  if (status === 401) return new ExpectedToolError("x_ads_forbidden", `X Ads API HTTP 401. Check OAuth 1.0a credentials and the server clock; regenerate tokens after Ads API approval.${suffix}`);
  if (status === 403) return new ExpectedToolError("x_ads_forbidden", `X Ads API HTTP 403. Check Ads API app approval and this user's ad-account permissions; reconnecting alone may not help.${suffix}`);
  if (status === 429) return new ExpectedToolError("x_ads_rate_limited", "X Ads is limiting requests. Try again in a few minutes.");
  if (status === 404) return new ExpectedToolError("x_ads_not_found", `X Ads could not find that object.${suffix}`);
  return new ExpectedToolError(write ? "x_ads_refused" : "x_ads_http_error", `X Ads ${write ? "refused the change" : "read failed"} (HTTP ${status})${detail ? `: ${detail}` : "."}`);
}

export async function xAdsRequest<T>(token: UserToken, method: Method, path: string, params: Record<string, string> = {}): Promise<T> {
  if (!/^[a-z0-9_]+(?:\/[a-z0-9_]+)*$/.test(path)) throw new ExpectedToolError("x_ads_bad_path", "x_ads: invalid API resource path");
  const url = new URL(path, X_ADS_API_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (!/^[a-z][a-z0-9_]*$/.test(k) || k.startsWith("oauth_")) throw new ExpectedToolError("x_ads_bad_param", "x_ads: invalid API parameter");
    url.searchParams.set(k, v);
  }
  url.search = url.search.replace(/\+/g, "%20");
  const write = method !== "GET";

  let resp: Response;
  try {
    resp = await fetch(url.href, {
      method,
      headers: {
        Authorization: oauth1Header(xAdsConsumer(), method, `${url.origin}${url.pathname}`, Object.fromEntries(url.searchParams), token),
        Accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    if (write) throw new ExpectedToolError("x_ads_outcome_unknown", `X Ads did not answer, ${UNKNOWN_OUTCOME}`);
    throw new ExpectedToolError("x_ads_read_failed", `X Ads could not be reached: ${(e as Error).message}`.slice(0, 300));
  }

  const body: unknown = await resp.json().catch(() => null);
  if (!resp.ok) throw httpError(resp.status, write, errorDetail(body));
  if (body === null) {
    if (write) throw new ExpectedToolError("x_ads_outcome_unknown", `X Ads returned an unreadable answer, ${UNKNOWN_OUTCOME}`);
    throw new ExpectedToolError("x_ads_bad_response", "X Ads API returned non-JSON.");
  }
  const detail = errorDetail(body);
  if (detail) throw new ExpectedToolError(write ? "x_ads_refused" : "x_ads_error", `X Ads returned an error: ${detail}`);
  return body as T;
}

export function xAdsGet<T>(token: UserToken, path: string, params: Record<string, string> = {}): Promise<T> {
  return xAdsRequest<T>(token, "GET", path, params);
}

export async function xAdsPostJson<T>(token: UserToken, path: string, body: unknown): Promise<T> {
  if (!/^[a-z0-9_]+(?:\/[a-z0-9_]+)*$/.test(path)) throw new ExpectedToolError("x_ads_bad_path", "x_ads: invalid API resource path");
  const url = new URL(path, X_ADS_API_BASE);
  let resp: Response;
  try {
    resp = await fetch(url.href, {
      method: "POST",
      headers: {
        Authorization: oauth1Header(xAdsConsumer(), "POST", `${url.origin}${url.pathname}`, {}, token),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ExpectedToolError("x_ads_outcome_unknown", `X Ads did not answer, ${UNKNOWN_OUTCOME}`);
  }
  const parsed: unknown = await resp.json().catch(() => null);
  if (!resp.ok) throw httpError(resp.status, true, errorDetail(parsed) || batchErrorDetail(parsed));
  if (parsed === null) throw new ExpectedToolError("x_ads_outcome_unknown", `X Ads returned an unreadable answer, ${UNKNOWN_OUTCOME}`);
  const detail = errorDetail(parsed) || batchErrorDetail(parsed);
  if (detail) throw new ExpectedToolError("x_ads_refused", `X Ads returned an error: ${detail}`);
  return parsed as T;
}

function batchErrorDetail(body: unknown): string {
  const ops = (body as { operation_errors?: unknown[][] } | null)?.operation_errors;
  if (!Array.isArray(ops)) return "";
  return ops
    .flat()
    .slice(0, 3)
    .map((e) => {
      const o = e as { code?: unknown; message?: unknown } | null;
      return [o?.code, o?.message].filter((x) => typeof x === "string" && x).join(": ");
    })
    .filter(Boolean)
    .join("; ")
    .slice(0, 300);
}

export async function xAdsTenantToken(tenant_id: string): Promise<UserToken> {
  const [key, secret] = await Promise.all([
    getSecret(tenant_id, X_ADS_ACCESS_TOKEN_KEY),
    getSecret(tenant_id, X_ADS_ACCESS_TOKEN_SECRET_KEY),
  ]);
  if (!key || !secret) {
    throw new ExpectedToolError("x_ads_not_connected", "X Ads is not connected for this workspace. Connect it from the X Ads channel page or Settings.");
  }
  return { key, secret };
}

export async function listXAdAccountsRaw(token: UserToken): Promise<AdAccount[]> {
  const out: AdAccount[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: { data?: Array<{ id: string; name?: string; approval_status?: string; deleted?: boolean }>; next_cursor?: string | null } = await xAdsGet(token, "accounts", { count: "200", ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.data)) throw new ExpectedToolError("x_ads_bad_response", "X Ads returned no account list.");
    out.push(...page.data.filter(a => !a.deleted).map(a => ({ id: a.id, name: a.name ?? a.id, currency: null, status: a.approval_status ?? null })));
    cursor = page.next_cursor || null;
    if (cursor && (seen.has(cursor) || out.length >= 10000)) throw new ExpectedToolError("x_ads_inventory_incomplete", "X Ads account inventory is incomplete.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return out;
}

export async function listXAdAccounts(tenant_id: string): Promise<AdAccount[]> {
  return listXAdAccountsRaw(await xAdsTenantToken(tenant_id));
}

function campaignRow(c: XCampaign, accountId: string): XCampaignRow {
  return {
    campaign_id: c.id,
    account_id: accountId,
    name: c.name ?? c.id,
    status: c.deleted ? "DELETED" : (c.entity_status ?? "UNKNOWN"),
    servable: typeof c.servable === "boolean" ? c.servable : null,
    reasons_not_servable: (c.reasons_not_servable ?? []).filter((r) => typeof r === "string"),
    daily_budget: fromMicros(c.daily_budget_amount_local_micro),
    total_budget: fromMicros(c.total_budget_amount_local_micro),
    funding_instrument_id: c.funding_instrument_id ?? null,
    currency: c.currency?.toUpperCase() ?? null,
    updated_at: c.updated_at ?? null,
  };
}

export async function listXCampaignRows(token: UserToken, accountId: string, opts: { withDeleted?: boolean; max?: number } = {}): Promise<XCampaignRow[]> {
  assertId(accountId, "account_id");
  const max = opts.max ?? 1000;
  const out: XCampaignRow[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const params: Record<string, string> = { count: "200", with_deleted: String(!!opts.withDeleted), with_draft: "true" };
    if (cursor) params.cursor = cursor;
    const page: { data?: XCampaign[]; next_cursor?: string | null } = await xAdsGet(token, `accounts/${accountId}/campaigns`, params);
    if (!Array.isArray(page.data)) throw new ExpectedToolError("x_ads_bad_response", "X Ads returned no campaign list.");
    for (const c of page.data) out.push(campaignRow(c, accountId));
    cursor = page.next_cursor || null;
    if (cursor && (seen.has(cursor) || out.length >= max)) throw new ExpectedToolError("x_ads_inventory_incomplete", "X Ads campaign inventory could not be read completely.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return out.slice(0, max);
}

export async function getXCampaign(token: UserToken, accountId: string, campaignId: string): Promise<XCampaignRow | null> {
  assertId(campaignId, "campaign_id");
  try {
    const { data } = await xAdsGet<{ data?: XCampaign }>(token, `accounts/${assertId(accountId, "account_id")}/campaigns/${campaignId}`, { with_deleted: "true" });
    const row = data?.id ? campaignRow(data, accountId) : null;
    return row && row.status !== "DELETED" ? row : null;
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "x_ads_not_found") return null;
    throw e;
  }
}

export async function getXLineItemEnd(token: UserToken, accountId: string, lineItemId: string): Promise<{ end_time: string | null }> {
  const { data } = await xAdsGet<{ data?: { id?: string; end_time?: string | null } }>(token, `accounts/${assertId(accountId, "account_id")}/line_items/${assertId(lineItemId, "line_item_id")}`);
  if (data?.id !== lineItemId) throw new ExpectedToolError("x_ads_outcome_unknown", `X Ads did not return line item ${lineItemId}.`);
  return { end_time: typeof data.end_time === "string" && data.end_time ? data.end_time : null };
}

export async function listXCampaigns(tenant_id: string, accountId: string, limit = 100): Promise<AdCampaign[]> {
  const rows = await listXCampaignRows(await xAdsTenantToken(tenant_id), accountId, { max: limit });
  return rows.map((c) => ({
    id: c.campaign_id,
    name: c.name,
    status: c.status,
    objective: null,
    budget:
      c.daily_budget !== null
        ? { amount: c.daily_budget, currency: c.currency, kind: "daily" as const }
        : c.total_budget !== null
          ? { amount: c.total_budget, currency: c.currency, kind: "lifetime" as const }
          : null,
  }));
}

export async function listXFundingInstruments(token: UserToken, accountId: string): Promise<XFundingRow[]> {
  type F = { id: string; description?: string; type?: string; entity_status?: string; able_to_fund?: boolean; currency?: string; deleted?: boolean };
  const { data = [] } = await xAdsGet<{ data?: F[] }>(token, `accounts/${assertId(accountId, "account_id")}/funding_instruments`, { count: "200" });
  return data
    .filter((f) => !f.deleted && f.entity_status !== "CANCELLED")
    .map((f) => ({
      id: f.id,
      description: f.description ?? f.id,
      type: f.type ?? null,
      able_to_fund: f.able_to_fund === true && (f.entity_status ?? "ACTIVE") === "ACTIVE",
      currency: f.currency?.toUpperCase() ?? null,
    }));
}

export async function listXOwnPostIds(token: UserToken, accountId: string, tweetIds: string[]): Promise<Set<string>> {
  return new Set((await listXOwnPosts(token, accountId, tweetIds)).keys());
}

export type XOwnPost = { has_link: boolean; has_video: boolean };

export async function listXOwnPosts(token: UserToken, accountId: string, tweetIds: string[]): Promise<Map<string, XOwnPost>> {
  const out = new Map<string, XOwnPost>();
  if (tweetIds.length === 0) return out;
  type Media = { type?: string };
  type T = { id_str?: string; id?: string | number; tweet_id?: string; text?: string; full_text?: string; entities?: { urls?: unknown[] }; extended_entities?: { media?: Media[] } };
  const { data = [] } = await xAdsGet<{ data?: T[] }>(token, `accounts/${assertId(accountId, "account_id")}/tweets`, {
    tweet_type: "PUBLISHED",
    tweet_ids: tweetIds.map((t) => assertId(t, "post id", X_TWEET_ID_RE)).join(","),
    count: String(Math.min(200, Math.max(1, tweetIds.length))),
    trim_user: "true",
    include_entities: "true",
  });
  for (const t of data) {
    const id = String(t.id_str ?? t.tweet_id ?? t.id ?? "");
    if (!id) continue;
    const text = t.full_text ?? t.text ?? "";
    const media = Array.isArray(t.extended_entities?.media) ? t.extended_entities!.media! : [];
    out.set(id, {
      has_link: (Array.isArray(t.entities?.urls) && t.entities!.urls!.length > 0) || /https?:\/\//i.test(text),
      has_video: media.some((m) => m?.type === "video" || m?.type === "animated_gif"),
    });
  }
  return out;
}

export async function xPromotableUserId(token: UserToken, accountId: string): Promise<string> {
  type U = { id?: string; user_id?: string | number; promotable_user_type?: string; deleted?: boolean };
  const { data = [] } = await xAdsGet<{ data?: U[] }>(token, `accounts/${assertId(accountId, "account_id")}/promotable_users`, { count: "200" });
  const full = data.find((u) => !u.deleted && u.promotable_user_type === "FULL" && u.user_id != null) ?? data.find((u) => !u.deleted && u.user_id != null);
  if (!full) throw new ExpectedToolError("x_ads_no_promotable_user", "This X Ads account has no promotable user, so Zavi cannot publish a promoted-only post for it.");
  return String(full.user_id);
}

export async function createXPromotedOnlyPost(token: UserToken, accountId: string, asUserId: string, text: string): Promise<string> {
  type T = { id_str?: string; id?: string | number };
  const { data } = await xAdsRequest<{ data?: T }>(token, "POST", `accounts/${assertId(accountId, "account_id")}/tweet`, {
    as_user_id: assertId(asUserId, "user id", X_TWEET_ID_RE),
    text,
    nullcast: "true",
    trim_user: "true",
  });
  const id = String(data?.id_str ?? data?.id ?? "");
  if (!X_TWEET_ID_RE.test(id)) throw new ExpectedToolError("x_ads_outcome_unknown", "X Ads accepted the post but returned no post id. Check X Ads Manager.");
  return id;
}

export async function searchXLocations(token: UserToken, q: { query?: string; country_code?: string; location_type?: string }): Promise<XLocationRow[]> {
  const params: Record<string, string> = { count: "50" };
  if (q.query) params.q = q.query;
  if (q.country_code) params.country_code = q.country_code.toUpperCase();
  if (q.location_type) params.location_type = q.location_type;
  type L = { targeting_value?: string; name?: string; location_type?: string; country_code?: string };
  const { data = [] } = await xAdsGet<{ data?: L[] }>(token, "targeting_criteria/locations", params);
  return data.flatMap((l) =>
    l.targeting_value ? [{ id: l.targeting_value, name: l.name ?? l.targeting_value, type: l.location_type ?? null, country_code: l.country_code ?? null }] : [],
  );
}

const isCountryType = (t: string | null) => t === "COUNTRY" || t === "COUNTRIES";

export async function findXCountryPlace(token: UserToken, country: { code: string; name: string }): Promise<XLocationRow | null> {
  const rows = await searchXLocations(token, { query: country.name, location_type: "COUNTRIES" });
  const code = country.code.toUpperCase();
  return (
    rows.find((r) => isCountryType(r.type) && r.country_code?.toUpperCase() === code) ??
    rows.find((r) => isCountryType(r.type) && r.name.toLowerCase() === country.name.toLowerCase()) ??
    null
  );
}

function metricSum(v: unknown): number {
  if (Array.isArray(v)) return v.reduce((s: number, x) => s + (typeof x === "number" && Number.isFinite(x) ? x : 0), 0);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "metric" in o ? metricSum(o.metric) : Object.values(o).reduce((s: number, x) => s + metricSum(x), 0);
  }
  return 0;
}

function ymdPlus(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function statsWindows(from: string, to: string): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  const stop = ymdPlus(to, 1);
  for (let s = from; s < stop; s = ymdPlus(s, STATS_MAX_DAYS)) {
    const e = ymdPlus(s, STATS_MAX_DAYS);
    out.push({ start: `${s}T00:00:00Z`, end: `${e < stop ? e : stop}T00:00:00Z` });
  }
  return out;
}

type StatsRow = { id: string; id_data?: Array<{ metrics?: Record<string, unknown> | null }> };

export type XStatsEntity = "CAMPAIGN" | "LINE_ITEM" | "PROMOTED_TWEET";

function statsCall(token: UserToken, accountId: string, ids: string[], w: { start: string; end: string }, groups: string, entity: XStatsEntity) {
  return xAdsGet<{ data?: StatsRow[] }>(token, `stats/accounts/${accountId}`, {
    entity,
    entity_ids: ids.join(","),
    start_time: w.start,
    end_time: w.end,
    granularity: "TOTAL",
    metric_groups: groups,
    placement: "ALL_ON_TWITTER",
  });
}

function rowSums(row: StatsRow): AdSums {
  return (row.id_data ?? []).reduce((sums, seg) => {
    const m = seg.metrics ?? {};
    const urlClicks = metricSum(m.url_clicks);
    return addAdSums(sums, {
      spend: metricSum(m.billed_charge_local_micro) / MICROS,
      impressions: metricSum(m.impressions),
      clicks: m.url_clicks != null ? urlClicks : metricSum(m.clicks),
      conversions: CONVERSION_METRICS.reduce((s, k) => s + metricSum(m[k]), 0),
    });
  }, ZERO_AD_SUMS);
}

export type XCampaignStats = Map<string, AdSums> & { conversionsRead: boolean; missing: Map<string, Set<keyof AdSums>>; engagements: Map<string, number> };

export async function xCampaignStats(token: UserToken, accountId: string, campaignIds: string[], from: string, to: string, entity: XStatsEntity = "CAMPAIGN"): Promise<XCampaignStats> {
  assertId(accountId, "account_id");
  const ids = campaignIds.filter((id) => X_ID_RE.test(id));
  const out = new Map<string, AdSums>();
  const missing = new Map<string, Set<keyof AdSums>>();
  const engagements = new Map<string, number>();
  let groups = "ENGAGEMENT,BILLING,WEB_CONVERSION";
  for (const w of statsWindows(from, to)) {
    for (let i = 0; i < ids.length; i += STATS_IDS_PER_CALL) {
      const batch = ids.slice(i, i + STATS_IDS_PER_CALL);
      const resp = await statsCall(token, accountId, batch, w, groups, entity).catch((e) => {
        if (!(e instanceof ExpectedToolError) || !/^x_ads_(http_error|error)$/.test(e.code) || !groups.includes("WEB_CONVERSION")) throw e;
        groups = "ENGAGEMENT,BILLING";
        return statsCall(token, accountId, batch, w, groups, entity);
      });
      for (const id of batch) {
        const absent = missing.get(id) ?? new Set<keyof AdSums>();
        const row = resp.data?.find(r => r.id === id);
        const metrics = row?.id_data?.map(seg => seg.metrics ?? {}) ?? [];
        const present = (v: unknown): boolean => Array.isArray(v) ? v.length > 0 && v.every(x => typeof x === "number" && Number.isFinite(x)) : !!v && typeof v === "object" && "metric" in v && present((v as { metric: unknown }).metric);
        const fields: Array<[keyof AdSums, string[]]> = [["spend", ["billed_charge_local_micro"]], ["impressions", ["impressions"]], ["clicks", ["url_clicks"]], ["conversions", [...CONVERSION_METRICS]]];
        for (const [key, names] of fields) if (!metrics.length || metrics.some(m => names.some(name => !present(m[name])))) absent.add(key);
        missing.set(id, absent);
        if (row) {
          out.set(row.id, addAdSums(out.get(row.id) ?? ZERO_AD_SUMS, rowSums(row)));
          engagements.set(row.id, (engagements.get(row.id) ?? 0) + metrics.reduce((sum, m) => sum + metricSum(m.engagements), 0));
        }
      }
    }
  }
  return Object.assign(out, { conversionsRead: groups.includes("WEB_CONVERSION"), missing, engagements });
}

export function xLinkClicksUnread(stats: XCampaignStats, id: string): boolean {
  const absent = stats.missing.get(id);
  return !!absent && absent.has("clicks") && !absent.has("impressions");
}

export function xCampaignsUrl(accountId: string): string {
  return `https://ads.x.com/campaign_manager/${encodeURIComponent(accountId)}/campaigns`;
}

export async function writeData<T extends { id?: string }>(token: UserToken, method: Method, path: string, params: Record<string, string>): Promise<T & { id: string }> {
  const { data } = await xAdsRequest<{ data?: T }>(token, method, path, params);
  if (!data?.id) throw new ExpectedToolError("x_ads_outcome_unknown", "X Ads accepted the change but returned no id. Check X Ads Manager.");
  return data as T & { id: string };
}

export async function createXCampaign(
  token: UserToken,
  accountId: string,
  p: { funding_instrument_id: string; name: string; daily_budget: number; total_budget: number | null; entity_status: "ACTIVE" | "PAUSED" },
): Promise<XCampaignRow> {
  const params: Record<string, string> = {
    funding_instrument_id: assertId(p.funding_instrument_id, "funding_instrument_id"),
    name: p.name,
    budget_optimization: "LINE_ITEM",
    daily_budget_amount_local_micro: toMicros(p.daily_budget),
    entity_status: p.entity_status,
  };
  if (p.total_budget !== null) params.total_budget_amount_local_micro = toMicros(p.total_budget);
  return campaignRow(await writeData<XCampaign>(token, "POST", `accounts/${assertId(accountId, "account_id")}/campaigns`, params), accountId);
}

export async function updateXCampaign(
  token: UserToken,
  accountId: string,
  campaignId: string,
  p: { name?: string; daily_budget?: number; total_budget?: number; entity_status?: "ACTIVE" | "PAUSED" },
): Promise<XCampaignRow> {
  const params: Record<string, string> = {};
  if (p.name !== undefined) params.name = p.name;
  if (p.daily_budget !== undefined) params.daily_budget_amount_local_micro = toMicros(p.daily_budget);
  if (p.total_budget !== undefined) params.total_budget_amount_local_micro = toMicros(p.total_budget);
  if (p.entity_status !== undefined) params.entity_status = p.entity_status;
  const path = `accounts/${assertId(accountId, "account_id")}/campaigns/${assertId(campaignId, "campaign_id")}`;
  return campaignRow(await writeData<XCampaign>(token, "PUT", path, params), accountId);
}

export async function deleteXCampaign(token: UserToken, accountId: string, campaignId: string): Promise<void> {
  await deleteXEntity(token, `accounts/${assertId(accountId, "account_id")}/campaigns/${assertId(campaignId, "campaign_id")}`, campaignId);
}

export async function deleteXEntity(token: UserToken, path: string, id: string): Promise<void> {
  const { data } = await xAdsRequest<{ data?: { id?: string; deleted?: boolean } }>(token, "DELETE", path);
  if (data?.id !== id || data.deleted !== true) throw new ExpectedToolError("x_ads_outcome_unknown", "X Ads did not confirm deletion of the approved object. Check Ads Manager before retrying.");
}

export function createXLineItem(
  token: UserToken,
  accountId: string,
  p: { campaign_id: string; name: string; objective: string; start_time: string; end_time: string | null; entity_status: "ACTIVE" | "PAUSED" },
): Promise<XEntity> {
  const params: Record<string, string> = {
    campaign_id: assertId(p.campaign_id, "campaign_id"),
    name: p.name,
    objective: p.objective,
    product_type: p.objective === "FOLLOWERS" ? "PROMOTED_ACCOUNT" : "PROMOTED_TWEETS",
    placements: "ALL_ON_TWITTER",
    bid_strategy: "AUTO",
    start_time: p.start_time,
    entity_status: p.entity_status,
  };
  if (p.end_time) params.end_time = p.end_time;
  return writeData<XEntity>(token, "POST", `accounts/${assertId(accountId, "account_id")}/line_items`, params);
}

export type XTargetingCriterion = { targeting_type: string; targeting_value: string; operator_type: "EQ" | "NE" };
const BATCH_MAX = 500;

export async function addXTargeting(token: UserToken, accountId: string, lineItemId: string, criteria: readonly XTargetingCriterion[]): Promise<void> {
  if (criteria.length === 0) return;
  if (criteria.length > BATCH_MAX) throw new ExpectedToolError("x_ads_too_many_targets", `x_ads: at most ${BATCH_MAX} targeting criteria`);
  const line_item_id = assertId(lineItemId, "line_item_id");
  const ops = criteria.map((c) => {
    if (!/^[A-Z_]{1,40}$/.test(c.targeting_type)) throw new ExpectedToolError("x_ads_bad_param", "x_ads: invalid targeting type");
    if (c.targeting_type === "LOCATION") assertId(c.targeting_value, "location id", X_LOCATION_ID_RE);
    if (c.targeting_value.length === 0 || c.targeting_value.length > 200) throw new ExpectedToolError("x_ads_bad_param", "x_ads: invalid targeting value");
    return { operation_type: "Create", params: { line_item_id, targeting_type: c.targeting_type, targeting_value: c.targeting_value, operator_type: c.operator_type } };
  });
  const { data } = await xAdsPostJson<{ data?: XEntity[] }>(token, `batch/accounts/${assertId(accountId, "account_id")}/targeting_criteria`, ops);
  if (!Array.isArray(data) || data.length !== ops.length || data.some((r) => !r?.id)) {
    throw new ExpectedToolError("x_ads_outcome_unknown", "X Ads did not confirm every targeting criterion. Check Ads Manager before retrying.");
  }
}

export async function promoteXTweets(token: UserToken, accountId: string, lineItemId: string, tweetIds: string[]): Promise<void> {
  if (tweetIds.length === 0) throw new ExpectedToolError("x_ads_bad_id", "x_ads: no post to promote");
  const { data } = await xAdsRequest<{ data?: XEntity[] }>(token, "POST", `accounts/${assertId(accountId, "account_id")}/promoted_tweets`, {
    line_item_id: assertId(lineItemId, "line_item_id"),
    tweet_ids: tweetIds.map((t) => assertId(t, "post id", X_TWEET_ID_RE)).join(","),
  });
  if (!Array.isArray(data) || data.length !== tweetIds.length || data.some((r) => !r.id)) throw new ExpectedToolError("x_ads_outcome_unknown", "X Ads did not confirm all promoted-post associations. Check Ads Manager before retrying.");
}
