import { z } from "zod";
import { composioExecuteTool, composioProxy, type OwnedComposioAccount } from "@/services/connectors/composio/api";
import { resolveOwnedComposioAccount } from "@/services/connectors/composio/account";
import { ExpectedToolError } from "@/services/tools/types";
import { REDDIT_ADS_API_BASE } from "./constants";
import { redditId, type RedditLevel } from "./identifiers";

export type RedditAccount = OwnedComposioAccount;
export type RedditAdAccount = { id: string; name: string; currency: string | null; business_id: string | null };

export const objectSchema = z.object({
  id: redditId,
  ad_account_id: redditId.optional(),
  campaign_id: redditId.optional(),
  ad_group_id: redditId.optional(),
  name: z.string().optional(),
  configured_status: z.string().optional(),
  effective_status: z.string().nullable().optional(),
  modified_at: z.string().optional(),
  goal_value: z.number().nullable().optional(),
  goal_type: z.string().nullable().optional(),
  conversion_pixel_id: z.string().optional(),
  optimization_goal: z.string().nullable().optional(),
}).passthrough();
export type RedditObject = z.infer<typeof objectSchema>;

const REQUEST_TIMEOUT_MS = 60_000;
const READ_ATTEMPTS = 3;
const MAX_RETRY_AFTER_SECONDS = 10;
const MAX_PAGES = 100;
const PAGE_SIZE = 100;
const RESOURCE: Record<RedditLevel, string> = { campaign: "campaigns", ad_group: "ad_groups", ad: "ads" };

export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function payload(v: unknown): unknown {
  for (let depth = 0; depth < 3 && record(v) && "data" in v; depth++) v = v.data;
  return v;
}

export function inferStatus(status: number, detail: string): number {
  if (status !== 200) return status;
  if (/\b403\b|forbidden|permission denied/i.test(detail)) return 403;
  if (/\b401\b|unauthorized|invalid_token/i.test(detail)) return 401;
  if (/\b429\b|rate.?limit/i.test(detail)) return 429;
  if (/\b(400|422) Client Error\b|\b(HTTP|status code|status) (400|422)\b|\bbad request\b|\bunprocessable (entity|content)\b/i.test(detail)) return 400;
  return status;
}

export function failureCode(status: number): string {
  if (status === 401) return "reddit_ads_token_revoked";
  if (status === 403) return "reddit_ads_permission_denied";
  if (status === 429) return "reddit_ads_rate_limited";
  if (status === 400 || status === 422) return "reddit_ads_invalid_request";
  return "reddit_ads_request_failed";
}

export function detailOf(error: unknown): string {
  return typeof error === "string" ? error : JSON.stringify(error);
}

export function readFailure(rawStatus: number, error: unknown): ExpectedToolError {
  const detail = detailOf(error);
  const status = inferStatus(rawStatus, detail);
  return new ExpectedToolError(failureCode(status), detail?.slice(0, 500) || `Reddit Ads HTTP ${status}`, { status });
}

function retryable(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

function retryDelayMs(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null && retryAfterSeconds > 0) return retryAfterSeconds * 1000;
  return 500 * 2 ** attempt;
}

function retryAfterSeconds(rateLimit: Record<string, string> | undefined): number | null {
  const value = Number(rateLimit?.["retry-after"]);
  return Number.isFinite(value) ? value : null;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function tool(account: RedditAccount, slug: string, args: Record<string, unknown>): Promise<unknown> {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    const r = await composioExecuteTool(
      { tool_slug: `REDDIT_ADS_${slug}`, user_id: account.tenant_id, connected_account_id: account.connected_account_id, arguments: args },
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );
    if (r.ok) return r.data;
    const lastAttempt = attempt === READ_ATTEMPTS - 1;
    if (!retryable(r.status) || lastAttempt) throw readFailure(r.status, r.error);
    await wait(retryDelayMs(attempt, null));
  }
  throw readFailure(0, "Reddit Ads read exhausted");
}

