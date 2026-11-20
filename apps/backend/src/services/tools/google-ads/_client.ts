
import { getSecret } from "@/services/secrets/vault";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";
import { GOOGLE_ADS_VAULT_KEYS, GOOGLE_ADS_ENV_KEYS, GOOGLE_ADS_API_BASE } from "./keys";

export const GADS_BASE = GOOGLE_ADS_API_BASE;
export const GOOGLE_ADS_TIMEOUT_MS = 15_000;
const READ_RETRY_DELAY_MS = 500;

type AccessTokenCache = { access_token: string; expires_at_ms: number };
const ACCESS_TOKEN_CACHE = new Map<string, AccessTokenCache>();
const REFRESH_IN_FLIGHT = new Map<string, Promise<string>>();

export type GoogleAdsCreds = {
  developer_token: string;
  customer_id: string;
  login_customer_id?: string;
  access_token: string;
};

export function forgetGoogleAdsAccessToken(tenant_id: string): void {
  ACCESS_TOKEN_CACHE.delete(tenant_id);
}

export async function googleAdsCreds(tenant_id: string): Promise<GoogleAdsCreds> {
  const clientId = process.env[GOOGLE_ADS_ENV_KEYS.client_id];
  const clientSecret = process.env[GOOGLE_ADS_ENV_KEYS.client_secret];
  const devToken = process.env[GOOGLE_ADS_ENV_KEYS.developer_token];

  if (!clientId || !clientSecret || !devToken) {
    throw new ExpectedToolError(
      "google_ads_not_configured",
      "Google Ads is not configured on this Praxis deployment. The GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET / GOOGLE_ADS_DEVELOPER_TOKEN env secrets are unset (and/or Google has not approved the developer token yet).",
      { next_step: "praxis_admin_action", unblockers: ["Set the GOOGLE_ADS_* env secrets in AWS Secrets Manager praxis-envprod-1"] },
    );
  }
  const [refreshToken, customerId, loginCustomerId] = await Promise.all([
    getSecret(tenant_id, GOOGLE_ADS_VAULT_KEYS.refresh_token),
    getSecret(tenant_id, GOOGLE_ADS_VAULT_KEYS.customer_id),
    getSecret(tenant_id, GOOGLE_ADS_VAULT_KEYS.login_customer_id),
  ]);
  if (!refreshToken || !customerId) {
    throw new ExpectedToolError(
      "google_ads_not_connected",
      "Google Ads is not connected for this workspace. Operator must complete the OAuth flow at /connectors → Google Ads. Until connected, fall back to operator-supplied spend snapshots.",
      {
        next_step: "operator_action",
        unblockers: ["Complete OAuth at /connectors → Google Ads"],
      },
    );
  }

  const accessToken = await getOrRefreshAccessToken(tenant_id, clientId, clientSecret, refreshToken);

  return {
    developer_token: devToken,
    customer_id: customerId.replace(/-/g, ""),
    login_customer_id: loginCustomerId ? loginCustomerId.replace(/-/g, "") : undefined,
    access_token: accessToken,
  };
}

function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

async function gadsFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(GOOGLE_ADS_TIMEOUT_MS) });
  } catch (e) {
    if (isTimeoutError(e)) {
      throw new ExpectedToolError(
        "google_ads_timeout",
        `Google Ads API did not respond within ${GOOGLE_ADS_TIMEOUT_MS / 1000}s`,
      );
    }
    throw e;
  }
}

async function gadsRead(url: string, init: RequestInit): Promise<Response> {
  const first = await gadsFetch(url, init).catch((e: unknown) =>
    e instanceof ExpectedToolError && e.code === "google_ads_timeout" ? null : Promise.reject(e),
  );
  if (first && first.status !== 429 && first.status < 500) return first;
  await new Promise((res) => setTimeout(res, READ_RETRY_DELAY_MS));
  return gadsFetch(url, init);
}

function getOrRefreshAccessToken(
  tenant_id: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const cached = ACCESS_TOKEN_CACHE.get(tenant_id);
  if (cached && cached.expires_at_ms > Date.now() + 60_000) {
    return Promise.resolve(cached.access_token);
  }
  let inflight = REFRESH_IN_FLIGHT.get(tenant_id);
  if (!inflight) {
    inflight = refreshAccessToken(tenant_id, clientId, clientSecret, refreshToken).finally(() =>
      REFRESH_IN_FLIGHT.delete(tenant_id),
    );
    REFRESH_IN_FLIGHT.set(tenant_id, inflight);
  }
  return inflight;
}

