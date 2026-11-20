
import { forceRefreshConnector, getConnectorToken, markConnectorTokenRevoked } from "@/services/connectors/core/token";
import { OAuthTokenError } from "@/services/connectors/core/oauth2-authcode";
import { isVariantsLabProcess } from "@/services/connectors/core/lab-mode";
import { ExpectedToolError } from "@/services/tools/types";
import { CONNECT_ADS_HINT, type AdAccount, type AdCampaign } from "@/services/connectors/core/ads-shapes";
import { logEvent } from "@/services/logging/logEvent";
import { LINKEDIN_ADS_ACCESS_TOKEN_KEY, LINKEDIN_ADS_SLUG } from "./constants";
import { LINKEDIN_ADS_BUSY, LINKEDIN_ADS_RECONNECT, LINKEDIN_ADS_UNAVAILABLE, LINKEDIN_ADS_UNREADABLE, linkedinAdsGet, linkedinOnBillingHold, type LinkedInPage, type LinkedInReadFreshness, type RestliValue } from "./http";

type LiAccount = { id: number; name?: string; currency?: string; status?: string; servingStatuses?: string[]; test?: boolean; reference?: string };
export type LiCampaign = {
  id: number;
  name?: string;
  status?: string;
  type?: string;
  objectiveType?: string;
  dailyBudget?: { amount: string; currencyCode: string };
  totalBudget?: { amount: string; currencyCode: string };
  changeAuditStamps?: { created?: { time?: number }; lastModified?: { time?: number } };
  runSchedule?: { end?: number };
  campaignGroup?: string;
};

export type LinkedInAdCampaign = AdCampaign & { campaign_group_id: string | null };

export type LiCampaignGroup = {
  id: number | string;
  name?: string;
  status?: string;
  backfilled?: boolean;
  totalBudget?: { amount: string; currencyCode: string };
  runSchedule?: { start?: number; end?: number };
  changeAuditStamps?: { created?: { time?: number }; lastModified?: { time?: number } };
};

export type LinkedInCampaignGroup = {
  id: string;
  name: string;
  status: string | null;
  total_budget: { amount: number; currency: string } | null;
  run_start_at: string | null;
  run_end_at: string | null;
  last_modified_at: string | null;
  is_default: boolean;
};

const CAMPAIGN_STATUSES = ["ACTIVE", "PAUSED", "ARCHIVED", "COMPLETED", "CANCELED", "DRAFT"];
export const CAMPAIGN_GROUP_STATUSES = ["ACTIVE", "PAUSED", "ARCHIVED", "CANCELED", "DRAFT"] as const;
const campaignGroupStatuses = (statuses: readonly string[]): string[] => statuses.filter((s) => (CAMPAIGN_GROUP_STATUSES as readonly string[]).includes(s));

export const LINKEDIN_ADS_REVOKED_MARK = new Date(0);

const DEAD_REFRESH_CODES = new Set(["invalid_grant", "expired_token", "token_expired", "revoked_token", "token_revoked"]);
const LINKEDIN_ADS_ZAVI_FAULT = "LinkedIn Ads could not be read because of a problem on Zavi's side. Your connection is fine and there is nothing for you to do. Zavi will try again.";

const isOutageStatus = (status: number) => status >= 500 || status === 408 || status === 429;

function refreshRefused(e: unknown): boolean {
  if (!(e instanceof OAuthTokenError) || e.oauthError === "invalid_client" || isOutageStatus(e.status)) return false;
  return DEAD_REFRESH_CODES.has(e.oauthError ?? "") || e.refreshTokenDead;
}

function refreshIsZavisFault(e: unknown): e is OAuthTokenError {
  return e instanceof OAuthTokenError && !refreshRefused(e) && !isOutageStatus(e.status);
}