export async function proxyRead(account: RedditAccount, method: "GET" | "POST", endpoint: string, data?: Record<string, unknown>): Promise<unknown> {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    const r = await composioProxy(
      { account, method, endpoint, ...(data !== undefined ? { body: { data } } : {}) },
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    );
    if (r.ok) return r.json;
    const retryAfter = retryAfterSeconds(r.rate_limit);
    const lastAttempt = attempt === READ_ATTEMPTS - 1;
    const tooLong = retryAfter !== null && retryAfter > MAX_RETRY_AFTER_SECONDS;
    if (!retryable(r.status) || lastAttempt || tooLong) throw readFailure(r.status, { response: r.json, rate_limit: r.rate_limit });
    await wait(retryDelayMs(attempt, retryAfter));
  }
  throw readFailure(0, "Reddit Ads read exhausted");
}

export function endpoint(path: string, id: string, suffix = ""): string {
  return `${REDDIT_ADS_API_BASE}/${path}/${redditId.parse(id)}${suffix}`;
}

function nextPage(v: unknown, pathname: string): string | null {
  if (!record(v)) return null;
  const pagination = v.pagination;
  if (record(pagination) && typeof pagination.next_url === "string" && pagination.next_url) {
    const u = new URL(pagination.next_url);
    const sameOrigin = u.origin === new URL(REDDIT_ADS_API_BASE).origin;
    const samePath = u.pathname === pathname;
    const plain = !u.username && !u.password && !u.hash;
    if (!sameOrigin || !samePath || !plain) {
      throw new ExpectedToolError("reddit_ads_unsafe_pagination", "Reddit returned an unexpected pagination URL; the read is incomplete.");
    }
    return u.href;
  }
  return "data" in v ? nextPage(v.data, pathname) : null;
}

function rowsOf(response: unknown): Record<string, unknown>[] {
  const p = payload(response);
  const rows = record(p) && "metrics" in p ? p.metrics : p;
  if (!Array.isArray(rows) || !rows.every(record)) throw new ExpectedToolError("reddit_ads_bad_response", "Reddit returned an incomplete list or report.");
  return rows;
}

async function collectPages(account: RedditAccount, url: string, first: unknown, data?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const pathname = new URL(url).pathname;
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let response = first;
  for (let page = 0; page < MAX_PAGES; page++) {
    out.push(...rowsOf(response));
    const next = nextPage(response, pathname);
    if (!next) return out;
    if (seen.has(next)) throw new ExpectedToolError("reddit_ads_pagination_loop", "Reddit repeated a page; this read is incomplete.");
    seen.add(next);
    response = await proxyRead(account, data ? "POST" : "GET", next, data);
  }
  throw new ExpectedToolError("reddit_ads_pagination_limit", "Reddit read exceeded its page limit; no complete result is available.");
}

export async function pages(account: RedditAccount, slug: string, args: Record<string, unknown>, url: string): Promise<Record<string, unknown>[]> {
  return collectPages(account, url, await tool(account, slug, args));
}

export async function proxyPages(account: RedditAccount, url: string, data: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  return collectPages(account, url, await proxyRead(account, "POST", url, data), data);
}