async function refreshAccessToken(
  tenant_id: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await gadsRead("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const text = await r.text();
    if (text.includes("invalid_grant")) {
      await setGoogleAdsTokenExpiry(tenant_id, new Date().toISOString());
      throw new ExpectedToolError(
        "google_ads_token_revoked",
        `Google Ads authorization has expired or been revoked: ${r.status} ${text}`,
        {
          next_step: "operator_action",
          unblockers: ["Reconnect Google Ads at /connectors → Google Ads"],
        },
      );
    }
    throw new ExpectedToolError(
      "google_ads_oauth_refresh_failed",
      `Google OAuth refresh failed: ${r.status} ${text}`,
    );
  }
  const json = (await r.json()) as { access_token: string; expires_in?: number };
  const cache: AccessTokenCache = {
    access_token: json.access_token,
    expires_at_ms: Date.now() + (json.expires_in ?? 3000) * 1000,
  };
  ACCESS_TOKEN_CACHE.set(tenant_id, cache);
  await setGoogleAdsTokenExpiry(tenant_id, null);
  return cache.access_token;
}

export async function setGoogleAdsTokenExpiry(
  tenant_id: string,
  token_expires_at: string | null,
): Promise<void> {
  try {
    await tenantRpc(asTenantId(tenant_id), "refresh_connector_secrets", {
      p_slug: "google_ads",
      p_secrets: {},
      p_expires_at: token_expires_at,
    });
  } catch {
  }
}

