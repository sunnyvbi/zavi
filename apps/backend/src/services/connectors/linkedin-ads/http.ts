
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { ExpectedToolError } from "@/services/tools/types";
import { LINKEDIN_ADS_API_BASE, LINKEDIN_ADS_DAILY_LIMIT, LINKEDIN_API_VERSION } from "./constants";
import { logEvent } from "@/services/logging/logEvent";
import { sanitizeErrorMessage } from "@/services/logging/sanitize";
import { forgetLinkedInReads, keepLinkedInRead, linkedinBusyStrikes, linkedinBusyUntil, linkedinReads, loadLinkedInAdsStore, saveLinkedInAdsStore } from "./read-cache";

export { resetLinkedInAdsReadCache } from "./read-cache";

export type RestliValue = string | number | RestliValue[] | { [key: string]: RestliValue };

export function restli(value: RestliValue): string {
  if (Array.isArray(value)) return `List(${value.map(restli).join(",")})`;
  if (typeof value === "object") {
    return `(${Object.entries(value)
      .map(([k, v]) => `${encodeURIComponent(k)}:${restli(v)}`)
      .join(",")})`;
  }
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function isLinkedInAdsPath(path: string): boolean {
  return /^[a-zA-Z]+(?:\/[a-zA-Z0-9]+)*$/.test(path) || /^adAccounts\/\d{1,20}\/creatives\?action=createInline$/.test(path) || /^adAccounts\/\d{1,20}\/creatives\/urn%3Ali%3AsponsoredCreative%3A\d{1,20}$/.test(path) || /^posts\/urn%3Ali%3A(share|ugcPost)%3A\d{1,25}$/.test(path);
}

export function linkedinPostPath(postUrn: string): string {
  if (!/^urn:li:(share|ugcPost):\d{1,25}$/.test(postUrn)) {
    throw new ExpectedToolError("linkedin_ads_bad_path", "linkedin_ads: invalid API resource path");
  }
  return `posts/${encodeURIComponent(postUrn)}`;
}

export function linkedinCreativePath(accountId: string, creativeId: string): string {
  if (!/^\d{1,20}$/.test(accountId) || !/^\d{1,20}$/.test(creativeId)) {
    throw new ExpectedToolError("linkedin_ads_bad_path", "linkedin_ads: invalid API resource path");
  }
  return `adAccounts/${accountId}/creatives/${encodeURIComponent(`urn:li:sponsoredCreative:${creativeId}`)}`;
}

export const LINKEDIN_ADS_FORBIDDEN_READ =
  "LinkedIn did not let Zavi read this ad account. Your LinkedIn user needs a role on it: ask an account admin in LinkedIn Campaign Manager to give you one, or reconnect LinkedIn Ads with a LinkedIn user who already has one.";

export const LINKEDIN_ADS_FORBIDDEN_WRITE =
  "LinkedIn did not let Zavi make changes in this ad account. Ask an account admin in LinkedIn Campaign Manager to give your LinkedIn user a Campaign Manager or Account Manager role on it, then reconnect LinkedIn Ads, or reconnect with a LinkedIn user who already has that role.";

export const LINKEDIN_ADS_RECONNECT = "LinkedIn Ads needs to be reconnected. Reconnect it from Connectors in the left menu.";
export const LINKEDIN_ADS_UNAVAILABLE = "LinkedIn Ads is not responding right now. Try again in a few minutes.";
export const LINKEDIN_ADS_BUSY = "LinkedIn Ads is busy right now. Try again in a few minutes.";
export { LINKEDIN_ADS_DAILY_LIMIT };
export const LINKEDIN_ADS_UNREADABLE = "LinkedIn Ads sent back an answer Zavi could not read. Try again in a few minutes.";
export const LINKEDIN_ADS_READ_FAILED = "LinkedIn Ads could not answer that request. Try again in a few minutes.";
export const LINKEDIN_ADS_BILLING = "LinkedIn says this ad account has a billing problem. Fix the payment method in LinkedIn Campaign Manager, then try again.";
export const LINKEDIN_ADS_BILLING_HOLD = "LinkedIn has paused your ad account for billing. Add or fix the payment method in LinkedIn Campaign Manager, then try again.";
export const linkedinOnBillingHold = (servingStatuses?: readonly string[]): boolean => !!servingStatuses?.includes("BILLING_HOLD");
export const LINKEDIN_ADS_SETTINGS_REFUSED = "LinkedIn did not accept the campaign settings. Check the budget, dates and audience, then try again.";
export const LINKEDIN_ADS_CHANGE_REFUSED = "LinkedIn did not accept this change. Try again in a few minutes, or make the change in LinkedIn Campaign Manager.";

export type LinkedInCreateStep = "campaign group" | "campaign" | "ad" | "saved audience";
const CREATE_STEP_REFUSED: Record<LinkedInCreateStep, string> = {
  "campaign group": "LinkedIn did not accept the campaign group, the first step of this campaign.",
  campaign: LINKEDIN_ADS_SETTINGS_REFUSED,
  ad: "LinkedIn did not accept the ad, the last step of this campaign, for this campaign's post.",
  "saved audience": "LinkedIn did not accept this saved audience.",
};
const CARD_REASON_MAX = 160;
const TOKEN_LIKE = /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g;

function cardReason(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  const text = reason
    .replace(/urn:li:[A-Za-z]+:[^\s,;)"']+/g, "a LinkedIn item")
    .replace(TOKEN_LIKE, "…")
    .replace(/\d{6,}/g, "…")
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩"“”]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > CARD_REASON_MAX ? `${text.slice(0, CARD_REASON_MAX - 1)}…` : text;
}

export function linkedinCreateRefused(step: LinkedInCreateStep, reason: unknown): string {
  const said = cardReason(reason);
  return said ? `${CREATE_STEP_REFUSED[step]} LinkedIn said: "${said}".` : CREATE_STEP_REFUSED[step];
}

function linkedinFailure(status: number, write?: "CREATE" | "PARTIAL_UPDATE", step?: LinkedInCreateStep, reason?: string | null): string {
  if (status === 401) return LINKEDIN_ADS_RECONNECT;
  if (status === 429) return LINKEDIN_ADS_BUSY;
  if (status >= 500) return LINKEDIN_ADS_UNAVAILABLE;
  if (!write) return LINKEDIN_ADS_READ_FAILED;
  if (status === 402) return LINKEDIN_ADS_BILLING;
  if (write === "CREATE") return step ? linkedinCreateRefused(step, reason) : LINKEDIN_ADS_SETTINGS_REFUSED;
  return LINKEDIN_ADS_CHANGE_REFUSED;
}

export type LinkedInReadFreshness = boolean | "join";

export type LinkedInPage<T> = { elements?: T[]; paging?: { start?: number; count?: number; total?: number }; metadata?: { nextPageToken?: string | null } };

const TAXONOMY_TTL_MS = 24 * 3600_000;
const ACCOUNT_TTL_MS = 5 * 60_000;
const BUSY_COOLDOWN_MS = 60_000;
const READ_CACHE_MAX = 500;
const reads = linkedinReads;
const busyUntil = linkedinBusyUntil;

const BUSY_COOLDOWN_MAX_MS = 3600_000;
const STRIKE_WINDOW_MS = 15 * 60_000;
const requestCalls = new AsyncLocalStorage<{ calls: string[] }>();

export function countLinkedInAdsCalls<T>(run: () => T): { calls: string[]; result: T } {
  const scope = { calls: [] as string[] };
  return { calls: scope.calls, result: requestCalls.run(scope, run) };
}

export function linkedinAdsCallLog(req: { method: string; path: string }, res: { on(event: "finish", fn: () => void): unknown }, next: () => void): void {
  const { calls } = countLinkedInAdsCalls(() => next());
  res.on("finish", () => {
    if (calls.length) console.info(`[linkedin-ads] ${req.method} ${req.path} made ${calls.length} LinkedIn calls: ${calls.join(", ")}`);
  });
}

function countCall(method: string, path: string): void {
  requestCalls.getStore()?.calls.push(`${method} ${resourceOf(path)}`);
}

function resourceOf(path: string): string {
  return path.split("/")[0];
}

export function linkedinLimitKey(method: string, path: string): string {
  return `${method} ${path.split("/").map((seg) => (/^(?:\d+|urn(?:%3A|:).*)$/i.test(seg) ? ":id" : seg)).join("/")}`;
}

function getMethod(params: Record<string, RestliValue>, restliMethod?: "FINDER" | "BATCH_GET"): string {
  return restliMethod ?? (params.q === undefined ? "GET" : "FINDER");
}

function busyMessage(caller: string, endpoint: string): { message: string; until: number } | null {
  const now = Date.now();
  const daily = Math.max(busyUntil.get(`app:${endpoint}`) ?? 0, busyUntil.get(`${caller}:${endpoint}`) ?? 0);
  if (daily > now) return { message: LINKEDIN_ADS_DAILY_LIMIT, until: daily };
  const until = busyUntil.get(caller) ?? 0;
  return until > now ? { message: LINKEDIN_ADS_BUSY, until } : null;
}

function busyError(busy: { message: string; until: number }): ExpectedToolError {
  return new ExpectedToolError("linkedin_ads_http_error", busy.message, { status: 429, http_status: 429, retry_at: new Date(busy.until).toISOString() });
}

async function bodyText(resp: { text?: () => Promise<string> }): Promise<string> {
  try {
    return (await resp.text?.()) ?? "";
  } catch {
    return "";
  }
}

function noteBusy(body: string, headers: Headers | undefined, caller: string, endpoint: string, endpointOnly = false): { message: string; until: number } {
  let message = "";
  try {
    message = String((JSON.parse(body) as { message?: unknown }).message ?? "");
  } catch {
    message = "";
  }
  if (/\bDAY limit\b/i.test(message)) {
    const midnight = new Date();
    midnight.setUTCHours(24, 0, 0, 0);
    busyUntil.set(/\bAPPLICATION DAY\b/i.test(message) ? `app:${endpoint}` : `${caller}:${endpoint}`, midnight.getTime());
    saveLinkedInAdsStore();
    return { message: LINKEDIN_ADS_DAILY_LIMIT, until: midnight.getTime() };
  }
  const wait = Number(headers?.get?.("retry-after"));
  const now = Date.now();
  if (endpointOnly) {
    const until = now + Math.min(Number.isFinite(wait) && wait > 0 ? wait * 1000 : BUSY_COOLDOWN_MS, BUSY_COOLDOWN_MAX_MS);
    busyUntil.set(`${caller}:${endpoint}`, until);
    saveLinkedInAdsStore();
    return { message: LINKEDIN_ADS_BUSY, until };
  }
  const paused = busyUntil.get(caller) ?? 0;
  const last = linkedinBusyStrikes.get(caller);
  const burst = paused > now;
  const n = burst ? (last?.n ?? 0) : last && now - last.at < STRIKE_WINDOW_MS ? last.n + 1 : 0;
  if (!burst) linkedinBusyStrikes.set(caller, { n, at: now });
  const pause = Number.isFinite(wait) && wait > 0 ? wait * 1000 : BUSY_COOLDOWN_MS * 2 ** Math.min(n, 6);
  const until = Math.max(paused, now + Math.min(pause, BUSY_COOLDOWN_MAX_MS));
  busyUntil.set(caller, until);
  saveLinkedInAdsStore();
  return { message: LINKEDIN_ADS_BUSY, until };
}

function noteAnswered(caller: string): void {
  linkedinBusyStrikes.delete(caller);
}

function readTtl(path: string, params: Record<string, RestliValue>): number {
  if (path === "adTargetingEntities" && (params.q === "typeahead" || params.q === "adTargetingFacet")) return TAXONOMY_TTL_MS;
  if (path === "adAccounts" || /^adAccounts\/\d{1,20}$/.test(path)) return ACCOUNT_TTL_MS;
  if (path === "adAccountUsers" && params.q === "authenticatedUser") return ACCOUNT_TTL_MS;
  if (path === "adAnalytics" && params.q === "analytics") return analyticsTtl(params);
  if (/^posts\/urn%3Ali%3A(share|ugcPost)%3A\d{1,25}$/.test(path)) return POST_TTL_MS;
  if (/^organizations\/\d{1,20}$/.test(path)) return ORGANIZATION_TTL_MS;
  if (/^adAccounts\/\d{1,20}\/creatives$/.test(path) && params.q === "criteria") return CREATIVES_TTL_MS;
  if (path === "audienceCounts" && params.q === "targetingCriteriaV2") return AUDIENCE_COUNT_TTL_MS;
  return 0;
}

const ANALYTICS_LIVE_TTL_MS = 5 * 60_000;
const ANALYTICS_RECENT_TTL_MS = 30 * 60_000;
const ANALYTICS_CLOSED_TTL_MS = 6 * 3600_000;
const ANALYTICS_RECENT_DAYS = 2;
const POST_TTL_MS = 10 * 60_000;
const ORGANIZATION_TTL_MS = 6 * 3600_000;
const CREATIVES_TTL_MS = 2 * 60_000;
const AUDIENCE_COUNT_TTL_MS = 15 * 60_000;
const CAMPAIGN_DISPLAY_TTL_MS = 2 * 60_000;
const ADVISORY_TIMEOUT_MS = 5_000;
export const LINKEDIN_MEDIA_TTL_MS = 30 * 60_000;

const displayReads = new AsyncLocalStorage<{ refresh: boolean; stamp: string | null }>();

export function withLinkedInDisplayReads<T>(scope: { refresh: boolean; stamp: string | null }, run: () => T): T {
  return displayReads.run(scope, run);
}

function displayTtl(path: string, params: Record<string, RestliValue>): number {
  if (/^adAccounts\/\d{1,20}\/(?:adCampaigns|adCampaignGroups)$/.test(path) && params.q === "search") return CAMPAIGN_DISPLAY_TTL_MS;
  return /^adAccounts\/\d{1,20}\/(?:adCampaigns|adCampaignGroups)\/\d{1,20}$/.test(path) ? CAMPAIGN_DISPLAY_TTL_MS : 0;
}

function usableRead(path: string, params: Record<string, RestliValue>, value: unknown): boolean {
  const body = value !== null && typeof value === "object" ? (value as { elements?: unknown; id?: unknown }) : null;
  if (/^adAccounts\/\d{1,20}\/adCampaigns\/\d{1,20}$/.test(path)) return body?.id !== undefined;
  if (path === "adTargetingEntities") return !(Array.isArray(body?.elements) && body.elements.length === 0);
  const listing = path === "adAccounts" || path === "adAnalytics" || /^adAccounts\/\d{1,20}\/(?:adCampaigns|adCampaignGroups|creatives)$/.test(path);
  return !listing || params.q === undefined || Array.isArray(body?.elements);
}

function analyticsTtl(params: Record<string, RestliValue>): number {
  const range = params.dateRange;
  if (!range || typeof range !== "object" || Array.isArray(range)) return 0;
  const end = range.end;
  if (!end || typeof end !== "object" || Array.isArray(end)) return 0;
  const { year, month, day } = end;
  if (typeof year !== "number" || typeof month !== "number" || typeof day !== "number") return 0;
  const now = new Date();
  const daysAgo = Math.round((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.UTC(year, month - 1, day)) / 86_400_000);
  if (!Number.isFinite(daysAgo) || daysAgo <= 0) return ANALYTICS_LIVE_TTL_MS;
  return daysAgo <= ANALYTICS_RECENT_DAYS ? ANALYTICS_RECENT_TTL_MS : ANALYTICS_CLOSED_TTL_MS;
}

export async function linkedinAdsGet<T>(
  accessToken: string,
  path: string,
  params: Record<string, RestliValue> = {},
  rawParams: Record<string, string> = {},
  options: { restliMethod?: "FINDER" | "BATCH_GET"; fresh?: LinkedInReadFreshness; pauseCritical?: boolean; advisory?: boolean } = {},
): Promise<T> {
  if (!isLinkedInAdsPath(path)) {
    throw new ExpectedToolError("linkedin_ads_bad_path", "linkedin_ads: invalid API resource path");
  }
  const url = new URL(path, LINKEDIN_ADS_API_BASE);
  url.search = [
    ...Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${restli(v)}`),
    ...Object.entries(rawParams).map(([k, v]) => `${encodeURIComponent(k)}=${v}`),
  ].join("&");
  const caller = createHash("sha256").update(accessToken).digest("hex");
  loadLinkedInAdsStore();
  const scope = displayReads.getStore();
  const display = scope?.stamp && !options.fresh && !options.pauseCritical ? displayTtl(path, params) : 0;
  const ttl = readTtl(path, params) || display;
  const key = display ? `${caller}:display:${scope?.stamp}:${options.restliMethod ?? ""}:${url.href}` : `${caller}:${options.restliMethod ?? ""}:${url.href}`;
  const hit = ttl ? reads.get(key) : undefined;
  const servable = options.fresh === "join" ? hit?.pending === true : !options.fresh && !options.pauseCritical && !(display && scope?.refresh);
  if (hit && hit.expires > Date.now() && servable) return hit.value as Promise<T>;
  const endpoint = linkedinLimitKey(getMethod(params, options.restliMethod), path);
  const busy = options.pauseCritical ? null : busyMessage(caller, endpoint);
  if (busy) throw busyError(busy);
  if (!ttl) return linkedinAdsFetch<T>(accessToken, caller, path, endpoint, url.href, options);
  const value = linkedinAdsFetch<T>(accessToken, caller, path, endpoint, url.href, options);
  const expires = Date.now() + ttl;
  const entry = { expires, value: value as Promise<unknown>, pending: true };
  reads.delete(key);
  reads.set(key, entry);
  if (reads.size > READ_CACHE_MAX) reads.delete(reads.keys().next().value!);
  value.then(
    (v) => {
      entry.pending = false;
      if (reads.get(key) !== entry) return;
      if (usableRead(path, params, v)) keepLinkedInRead(key, expires, v);
      else reads.delete(key);
    },
    () => {
      entry.pending = false;
      if (reads.get(key) === entry) reads.delete(key);
    },
  );
  return value;
}

export function linkedinCachedRead<T>(accessToken: string, path: string, params: Record<string, RestliValue> = {}): Promise<T> | null {
  if (!isLinkedInAdsPath(path) || !readTtl(path, params)) return null;
  const url = new URL(path, LINKEDIN_ADS_API_BASE);
  url.search = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${restli(v)}`).join("&");
  loadLinkedInAdsStore();
  const hit = reads.get(`${createHash("sha256").update(accessToken).digest("hex")}::${url.href}`);
  return hit && hit.expires > Date.now() ? (hit.value as Promise<T>) : null;
}

const BATCH_IDS = 50;
const URN_PATTERN: Record<"posts" | "images" | "videos", RegExp> = {
  posts: /^urn:li:(share|ugcPost):\d{1,25}$/,
  images: /^urn:li:image:[\w-]{1,200}$/,
  videos: /^urn:li:video:[\w-]{1,200}$/,
};

function batchTtl(resource: "posts" | "images" | "videos", value: Record<string, unknown>): number {
  if (resource === "posts") return POST_TTL_MS;
  const expiresAt = value.downloadUrlExpiresAt;
  if (typeof expiresAt !== "number") return LINKEDIN_MEDIA_TTL_MS;
  return Math.min(LINKEDIN_MEDIA_TTL_MS, expiresAt - Date.now() - 60_000);
}

export async function linkedinAdsBatchGet(accessToken: string, resource: "posts" | "images" | "videos", ids: readonly string[]): Promise<Record<string, unknown>> {
  const caller = createHash("sha256").update(accessToken).digest("hex");
  loadLinkedInAdsStore();
  const out: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    if (!URN_PATTERN[resource].test(id)) continue;
    const hit = reads.get(`${caller}:batch:${resource}:${id}`);
    if (hit && hit.expires > Date.now()) out[id] = await hit.value;
    else missing.push(id);
  }
  for (let offset = 0; offset < missing.length; offset += BATCH_IDS) {
    const chunk = missing.slice(offset, offset + BATCH_IDS);
    const data = await linkedinAdsGet<{ results?: unknown }>(accessToken, resource, { ids: chunk }, {}, { restliMethod: "BATCH_GET" });
    const results = data && typeof data.results === "object" && data.results !== null && !Array.isArray(data.results) ? (data.results as Record<string, unknown>) : {};
    for (const id of chunk) {
      const value = results[id];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      out[id] = value;
      const ttl = batchTtl(resource, value as Record<string, unknown>);
      if (!(ttl > 0)) continue;
      const key = `${caller}:batch:${resource}:${id}`;
      const expires = Date.now() + ttl;
      reads.delete(key);
      reads.set(key, { expires, value: Promise.resolve(value) });
      if (reads.size > READ_CACHE_MAX) reads.delete(reads.keys().next().value!);
      keepLinkedInRead(key, expires, value);
    }
  }
  return out;
}

async function linkedinAdsFetch<T>(
  accessToken: string,
  caller: string,
  path: string,
  endpoint: string,
  href: string,
  options: { restliMethod?: "FINDER" | "BATCH_GET"; advisory?: boolean },
): Promise<T> {
  countCall("GET", path);
  const resp = await fetch(href, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Linkedin-Version": LINKEDIN_API_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
      Accept: "application/json",
      ...(options.restliMethod ? { "X-RestLi-Method": options.restliMethod } : {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(options.advisory ? ADVISORY_TIMEOUT_MS : 20_000),
  });
  if (!resp.ok) {
    if (resp.status === 429) {
      throw busyError(noteBusy(await bodyText(resp), resp.headers, caller, endpoint, options.advisory));
    }
    if (resp.status === 403) {
      throw new ExpectedToolError("linkedin_ads_forbidden", LINKEDIN_ADS_FORBIDDEN_READ, { status: 403, http_status: 403 });
    }
    throw new ExpectedToolError(
      resp.status === 401 ? "linkedin_ads_token_revoked" : "linkedin_ads_http_error",
      linkedinFailure(resp.status),
      { status: resp.status, http_status: resp.status },
    );
  }
  noteAnswered(caller);
  try {
    return (await resp.json()) as T;
  } catch {
    throw new ExpectedToolError("linkedin_ads_bad_response", LINKEDIN_ADS_UNREADABLE);
  }
}

async function sendLinkedInAdsPost(
  accessToken: string,
  path: string,
  method: "CREATE" | "PARTIAL_UPDATE",
  body: Record<string, unknown>,
  step?: LinkedInCreateStep,
): Promise<{ id: string | null }> {
  if (!isLinkedInAdsPath(path)) {
    throw new ExpectedToolError("linkedin_ads_bad_path", "linkedin_ads: invalid API resource path");
  }
  const caller = createHash("sha256").update(accessToken).digest("hex");
  loadLinkedInAdsStore();
  countCall(method, path);
  const resp = await fetch(new URL(path, LINKEDIN_ADS_API_BASE).href, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Linkedin-Version": LINKEDIN_API_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
      "X-RestLi-Method": method,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    if (resp.status === 401) {
      throw new ExpectedToolError("linkedin_ads_token_revoked", LINKEDIN_ADS_RECONNECT, { status: 401 });
    }
    const body = resp.status < 500 ? await bodyText(resp) : "";
    if (resp.status === 403) {
      const reason = body ? await linkedinRefusalReason({ text: async () => body }) : null;
      throw new ExpectedToolError("linkedin_ads_forbidden", LINKEDIN_ADS_FORBIDDEN_WRITE, { status: 403, http_status: 403, ...(reason ? { linkedin_reason: reason } : {}) });
    }
    const busy = resp.status === 429 ? noteBusy(body, resp.headers, caller, linkedinLimitKey(method, path)).message : null;
    const reason = body ? await linkedinRefusalReason({ text: async () => body }) : null;
    const billingHold = !busy && resp.status < 500 && /BILLING_HOLD|billing hold|payment method/i.test(body);
    throw new ExpectedToolError(
      resp.status < 500 ? "linkedin_ads_write_refused" : "linkedin_ads_http_error",
      busy ?? (billingHold ? LINKEDIN_ADS_BILLING_HOLD : linkedinFailure(resp.status, method, step, reason)),
      { status: resp.status, http_status: resp.status, ...(reason ? { linkedin_reason: reason } : {}), ...(billingHold ? { billing_hold: true } : {}) },
    );
  }
  noteAnswered(caller);
  return { id: resp.headers.get("x-restli-id") };
}

export async function linkedinAdsPost(
  accessToken: string,
  path: string,
  method: "CREATE" | "PARTIAL_UPDATE",
  body: Record<string, unknown>,
  step?: LinkedInCreateStep,
): Promise<{ id: string | null }> {
  try {
    return await sendLinkedInAdsPost(accessToken, path, method, body, step);
  } finally {
    const account = /^adAccounts\/(\d{1,20})\//.exec(path)?.[1];
    if (account) {
      const written = new RegExp(`/adAccounts/${account}/(?:adCampaigns|adCampaignGroups|creatives)(?:[/?]|$)`);
      forgetLinkedInReads((key) => written.test(key));
    }
  }
}

const LOGGED_REFUSALS = new Set(["linkedin_ads_write_refused", "linkedin_ads_forbidden"]);

export async function logLinkedInRefusal(e: unknown, at: { tenantId: string; objectId: string; stage: "create_bundle" | "launch" | "pause" | "change" }): Promise<void> {
  if (!(e instanceof ExpectedToolError)) return;
  const reason = e.meta?.linkedin_reason;
  const said = typeof reason === "string" && reason ? reason : null;
  if (!said && !LOGGED_REFUSALS.has(e.code)) return;
  const message = said ? sanitizeErrorMessage(said.replace(TOKEN_LIKE, "…")) : "LinkedIn refused this write and sent no reason Zavi could read.";
  console.warn(`[linkedin-ads] ${at.stage} refused by LinkedIn (${e.meta?.http_status ?? "no status"}): ${message}`);
  await logEvent({
    level: "warn",
    source: "linkedin-ads",
    code: "linkedin_ads.write_refused",
    tenant_id: at.tenantId,
    message,
    meta: { stage: at.stage, object_id: at.objectId, failure_class: e.code, http_status: e.meta?.http_status },
  });
}

const REASON_MAX = 400;

export async function linkedinRefusalReason(resp: { text(): Promise<string> }): Promise<string | null> {
  let body: unknown;
  try {
    body = JSON.parse(await resp.text());
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const b = body as { message?: unknown; code?: unknown; errors?: unknown; errorDetails?: { inputErrors?: unknown } };
  const present = (values: unknown[]) => values.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  const inputErrors = (Array.isArray(b.errorDetails?.inputErrors) ? b.errorDetails.inputErrors : []) as Array<{ description?: unknown; code?: unknown; input?: { inputPath?: { fieldPath?: unknown } } } | null>;
  const errors = (Array.isArray(b.errors) ? b.errors : []) as Array<{ description?: unknown; message?: unknown; code?: unknown; field?: unknown } | null>;
  const parts = [
    ...inputErrors.map((e) => present([e?.input?.inputPath?.fieldPath, e?.description ?? e?.code]).join(": ")),
    ...errors.map((e) => present([e?.field, e?.description ?? e?.message ?? e?.code]).join(": ")),
  ].filter(Boolean);
  if (!parts.length) parts.push(...present([b.message, b.code]).slice(0, 1));
  const text = parts.join("; ").replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
}