function refreshOutage(e: unknown): unknown {
  if (e instanceof ExpectedToolError || isVariantsLabProcess()) return e;
  if (e instanceof OAuthTokenError) {
    const copy = e.status === 429 ? LINKEDIN_ADS_BUSY : LINKEDIN_ADS_UNAVAILABLE;
    return new ExpectedToolError("linkedin_ads_http_error", copy, { status: e.status, http_status: e.status });
  }
  return new ExpectedToolError("linkedin_ads_http_error", LINKEDIN_ADS_UNAVAILABLE, { is_transient: true });
}

async function zaviFault(tenant_id: string, e: OAuthTokenError): Promise<never> {
  await logEvent({
    level: "error",
    source: "linkedin-ads",
    code: "linkedin_ads.refresh_zavi_fault",
    tenant_id,
    message: "LinkedIn refused Zavi's token refresh for a reason that is not the founder's login: check the app credentials and the refresh request.",
    meta: { http_status: e.status, oauth_error: e.oauthError },
  });
  throw new ExpectedToolError("linkedin_ads_zavi_fault", LINKEDIN_ADS_ZAVI_FAULT);
}

async function reconnectNeeded(tenant_id: string): Promise<never> {
  await markConnectorTokenRevoked(tenant_id, LINKEDIN_ADS_SLUG, LINKEDIN_ADS_REVOKED_MARK).catch((e: unknown) =>
    console.warn("linkedin_ads_revoked_mark_failed", { tenant_id, detail: (e as Error).message }),
  );
  throw new ExpectedToolError("linkedin_ads_token_revoked", LINKEDIN_ADS_RECONNECT, { refresh_refused: true });
}

export async function linkedinAdsToken(tenant_id: string): Promise<string> {
  let t: string | null;
  try {
    t = await getConnectorToken(tenant_id, LINKEDIN_ADS_SLUG, LINKEDIN_ADS_ACCESS_TOKEN_KEY);
  } catch (e) {
    if (refreshRefused(e)) return reconnectNeeded(tenant_id);
    if (refreshIsZavisFault(e)) return zaviFault(tenant_id, e);
    throw refreshOutage(e);
  }
  if (!t) {
    throw new ExpectedToolError(
      "linkedin_ads_not_connected",
      `LinkedIn Ads is not connected. ${CONNECT_ADS_HINT}`,
    );
  }
  return t;
}

export async function withLinkedInAdsToken<T>(tenant_id: string, call: (accessToken: string) => Promise<T>): Promise<T> {
  const token = await linkedinAdsToken(tenant_id);
  try {
    return await call(token);
  } catch (e) {
    if (!(e instanceof ExpectedToolError) || e.code !== "linkedin_ads_token_revoked" || e.meta?.refresh_refused) throw e;
    try {
      await forceRefreshConnector(tenant_id, LINKEDIN_ADS_SLUG);
    } catch (r) {
      if (refreshRefused(r)) return reconnectNeeded(tenant_id);
      if (refreshIsZavisFault(r)) return zaviFault(tenant_id, r);
      throw refreshOutage(r);
    }
    return call(await linkedinAdsToken(tenant_id));
  }
}

const MAX_PAGES = 10;

async function searchAll<T>(
  accessToken: string,
  path: string,
  params: Record<string, RestliValue>,
  limit: number,
  fresh: LinkedInReadFreshness = false,
): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | null = null;
  for (let i = 0; i < MAX_PAGES && out.length < limit; i++) {
    const page: LinkedInPage<T> = await linkedinAdsGet<LinkedInPage<T>>(
      accessToken,
      path,
      pageToken ? { ...params, pageToken } : params,
      {},
      { fresh },
    );
    if (!Array.isArray(page.elements)) throw new ExpectedToolError("linkedin_ads_bad_response", LINKEDIN_ADS_UNREADABLE);
    out.push(...page.elements);
    pageToken = page.metadata?.nextPageToken || null;
    if (!pageToken || !page.elements.length) break;
  }
  return out.slice(0, limit);
}

const COMPLETE_MAX_PAGES = 50;