function gadsHeaders(c: GoogleAdsCreds): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${c.access_token}`,
    "developer-token": c.developer_token,
    "Content-Type": "application/json",
  };
  if (c.login_customer_id) headers["login-customer-id"] = c.login_customer_id;
  return headers;
}

export async function gadsSearch(
  tenant_id: string,
  query: string,
  opts: { complete?: boolean } = {},
): Promise<unknown[]> {
  return searchWithTokenRecovery(tenant_id, query, () => googleAdsCreds(tenant_id), undefined, opts.complete === true);
}

export type GoogleAdsSearch = (query: string) => Promise<unknown[]>;

export function createGoogleAdsReadSession(tenantId: string): GoogleAdsSearch {
  let credentials: Promise<GoogleAdsCreds> | undefined;
  return (query) =>
    searchWithTokenRecovery(
      tenantId,
      query,
      () => (credentials ??= googleAdsCreds(tenantId)),
      () => {
        credentials = undefined;
      },
    );
}

async function searchWithTokenRecovery(
  tenant_id: string,
  query: string,
  resolve: () => Promise<GoogleAdsCreds>,
  reset?: () => void,
  complete = false,
): Promise<unknown[]> {
  try {
    return await searchWithCredentials(await resolve(), query, complete);
  } catch (e) {
    if (!(e instanceof ExpectedToolError && e.code === "google_ads_unauthenticated")) throw e;
    forgetGoogleAdsAccessToken(tenant_id);
    reset?.();
    return searchWithCredentials(await resolve(), query, complete);
  }
}

async function searchWithCredentials(c: GoogleAdsCreds, query: string, complete = false): Promise<unknown[]> {
  const headers = gadsHeaders(c);
  const url = `${GADS_BASE}/customers/${c.customer_id}/googleAds:search`;
  const results: unknown[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const body: Record<string, unknown> = { query };
    if (pageToken) body.pageToken = pageToken;
    const r = await gadsRead(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!r.ok) {
      throw new ExpectedToolError(
        r.status === 401 ? "google_ads_unauthenticated" : "google_ads_query_failed",
        `Google Ads search failed: ${r.status} ${await r.text()}`,
      );
    }
    const json = (await r.json()) as { results?: unknown[]; nextPageToken?: string };
    if (json.results) results.push(...json.results);
    if (!json.nextPageToken) return results;
    pageToken = json.nextPageToken;
  }
  if (complete) {
    throw new ExpectedToolError("google_ads_query_truncated", "Google Ads search returned more than 10 pages");
  }
  return results;
}

export type GadsMutateService =
  | "campaignBudgets"
  | "campaigns"
  | "campaignCriteria"
  | "adGroups"
  | "adGroupAds"
  | "adGroupCriteria"
  | "assets"
  | "assetGroups"
  | "assetGroupAssets"
  | "campaignAssets";

const OPERATION_KEY: Record<GadsMutateService, string> = {
  campaignBudgets: "campaignBudgetOperation",
  campaigns: "campaignOperation",
  campaignCriteria: "campaignCriterionOperation",
  adGroups: "adGroupOperation",
  adGroupAds: "adGroupAdOperation",
  adGroupCriteria: "adGroupCriterionOperation",
  assets: "assetOperation",
  assetGroups: "assetGroupOperation",
  assetGroupAssets: "assetGroupAssetOperation",
  campaignAssets: "campaignAssetOperation",
};

const RESULT_KEY: Record<GadsMutateService, string> = {
  campaignBudgets: "campaignBudgetResult",
  campaigns: "campaignResult",
  campaignCriteria: "campaignCriterionResult",
  adGroups: "adGroupResult",
  adGroupAds: "adGroupAdResult",
  adGroupCriteria: "adGroupCriterionResult",
  assets: "assetResult",
  assetGroups: "assetGroupResult",
  assetGroupAssets: "assetGroupAssetResult",
  campaignAssets: "campaignAssetResult",
};

export type GadsOperation =
  | { service: GadsMutateService; create: Record<string, unknown> }
  | { service: GadsMutateService; update: Record<string, unknown>; updateMask: string }
  | { service: GadsMutateService; remove: string };

export async function gadsStoredCustomerId(tenant_id: string): Promise<string> {
  const customerId = await getSecret(tenant_id, GOOGLE_ADS_VAULT_KEYS.customer_id);
  if (!customerId) throw new Error("Google Ads is not connected for this workspace.");
  return customerId.replace(/-/g, "");
}

export async function gadsCustomerId(tenant_id: string): Promise<string> {
  const c = await googleAdsCreds(tenant_id);
  return c.customer_id;
}

export function gadsTempResourceName(
  customer_id: string,
  service: GadsMutateService,
  ordinal: number,
): string {
  return `customers/${customer_id}/${service}/-${ordinal}`;
}

type GadsErrorLocation = { fieldPathElements?: Array<{ fieldName?: string; index?: number }> };

function googleAdsFieldPath(location: GadsErrorLocation | undefined): string {
  return (location?.fieldPathElements ?? [])
    .filter((e) => e.fieldName)
    .map((e) => (typeof e.index === "number" ? `${e.fieldName}[${e.index}]` : e.fieldName))
    .join(".");
}

export function googleAdsErrorPairs(body: string): string[] {
  try {
    const json = JSON.parse(body) as {
      error?: {
        message?: string;
        details?: Array<{
          errors?: Array<{
            errorCode?: Record<string, string>;
            message?: string;
            location?: GadsErrorLocation;
            trigger?: Record<string, unknown>;
          }>;
        }>;
      };
    };
    const pairs: string[] = [];
    for (const detail of json.error?.details ?? []) {
      for (const err of detail.errors ?? []) {
        const code = Object.values(err.errorCode ?? {})[0] ?? "UNKNOWN";
        const path = googleAdsFieldPath(err.location);
        const trigger = Object.values(err.trigger ?? {})[0];
        const where = [
          path ? `at ${path}` : "",
          trigger !== undefined && trigger !== "" ? `value ${String(trigger).slice(0, 120)}` : "",
        ].filter(Boolean).join(", ");
        pairs.push(`${code}: ${err.message ?? "(no message)"}${where ? ` (${where})` : ""}`);
      }
    }
    if (pairs.length > 0) return [...new Set(pairs)].slice(0, 10);
    if (json.error?.message) return [json.error.message];
  } catch {
  }
  const trimmed = body.trim().slice(0, 300);
  return trimmed ? [trimmed] : [];
}

export async function gadsMutateOperations(
  tenant_id: string,
  operations: GadsOperation[],
  opts: { validateOnly?: boolean } = {},
): Promise<string[]> {
  if (operations.length === 0) return [];
  const c = await googleAdsCreds(tenant_id);
  const headers = gadsHeaders(c);
  const url = `${GADS_BASE}/customers/${c.customer_id}/googleAds:mutate`;
  const mutateOperations = operations.map((op) => {
    const { service, ...rest } = op;
    return { [OPERATION_KEY[service]]: rest };
  });
  const r = await gadsFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      mutateOperations,
      partialFailure: false,
      ...(opts.validateOnly ? { validateOnly: true } : {}),
    }),
  });
  if (!r.ok) {
    throw new ExpectedToolError(
      "google_ads_mutate_failed",
      `Google Ads googleAds:mutate failed: ${r.status} ${await r.text()}`,
    );
  }
  if (opts.validateOnly) return [];
  const json = (await r.json()) as {
    mutateOperationResponses?: Array<Record<string, { resourceName?: string }>>;
    partialFailureError?: unknown;
  };
  if (json.partialFailureError) {
    throw new ExpectedToolError(
      "google_ads_mutate_partial_failure",
      `Google Ads googleAds:mutate returned a partial failure: ${JSON.stringify(json.partialFailureError)}`,
    );
  }
  const responses = json.mutateOperationResponses ?? [];
  if (responses.length !== operations.length) {
    throw new ExpectedToolError(
      "google_ads_mutate_incomplete",
      `Google Ads googleAds:mutate returned ${responses.length} results for ${operations.length} operations.`,
    );
  }
  return responses.map((res, i) => res[RESULT_KEY[operations[i].service]]?.resourceName ?? "");
}

export type GeoTargetSuggestion = {
  id: number;
  name: string;
  canonical_name: string;
  target_type: string;
  country_code: string;
};

export async function gadsSuggestGeoTargets(
  tenant_id: string,
  name: string,
  opts: { countryCode?: string; locale?: string } = {},
): Promise<GeoTargetSuggestion[]> {
  const c = await googleAdsCreds(tenant_id);
  const r = await gadsRead(`${GADS_BASE}/geoTargetConstants:suggest`, {
    method: "POST",
    headers: gadsHeaders(c),
    body: JSON.stringify({
      locale: opts.locale ?? "en",
      ...(opts.countryCode ? { countryCode: opts.countryCode } : {}),
      locationNames: { names: [name] },
    }),
  });
  if (!r.ok) {
    throw new ExpectedToolError("google_ads_geo_suggest_failed", `Google Ads geo suggest failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
  }
  const json = (await r.json()) as {
    geoTargetConstantSuggestions?: Array<{
      geoTargetConstant?: { id?: string | number; name?: string; canonicalName?: string; targetType?: string; countryCode?: string; status?: string };
    }>;
  };
  const out: GeoTargetSuggestion[] = [];
  for (const s of json.geoTargetConstantSuggestions ?? []) {
    const g = s.geoTargetConstant;
    const id = Number(g?.id);
    if (!g || !Number.isInteger(id) || id <= 0 || !g.name) continue;
    if (g.status && g.status !== "ENABLED") continue;
    out.push({ id, name: g.name, canonical_name: g.canonicalName ?? g.name, target_type: g.targetType ?? "", country_code: g.countryCode ?? "" });
  }
  return out;
}