export async function redditAdsAccount(tenantId: string): Promise<RedditAccount> {
  const account = await resolveOwnedComposioAccount(tenantId, "reddit_ads");
  if (!account) {
    throw new ExpectedToolError("reddit_ads_not_connected", "Reddit Ads is not connected for this workspace. Connect it from the Reddit Ads channel page.");
  }
  return account;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export async function listAdAccounts(account: RedditAccount): Promise<RedditAdAccount[]> {
  const businesses = await pages(account, "LIST_MY_BUSINESSES", {}, `${REDDIT_ADS_API_BASE}/me/businesses`);
  const businessIds = businesses.map((b) => str(b.id)).filter((id): id is string => !!id);
  const perBusiness = await Promise.all(
    businessIds.map((business_id) => pages(account, "LIST_AD_ACCOUNTS_BY_BUSINESS", { business_id }, endpoint("businesses", business_id, "/ad_accounts"))),
  );
  const seen = new Map<string, RedditAdAccount>();
  for (const a of perBusiness.flat()) {
    const id = str(a.id);
    if (!id || seen.has(id)) continue;
    seen.set(id, { id, name: str(a.name) ?? id, currency: str(a.currency)?.toUpperCase() ?? null, business_id: str(a.business_id) });
  }
  return [...seen.values()];
}

export async function ownedAccount(tenantId: string, id: string): Promise<{ account: RedditAccount; details: Record<string, unknown> }> {
  redditId.parse(id);
  const account = await redditAdsAccount(tenantId);
  const owned = (await listAdAccounts(account)).some((a) => a.id === id);
  if (!owned) throw new ExpectedToolError("reddit_ads_account_not_owned", "The selected ad account is not accessible through this workspace connection.");
  const details = payload(await tool(account, "GET_AD_ACCOUNT", { ad_account_id: id }));
  if (!record(details) || details.id !== id) throw new ExpectedToolError("reddit_ads_bad_response", "Reddit did not confirm the selected account.");
  return { account, details };
}

function assertOwnedObject(obj: RedditObject, accountId: string): void {
  if (!obj.ad_account_id) throw new ExpectedToolError("reddit_ads_bad_response", "Reddit returned an object without its ad account.");
  if (obj.ad_account_id !== accountId) throw new ExpectedToolError("reddit_ads_object_not_owned", "Reddit object does not belong to the selected ad account.");
}

async function readObject(account: RedditAccount, level: RedditLevel, id: string): Promise<unknown> {
  if (level === "ad") return proxyRead(account, "GET", endpoint("ads", id));
  const slug = level === "campaign" ? "GET_CAMPAIGN" : "GET_AD_GROUP";
  return tool(account, slug, { [`${level}_id`]: redditId.parse(id) });
}

export async function getObject(account: RedditAccount, accountId: string, level: RedditLevel, id: string): Promise<RedditObject> {
  const obj = objectSchema.parse(payload(await readObject(account, level, id)));
  if (obj.id !== id) throw new ExpectedToolError("reddit_ads_bad_response", "Reddit returned a different object than requested.");
  assertOwnedObject(obj, accountId);
  if (level === "ad_group") {
    if (!obj.campaign_id) throw new ExpectedToolError("reddit_ads_bad_response", "Ad group has no campaign.");
    await getObject(account, accountId, "campaign", obj.campaign_id);
  }
  if (level === "ad") {
    if (!obj.ad_group_id) throw new ExpectedToolError("reddit_ads_bad_response", "Ad has no ad group.");
    const group = await getObject(account, accountId, "ad_group", obj.ad_group_id);
    if (obj.campaign_id !== group.campaign_id) throw new ExpectedToolError("reddit_ads_relationship_mismatch", "Ad and ad group campaigns disagree.");
  }
  return obj;
}

export async function getPost(account: RedditAccount, id: string): Promise<Record<string, unknown>> {
  const post = payload(await proxyRead(account, "GET", endpoint("posts", id)));
  if (!record(post) || post.id !== id) throw new ExpectedToolError("reddit_ads_bad_response", "Reddit did not return the requested post.");
  return post;
}

export async function listObjects(account: RedditAccount, accountId: string, level: RedditLevel): Promise<RedditObject[]> {
  const resource = RESOURCE[level];
  const rows = await pages(account, `LIST_${resource.toUpperCase()}`, { ad_account_id: accountId, page_size: PAGE_SIZE }, endpoint("ad_accounts", accountId, `/${resource}`));
  return rows.map((row) => {
    const obj = objectSchema.parse(row);
    assertOwnedObject(obj, accountId);
    return obj;
  });
}