async function searchEvery<T>(
  accessToken: string,
  path: string,
  params: Record<string, RestliValue>,
  incomplete: string,
): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | null = null;
  for (let i = 0; i < COMPLETE_MAX_PAGES; i++) {
    const page: LinkedInPage<T> = await linkedinAdsGet<LinkedInPage<T>>(
      accessToken,
      path,
      pageToken ? { ...params, pageToken } : params,
    );
    if (!Array.isArray(page.elements)) throw new ExpectedToolError("linkedin_ads_bad_response", LINKEDIN_ADS_UNREADABLE);
    out.push(...page.elements);
    pageToken = page.metadata?.nextPageToken || null;
    if (!pageToken) return out;
    if (!page.elements.length) break;
  }
  throw new Error(incomplete);
}

export async function listEveryLinkedInAdAccountRaw(accessToken: string): Promise<AdAccount[]> {
  return (
    await searchEvery<LiAccount>(accessToken, "adAccounts", { q: "search", pageSize: 100 }, "LinkedIn Ads has more ad accounts than Zavi can read; spend is unknown.")
  ).map((a) => ({ id: String(a.id), name: a.name ?? String(a.id), currency: a.currency ?? null, status: a.status ?? null }));
}

export async function listEveryLinkedInCampaign(tenant_id: string, accountId: string): Promise<AdCampaign[]> {
  const campaigns = await withLinkedInAdsToken(tenant_id, (token) =>
    searchEvery<LiCampaign>(
      token,
      `adAccounts/${accountId}/adCampaigns`,
      { q: "search", pageSize: 100, search: { status: { values: CAMPAIGN_STATUSES } } },
      "LinkedIn Ads has more campaigns than Zavi can read; spend is unknown.",
    ),
  );
  return campaigns.map(toAdCampaign);
}

async function searchAdAccounts(accessToken: string, fresh: LinkedInReadFreshness = false): Promise<LiAccount[]> {
  return searchAll<LiAccount>(accessToken, "adAccounts", { q: "search", pageSize: 100 }, 1000, fresh);
}

export async function listLinkedInAdAccountsRaw(accessToken: string, fresh: LinkedInReadFreshness = false): Promise<Array<AdAccount & { billing_hold?: true }>> {
  return (await searchAdAccounts(accessToken, fresh)).map((a) => ({
    id: String(a.id),
    name: a.name ?? String(a.id),
    currency: a.currency ?? null,
    status: a.status ?? null,
    ...(linkedinOnBillingHold(a.servingStatuses) ? { billing_hold: true as const } : {}),
  }));
}

export async function listLinkedInAdAccounts(tenant_id: string, fresh = false): Promise<Array<AdAccount & { billing_hold?: true }>> {
  return withLinkedInAdsToken(tenant_id, (t) => listLinkedInAdAccountsRaw(t, fresh));
}

export async function listLinkedInAdAccountsWithReference(
  tenant_id: string,
  fresh = false,
): Promise<Array<AdAccount & { reference: string | null; servingStatuses: string[] }>> {
  return (await withLinkedInAdsToken(tenant_id, (t) => searchAdAccounts(t, fresh))).map((a) => ({
    id: String(a.id),
    name: a.name ?? String(a.id),
    currency: a.currency ?? null,
    status: a.status ?? null,
    reference: a.reference ?? null,
    servingStatuses: Array.isArray(a.servingStatuses) ? a.servingStatuses.filter((s): s is string => typeof s === "string") : [],
  }));
}

const ANALYTICS_FIELDS =
  "pivotValues,impressions,clicks,costInLocalCurrency,externalWebsiteConversions,oneClickLeads";
const ANALYTICS_VALUE_FIELD = "conversionValueInLocalCurrency";
const ANALYTICS_REACH_FIELD = "approximateMemberReach";

type LiAnalyticsRow = {
  pivotValues?: string[];
  impressions?: number;
  approximateMemberReach?: number;
  clicks?: number;
  costInLocalCurrency?: string;
  externalWebsiteConversions?: number;
  oneClickLeads?: number;
  conversionValueInLocalCurrency?: string;
};