export async function gadsMutate(
  tenant_id: string,
  service: GadsMutateService,
  operations: Array<Record<string, unknown>>,
): Promise<string[]> {
  const c = await googleAdsCreds(tenant_id);
  const headers = gadsHeaders(c);
  const url = `${GADS_BASE}/customers/${c.customer_id}/${service}:mutate`;
  const r = await gadsFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ operations, partialFailure: false }),
  });
  if (!r.ok) {
    throw new ExpectedToolError(
      "google_ads_mutate_failed",
      `Google Ads ${service}:mutate failed: ${r.status} ${await r.text()}`,
    );
  }
  const json = (await r.json()) as {
    results?: Array<{ resourceName?: string }>;
    partialFailureError?: unknown;
  };
  if (json.partialFailureError) {
    throw new ExpectedToolError(
      "google_ads_mutate_partial_failure",
      `Google Ads ${service}:mutate returned a partial failure: ${JSON.stringify(json.partialFailureError)}`,
    );
  }
  return (json.results ?? []).map((x) => x.resourceName ?? "").filter(Boolean);
}

export async function gadsGetCampaignBudget(
  tenant_id: string,
  campaign_id: string,
): Promise<{
  campaign_resource: string;
  campaign_status: string;
  channel_type: string;
  budget_resource: string;
  amount_micros: number;
}> {
  if (!/^[0-9]+$/.test(campaign_id)) {
    throw new ExpectedToolError(
      "google_ads_invalid_campaign_id",
      `invalid campaign_id: ${campaign_id}`,
    );
  }
  const query = `
    SELECT
      campaign.id,
      campaign.resource_name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign_budget.resource_name,
      campaign_budget.amount_micros
    FROM campaign
    WHERE campaign.id = ${campaign_id}
    LIMIT 1
  `;
  const rows = (await gadsSearch(tenant_id, query)) as Array<{
    campaign?: { resourceName?: string; status?: string; advertisingChannelType?: string };
    campaignBudget?: { resourceName?: string; amountMicros?: string };
  }>;
  const row = rows[0];
  if (!row?.campaign?.resourceName || !row?.campaignBudget?.resourceName) {
    throw new ExpectedToolError(
      "google_ads_campaign_not_found",
      `Campaign ${campaign_id} not found in the operator's Google Ads account (or it has no resolvable budget).`,
    );
  }
  return {
    campaign_resource: row.campaign.resourceName,
    campaign_status: row.campaign.status ?? "",
    channel_type: row.campaign.advertisingChannelType ?? "",
    budget_resource: row.campaignBudget.resourceName,
    amount_micros: Number(row.campaignBudget.amountMicros ?? 0),
  };
}

function assertNumericId(label: string, id: string): void {
  if (!/^[0-9]+$/.test(id)) {
    throw new ExpectedToolError(`google_ads_invalid_${label}`, `invalid ${label}: ${id}`);
  }
}

export type GoogleCampaignLive = {
  campaign_resource: string;
  campaign_id: string;
  name: string;
  status: string;
  channel_type: string;
  bidding_strategy_type: string;
  budget_resource: string;
  amount_micros: number;
  cpc_bid_ceiling_micros?: number | null;
};

export async function gadsGetCampaign(
  tenant_id: string,
  campaign_id: string,
): Promise<GoogleCampaignLive> {
  assertNumericId("campaign_id", campaign_id);
  const rows = (await gadsSearch(
    tenant_id,
    `
    SELECT
      campaign.id,
      campaign.name,
      campaign.resource_name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.bidding_strategy_type,
      campaign.target_spend.cpc_bid_ceiling_micros,
      campaign_budget.resource_name,
      campaign_budget.amount_micros
    FROM campaign
    WHERE campaign.id = ${campaign_id}
    LIMIT 1
  `,
  )) as Array<{
    campaign?: {
      id?: string;
      name?: string;
      resourceName?: string;
      status?: string;
      advertisingChannelType?: string;
      biddingStrategyType?: string;
      targetSpend?: { cpcBidCeilingMicros?: string | number };
    };
    campaignBudget?: { resourceName?: string; amountMicros?: string };
  }>;
  const row = rows[0];
  if (!row?.campaign?.resourceName || !row.campaignBudget?.resourceName) {
    throw new ExpectedToolError(
      "google_ads_campaign_not_found",
      `Campaign ${campaign_id} not found in the operator's Google Ads account.`,
    );
  }
  return {
    campaign_resource: row.campaign.resourceName,
    campaign_id: row.campaign.id ?? campaign_id,
    name: row.campaign.name ?? "",
    status: row.campaign.status ?? "",
    channel_type: row.campaign.advertisingChannelType ?? "",
    bidding_strategy_type: row.campaign.biddingStrategyType ?? "",
    cpc_bid_ceiling_micros: Number(row.campaign.targetSpend?.cpcBidCeilingMicros ?? 0) > 0 ? Number(row.campaign.targetSpend?.cpcBidCeilingMicros) : null,
    budget_resource: row.campaignBudget.resourceName,
    amount_micros: Number(row.campaignBudget.amountMicros ?? 0),
  };
}

export async function gadsGetCampaignEnd(tenant_id: string, campaign_id: string): Promise<{ end_date_time: string | null }> {
  assertNumericId("campaign_id", campaign_id);
  const rows = (await gadsSearch(
    tenant_id,
    `
    SELECT
      campaign.id,
      campaign.end_date_time
    FROM campaign
    WHERE campaign.id = ${campaign_id}
    LIMIT 1
  `,
  )) as Array<{ campaign?: { id?: string; endDateTime?: string } }>;
  if (!rows[0]?.campaign) {
    throw new ExpectedToolError("google_ads_campaign_not_found", `Campaign ${campaign_id} not found in the operator's Google Ads account.`);
  }
  const end = rows[0].campaign.endDateTime;
  return { end_date_time: typeof end === "string" && end.trim() ? end.trim() : null };
}