export type AdAnalyticsRow = {
  pivot: string | null;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  leads: number;
  conversion_value?: number | null;
  reach?: number | null;
  missing_metrics?: string[];
};

export type AdAnalyticsOpts = {
  pivot: "ACCOUNT" | "CAMPAIGN" | "CAMPAIGN_GROUP" | "CREATIVE";
  start: { year: number; month: number; day: number };
  end: { year: number; month: number; day: number };
  campaigns?: string[];
  fresh?: boolean;
  value?: boolean;
  reach?: boolean;
};

const amountOf = (raw: string | undefined): number | null => {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

export async function readLinkedInAdAnalytics(
  tenant_id: string,
  accountId: string,
  opts: AdAnalyticsOpts,
): Promise<AdAnalyticsRow[]> {
  return withLinkedInAdsToken(tenant_id, (token) => readLinkedInAdAnalyticsWithToken(token, accountId, opts));
}

export async function readLinkedInAdAnalyticsWithToken(
  token: string,
  accountId: string,
  opts: AdAnalyticsOpts,
): Promise<AdAnalyticsRow[]> {
  const page = await linkedinAdsGet<LinkedInPage<LiAnalyticsRow>>(
    token,
    "adAnalytics",
    {
      q: "analytics",
      pivot: opts.pivot,
      timeGranularity: "ALL",
      dateRange: { start: opts.start, end: opts.end },
      accounts: [`urn:li:sponsoredAccount:${accountId}`],
      ...(opts.campaigns ? { campaigns: opts.campaigns } : {}),
    },
    { fields: [ANALYTICS_FIELDS, ...(opts.value ? [ANALYTICS_VALUE_FIELD] : []), ...(opts.reach ? [ANALYTICS_REACH_FIELD] : [])].join(",") },
    { fresh: opts.fresh === true },
  );
  if (!Array.isArray(page.elements)) throw new ExpectedToolError("linkedin_ads_bad_response", LINKEDIN_ADS_UNREADABLE);
  return page.elements.map((r) => ({
    pivot: r.pivotValues?.[0] ?? null,
    impressions: r.impressions ?? 0,
    clicks: r.clicks ?? 0,
    spend: Number(r.costInLocalCurrency ?? 0),
    conversions: r.externalWebsiteConversions ?? 0,
    leads: r.oneClickLeads ?? 0,
    ...(opts.value ? { conversion_value: amountOf(r.conversionValueInLocalCurrency) } : {}),
    ...(opts.reach ? { reach: typeof r.approximateMemberReach === "number" && Number.isFinite(r.approximateMemberReach) ? r.approximateMemberReach : null } : {}),
    missing_metrics: Object.entries({
      impressions: r.impressions,
      clicks: r.clicks,
      spend: r.costInLocalCurrency,
      conversions: r.externalWebsiteConversions,
      leads: r.oneClickLeads,
      ...(opts.value ? { conversion_value: r.conversionValueInLocalCurrency } : {}),
      ...(opts.reach ? { reach: r.approximateMemberReach } : {}),
    })
      .filter(([, value]) => value == null || value === "" || !Number.isFinite(Number(value)))
      .map(([key]) => key),
  }));
}

export async function listLinkedInCampaignGroupsWithToken(
  token: string,
  accountId: string,
  limit = 100,
  statuses: readonly string[] = CAMPAIGN_GROUP_STATUSES,
): Promise<LinkedInCampaignGroup[]> {
  const groups = await searchAll<LiCampaignGroup>(
    token,
    `adAccounts/${accountId}/adCampaignGroups`,
    { q: "search", pageSize: Math.min(limit, 100), search: { status: { values: campaignGroupStatuses(statuses) } } },
    limit,
  );
  return groups.map(toCampaignGroup);
}

export async function readLinkedInCampaignGroupsByIdWithToken(token: string, accountId: string, ids: readonly string[]): Promise<LinkedInCampaignGroup[]> {
  const account = /^\d{1,20}$/.test(accountId) ? accountId : null;
  if (!account) throw new ExpectedToolError("linkedin_ads_bad_path", "linkedin_ads: invalid ad account id");
  const wanted = [...new Set(ids.filter((id) => /^\d{1,20}$/.test(id)))];
  const read = await Promise.all(
    wanted.map((id) =>
      linkedinAdsGet<LiCampaignGroup>(token, `adAccounts/${account}/adCampaignGroups/${id}`).catch((e: unknown) => {
        if (e instanceof ExpectedToolError && (e.meta as { status?: unknown } | undefined)?.status === 404) return null;
        throw e;
      }),
    ),
  );
  return read.flatMap((g, i) => (g && String(g.id) === wanted[i] ? [toCampaignGroup(g)] : []));
}

export async function listLinkedInCampaignGroups(
  tenant_id: string,
  accountId: string,
  limit = 100,
  statuses: readonly string[] = CAMPAIGN_GROUP_STATUSES,
): Promise<LinkedInCampaignGroup[]> {
  return withLinkedInAdsToken(tenant_id, (token) => listLinkedInCampaignGroupsWithToken(token, accountId, limit, statuses));
}

const msToIso = (ms: unknown): string | null => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

export function toCampaignGroup(g: LiCampaignGroup): LinkedInCampaignGroup {
  const amount = g.totalBudget ? amountOf(g.totalBudget.amount) : null;
  return {
    id: String(g.id),
    name: g.name ?? String(g.id),
    status: g.status ?? null,
    total_budget: g.totalBudget && amount !== null ? { amount, currency: g.totalBudget.currencyCode } : null,
    run_start_at: msToIso(g.runSchedule?.start),
    run_end_at: msToIso(g.runSchedule?.end),
    last_modified_at: msToIso(g.changeAuditStamps?.lastModified?.time),
    is_default: g.backfilled === true,
  };
}

export async function listLinkedInCampaigns(
  tenant_id: string,
  accountId: string,
  limit = 100,
  statuses: readonly string[] = CAMPAIGN_STATUSES,
): Promise<LinkedInAdCampaign[]> {
  const campaigns = await withLinkedInAdsToken(tenant_id, (token) =>
    searchAll<LiCampaign>(
      token,
      `adAccounts/${accountId}/adCampaigns`,
      { q: "search", pageSize: Math.min(limit, 100), search: { status: { values: [...statuses] } } },
      limit,
    ),
  );
  return campaigns.map(toAdCampaign);
}

export async function getLinkedInCampaign(tenant_id: string, accountId: string, campaignId: string, opts: { pauseCritical?: boolean } = {}): Promise<AdCampaign | null> {
  if (!/^\d{1,20}$/.test(accountId) || !/^\d{1,20}$/.test(campaignId)) return null;
  const c = await withLinkedInAdsToken(tenant_id, (token) =>
    linkedinAdsGet<LiCampaign & { account?: string }>(token, `adAccounts/${accountId}/adCampaigns/${campaignId}`, {}, {}, { pauseCritical: opts.pauseCritical }).catch((e) => {
      if (e instanceof ExpectedToolError && (e.meta as { status?: unknown } | undefined)?.status === 404) return null;
      throw e;
    }),
  );
  if (!c || String(c.id) !== campaignId || c.account !== `urn:li:sponsoredAccount:${accountId}`) return null;
  return toAdCampaign(c);
}

type LiCreative = {
  id?: string | number;
  name?: string;
  campaign?: string;
  intendedStatus?: string;
  isServing?: boolean;
  servingHoldReasons?: string[];
  review?: { status?: string };
  createdAt?: number;
  lastModifiedAt?: number;
};

export type LinkedInAdState = { campaign_id: string; intended_status: string | null; is_serving: boolean | null; hold_reasons: string[]; review_status: string | null };

export type LinkedInCreative = LinkedInAdState & { id: string | null; name: string | null; created_at: string | null; last_modified_at: string | null };

const CREATIVE_CAMPAIGN_CHUNK = 50;

const creativeIdOf = (id: string | number | undefined): string | null => {
  if (typeof id === "number" && Number.isInteger(id) && id > 0) return String(id);
  return typeof id === "string" ? (/^(?:urn:li:sponsoredCreative:)?(\d{1,20})$/.exec(id)?.[1] ?? null) : null;
};

export async function readLinkedInCreativesWithToken(token: string, accountId: string, campaignIds: string[]): Promise<LinkedInCreative[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < campaignIds.length; i += CREATIVE_CAMPAIGN_CHUNK) chunks.push(campaignIds.slice(i, i + CREATIVE_CAMPAIGN_CHUNK));
  const pages = await Promise.all(
    chunks.map((ids) =>
      searchEvery<LiCreative>(token, `adAccounts/${accountId}/creatives`, { q: "criteria", pageSize: 100, campaigns: ids.map((id) => `urn:li:sponsoredCampaign:${id}`) }, "LinkedIn Ads has more ads than Zavi can read."),
    ),
  );
  return pages.flat().map((c) => ({
    id: creativeIdOf(c.id),
    name: typeof c.name === "string" && c.name.trim() ? c.name.trim() : null,
    campaign_id: c.campaign?.split(":").pop() ?? "",
    intended_status: c.intendedStatus ?? null,
    is_serving: typeof c.isServing === "boolean" ? c.isServing : null,
    hold_reasons: Array.isArray(c.servingHoldReasons) ? c.servingHoldReasons.filter((r): r is string => typeof r === "string") : [],
    review_status: c.review?.status ?? null,
    created_at: msToIso(c.createdAt),
    last_modified_at: msToIso(c.lastModifiedAt),
  }));
}