export type GoogleAdGroupLive = {
  ad_group_resource: string;
  ad_group_id: string;
  name: string;
  status: string;
  type: string;
  campaign_id: string;
  campaign_resource: string;
};

export async function gadsGetAdGroup(
  tenant_id: string,
  ad_group_id: string,
): Promise<GoogleAdGroupLive> {
  assertNumericId("ad_group_id", ad_group_id);
  const rows = (await gadsSearch(
    tenant_id,
    `
    SELECT
      ad_group.id,
      ad_group.name,
      ad_group.resource_name,
      ad_group.status,
      ad_group.type,
      campaign.id,
      campaign.resource_name
    FROM ad_group
    WHERE ad_group.id = ${ad_group_id}
    LIMIT 1
  `,
  )) as Array<{
    adGroup?: { id?: string; name?: string; resourceName?: string; status?: string; type?: string };
    campaign?: { id?: string; resourceName?: string };
  }>;
  const row = rows[0];
  if (!row?.adGroup?.resourceName || !row.campaign?.resourceName) {
    throw new ExpectedToolError(
      "google_ads_ad_group_not_found",
      `Ad group ${ad_group_id} not found in the operator's Google Ads account.`,
    );
  }
  return {
    ad_group_resource: row.adGroup.resourceName,
    ad_group_id: row.adGroup.id ?? ad_group_id,
    name: row.adGroup.name ?? "",
    status: row.adGroup.status ?? "",
    type: row.adGroup.type ?? "",
    campaign_id: row.campaign.id ?? "",
    campaign_resource: row.campaign.resourceName,
  };
}

export type GoogleAdLive = {
  ad_group_ad_resource: string;
  ad_id: string;
  ad_group_id: string;
  campaign_id: string;
  status: string;
  type: string;
};

export async function gadsGetAd(
  tenant_id: string,
  ad_group_id: string,
  ad_id: string,
): Promise<GoogleAdLive> {
  assertNumericId("ad_group_id", ad_group_id);
  assertNumericId("ad_id", ad_id);
  const rows = (await gadsSearch(
    tenant_id,
    `
    SELECT
      ad_group_ad.resource_name,
      ad_group_ad.status,
      ad_group_ad.ad.id,
      ad_group_ad.ad.type,
      ad_group.id,
      campaign.id
    FROM ad_group_ad
    WHERE ad_group.id = ${ad_group_id}
      AND ad_group_ad.ad.id = ${ad_id}
    LIMIT 1
  `,
  )) as Array<{
    adGroupAd?: { resourceName?: string; status?: string; ad?: { id?: string; type?: string } };
    adGroup?: { id?: string };
    campaign?: { id?: string };
  }>;
  const row = rows[0];
  if (!row?.adGroupAd?.resourceName) {
    throw new ExpectedToolError(
      "google_ads_ad_not_found",
      `Ad ${ad_id} not found in ad group ${ad_group_id}.`,
    );
  }
  return {
    ad_group_ad_resource: row.adGroupAd.resourceName,
    ad_id: row.adGroupAd.ad?.id ?? ad_id,
    ad_group_id: row.adGroup?.id ?? ad_group_id,
    campaign_id: row.campaign?.id ?? "",
    status: row.adGroupAd.status ?? "",
    type: row.adGroupAd.ad?.type ?? "",
  };
}

export type GoogleKeywordLive = {
  criterion_resource: string;
  criterion_id: string;
  text: string;
  match_type: string;
  negative: boolean;
  status: string;
};

export async function gadsGetKeyword(
  tenant_id: string,
  scope: { level: "ad_group"; ad_group_id: string } | { level: "campaign"; campaign_id: string },
  criterion_id: string,
): Promise<GoogleKeywordLive> {
  assertNumericId("criterion_id", criterion_id);
  if (scope.level === "ad_group") {
    assertNumericId("ad_group_id", scope.ad_group_id);
    const rows = (await gadsSearch(
      tenant_id,
      `
      SELECT
        ad_group_criterion.resource_name,
        ad_group_criterion.criterion_id,
        ad_group_criterion.status,
        ad_group_criterion.negative,
        ad_group_criterion.keyword.text,
        ad_group_criterion.keyword.match_type
      FROM ad_group_criterion
      WHERE ad_group.id = ${scope.ad_group_id}
        AND ad_group_criterion.criterion_id = ${criterion_id}
        AND ad_group_criterion.type = 'KEYWORD'
      LIMIT 1
    `,
    )) as Array<{
      adGroupCriterion?: {
        resourceName?: string;
        criterionId?: string;
        status?: string;
        negative?: boolean;
        keyword?: { text?: string; matchType?: string };
      };
    }>;
    const c = rows[0]?.adGroupCriterion;
    if (!c?.resourceName) {
      throw new ExpectedToolError(
        "google_ads_keyword_not_found",
        `Keyword criterion ${criterion_id} not found in ad group ${scope.ad_group_id}.`,
      );
    }
    return {
      criterion_resource: c.resourceName,
      criterion_id: c.criterionId ?? criterion_id,
      text: c.keyword?.text ?? "",
      match_type: c.keyword?.matchType ?? "",
      negative: c.negative === true,
      status: c.status ?? "",
    };
  }
  assertNumericId("campaign_id", scope.campaign_id);
  const rows = (await gadsSearch(
    tenant_id,
    `
    SELECT
      campaign_criterion.resource_name,
      campaign_criterion.criterion_id,
      campaign_criterion.status,
      campaign_criterion.negative,
      campaign_criterion.keyword.text,
      campaign_criterion.keyword.match_type
    FROM campaign_criterion
    WHERE campaign.id = ${scope.campaign_id}
      AND campaign_criterion.criterion_id = ${criterion_id}
      AND campaign_criterion.type = 'KEYWORD'
    LIMIT 1
  `,
  )) as Array<{
    campaignCriterion?: {
      resourceName?: string;
      criterionId?: string;
      status?: string;
      negative?: boolean;
      keyword?: { text?: string; matchType?: string };
    };
  }>;
  const c = rows[0]?.campaignCriterion;
  if (!c?.resourceName) {
    throw new ExpectedToolError(
      "google_ads_keyword_not_found",
      `Keyword criterion ${criterion_id} not found on campaign ${scope.campaign_id}.`,
    );
  }
  return {
    criterion_resource: c.resourceName,
    criterion_id: c.criterionId ?? criterion_id,
    text: c.keyword?.text ?? "",
    match_type: c.keyword?.matchType ?? "",
    negative: c.negative === true,
    status: c.status ?? "",
  };
}

export async function gadsListCampaignNames(tenant_id: string): Promise<string[]> {
  const rows = (await gadsSearch(
    tenant_id,
    `SELECT campaign.name FROM campaign WHERE campaign.status != 'REMOVED' LIMIT 5000`,
  )) as Array<{ campaign?: { name?: string } }>;
  return rows.map((r) => r.campaign?.name).filter((n): n is string => typeof n === "string");
}

export async function gadsGetBudgetGuardFacts(
  tenant_id: string,
  campaign_id: string | null,
): Promise<{ currency_code: string | null; budget_period: string | null; account_status: string | null }> {
  if (campaign_id !== null) assertNumericId("campaign_id", campaign_id);
  const query =
    campaign_id === null
      ? `SELECT customer.currency_code, customer.status FROM customer LIMIT 1`
      : `SELECT customer.currency_code, campaign_budget.period FROM campaign WHERE campaign.id = ${campaign_id} LIMIT 1`;
  const rows = (await gadsSearch(tenant_id, query)) as Array<{
    customer?: { currencyCode?: string; status?: string };
    campaignBudget?: { period?: string };
  }>;
  const row = rows[0];
  return {
    currency_code: row?.customer?.currencyCode ?? null,
    budget_period: row?.campaignBudget?.period ?? null,
    account_status: row?.customer?.status ?? null,
  };
}

export async function gadsListAdGroupNames(
  tenant_id: string,
  campaign_id: string,
): Promise<string[]> {
  assertNumericId("campaign_id", campaign_id);
  const rows = (await gadsSearch(
    tenant_id,
    `SELECT ad_group.name FROM ad_group WHERE campaign.id = ${campaign_id} AND ad_group.status != 'REMOVED' LIMIT 5000`,
  )) as Array<{ adGroup?: { name?: string } }>;
  return rows.map((r) => r.adGroup?.name).filter((n): n is string => typeof n === "string");
}