export async function readLinkedInCreatives(tenant_id: string, accountId: string, campaignIds: string[]): Promise<LinkedInCreative[]> {
  return withLinkedInAdsToken(tenant_id, (token) => readLinkedInCreativesWithToken(token, accountId, campaignIds));
}

export async function readLinkedInAdStatesWithToken(token: string, accountId: string, campaignIds: string[]): Promise<LinkedInAdState[]> {
  return (await readLinkedInCreativesWithToken(token, accountId, campaignIds)).map(({ campaign_id, intended_status, is_serving, hold_reasons, review_status }) => ({
    campaign_id,
    intended_status,
    is_serving,
    hold_reasons,
    review_status,
  }));
}

export async function readLinkedInAdStates(tenant_id: string, accountId: string, campaignIds: string[]): Promise<LinkedInAdState[]> {
  return withLinkedInAdsToken(tenant_id, (token) => readLinkedInAdStatesWithToken(token, accountId, campaignIds));
}

export const campaignGroupIdOf = (urn: string | undefined): string | null => {
  const id = typeof urn === "string" ? /^urn:li:sponsoredCampaignGroup:(\d{1,20})$/.exec(urn)?.[1] : undefined;
  return id ?? null;
};

export function toAdCampaign(c: LiCampaign): LinkedInAdCampaign {
  return {
    id: String(c.id),
    campaign_group_id: campaignGroupIdOf(c.campaignGroup),
    name: c.name ?? String(c.id),
    status: c.status ?? null,
    objective: c.objectiveType ?? c.type ?? null,
    budget: c.dailyBudget
      ? { amount: Number(c.dailyBudget.amount), currency: c.dailyBudget.currencyCode, kind: "daily" as const }
      : c.totalBudget
        ? { amount: Number(c.totalBudget.amount), currency: c.totalBudget.currencyCode, kind: "lifetime" as const }
        : null,
    last_modified_at: typeof c.changeAuditStamps?.lastModified?.time === "number" ? new Date(c.changeAuditStamps.lastModified.time).toISOString() : null,
    created_at: typeof c.changeAuditStamps?.created?.time === "number" ? new Date(c.changeAuditStamps.created.time).toISOString() : null,
    schedule_end_at: typeof c.runSchedule?.end === "number" ? new Date(c.runSchedule.end).toISOString() : null,
  };
}
