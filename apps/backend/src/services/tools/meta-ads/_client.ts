
import { getSecret } from "@/services/secrets/vault";
import { notePlatformWrite } from "@/services/channels/write-fence";
import { ExpectedToolError } from "@/services/tools/types";
import { META_PERMISSION_REVOKED_MESSAGE, META_TOKEN_EXPIRED_MESSAGE } from "./error-words";
import { fullDaysWindow } from "@/services/tools/ad-window";
import { inngest } from "@/../workers/client";
import { logEvent } from "@/services/logging/logEvent";
import { redactError } from "@/services/growth/ad-goal-match";
import {
  DEFAULT_COOLDOWN_MINUTES,
  clearMetaCooldown,
  gateMetaCall,
  isMetaRateLimitCode,
  metaCaller,
  metaSafetyActive,
  startMetaCooldown,
} from "./_cooldown";

const RECONNECT_PATH = "/workspace?tab=settings";

const FB_API_VERSION = "v25.0";
export const FB_BASE = `https://graph.facebook.com/${FB_API_VERSION}`;

export type MetaAdsCreds = {
  access_token: string;
  ad_account_id: string;
};

const AUTH_SUBCODES = new Set([458, 459, 460, 463, 464, 467]);

type GraphErrorEnvelope = {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  is_transient?: boolean;
};

function parseGraphError(raw: string): GraphErrorEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    const err = parsed?.error;
    if (!err || typeof err !== "object") return null;
    return err as GraphErrorEnvelope;
  } catch {
    return null;
  }
}

function isTokenExpiredError(env: GraphErrorEnvelope | null): boolean {
  if (!env) return false;
  if (env.code === 190 || env.code === 102) return true;
  return typeof env.error_subcode === "number" && AUTH_SUBCODES.has(env.error_subcode);
}

function isPermissionError(env: GraphErrorEnvelope | null): boolean {
  if (!env || typeof env.code !== "number") return false;
  return env.code === 10 || (env.code >= 200 && env.code <= 299);
}

function nudgeTokenInvalid(tenant_id: string): void {
  const day = new Date().toISOString().slice(0, 10);
  void inngest
    .send({
      id: `meta_ads.token_invalid:${tenant_id}:${day}`,
      name: "meta_ads.token_invalid",
      data: { tenant_id },
    })
    .catch(() => {});
}

function graphError(
  tenant_id: string,
  status: number,
  raw: string,
  genericCode: "meta_ads_query_failed" | "meta_ads_write_failed",
  genericPrefix: string,
): ExpectedToolError {
  const env = parseGraphError(raw);

  if (isTokenExpiredError(env)) {
    nudgeTokenInvalid(tenant_id);
    return new ExpectedToolError(
      "meta_ads_token_expired",
      META_TOKEN_EXPIRED_MESSAGE,
      {
        next_step: "operator_action",
        unblockers: [
          `Open ${RECONNECT_PATH} → Meta Ads → Reconnect`,
          "Sign in with the Facebook account that manages the ad account",
          "Pick the same ad account if prompted",
        ],
      },
    );
  }

  if (isPermissionError(env)) {
    return new ExpectedToolError(
      "meta_ads_permission_revoked",
      META_PERMISSION_REVOKED_MESSAGE,
      {
        next_step: "operator_action",
        unblockers: [
          "In Meta Business Settings → Users → People, confirm the connected user still has Advertise / Manage on the ad account",
          `Then reconnect at ${RECONNECT_PATH} → Meta Ads`,
        ],
      },
    );
  }

  return new ExpectedToolError(genericCode, `${genericPrefix}: ${status} ${raw.slice(0, 500)}`, {
    http_status: status,
    ...(typeof env?.code === "number" ? { graph_code: env.code } : {}),
    ...(typeof env?.error_subcode === "number" ? { graph_subcode: env.error_subcode } : {}),
    ...(env?.is_transient === true ? { is_transient: true } : {}),
  });
}

const CREDS_CACHE = new Map<string, { creds: MetaAdsCreds; exp: number }>();
const CREDS_CACHE_TTL_MS = 60_000;

const CREDS_GEN = new Map<string, number>();

export function forgetMetaAdsCreds(tenant_id: string): void {
  CREDS_GEN.set(tenant_id, (CREDS_GEN.get(tenant_id) ?? 0) + 1);
  CREDS_CACHE.delete(tenant_id);
}

export async function metaAdsCreds(tenant_id: string): Promise<MetaAdsCreds> {
  const hit = CREDS_CACHE.get(tenant_id);
  if (hit && hit.exp > Date.now()) return hit.creds;
  const gen = CREDS_GEN.get(tenant_id) ?? 0;
  const [token, accountId] = await Promise.all([
    getSecret(tenant_id, "meta_ads.access_token"),
    getSecret(tenant_id, "meta_ads.ad_account_id"),
  ]);

  if (!token || !accountId) {
    throw new ExpectedToolError(
      "meta_ads_not_connected",
      `Meta Ads is not connected for this workspace. Connect it at ${RECONNECT_PATH} → Meta Ads → Connect, then sign in with Facebook and pick the ad account. Until connected, fall back to operator-supplied spend snapshots.`,
      {
        connector_slug: "meta_ads",
        next_step: "operator_action",
        unblockers: [
          `Open ${RECONNECT_PATH} → Meta Ads → Connect`,
          "Sign in with a Facebook account that has access to the ad account",
          "Pick the ad account to link, if prompted",
        ],
      },
    );
  }

  const creds = {
    access_token: token,
    ad_account_id: accountId.startsWith("act_") ? accountId : `act_${accountId}`,
  };
  if ((CREDS_GEN.get(tenant_id) ?? 0) === gen) CREDS_CACHE.set(tenant_id, { creds, exp: Date.now() + CREDS_CACHE_TTL_MS });
  return creds;
}

export type GraphCallOpts = {
  page_access_token?: string;
  caller?: string;
  safety?: boolean;
};

export async function fbGet(
  tenant_id: string,
  path: string,
  params: Record<string, string | number | undefined>,
  opts: GraphCallOpts = {},
): Promise<unknown> {
  return graphCall(tenant_id, path, opts, "read", (token) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      sp.set(k, String(v));
    }
    sp.set("access_token", token);
    return fetch(`${FB_BASE}/${path}?${sp.toString()}`, { method: "GET", signal: AbortSignal.timeout(15_000) });
  });
}

async function graphCall(
  tenant_id: string,
  path: string,
  opts: GraphCallOpts,
  kind: "read" | "write",
  send: (token: string) => Promise<Response>,
): Promise<unknown> {
  const caller = metaCaller(opts.caller);
  const creds = opts.page_access_token ? null : await metaAdsCreds(tenant_id);
  const token = opts.page_access_token ?? (creds as MetaAdsCreds).access_token;
  const account = creds?.ad_account_id ?? null;
  const safety = opts.safety === true || metaSafetyActive();
  const gate = account && !safety ? await gateMetaCall(account, caller) : { probe: false };
  let r: Response;
  try {
    r = await send(token);
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new ExpectedToolError("meta_ads_timeout", "Meta Graph API did not respond within 15s");
    }
    throw e;
  }
  recordAdAccountUsage(r, path, tenant_id);
  const usage = readUsage(r);
  if (!r.ok) {
    const raw = await r.text().catch(() => "");
    const env = parseGraphError(raw);
    const logged = logMetaError({ tenant_id, caller, http_status: r.status, env, raw, ad_account: account ?? "page" });
    if (account && (isMetaRateLimitCode(env?.code, env?.error_subcode) || (usage?.regain_minutes ?? 0) > 0)) {
      await startMetaCooldown(account, cooldownEnd(usage), `graph ${env?.code ?? r.status}/${env?.error_subcode ?? "-"} (${caller})`);
    }
    await logged;
    if (opts.page_access_token) {
      const pageMeta = { http_status: r.status, ...(typeof env?.code === "number" ? { graph_code: env.code } : {}) };
      throw kind === "read"
        ? new ExpectedToolError("meta_ads_page_read_failed", `Meta refused the Page read: ${r.status} ${raw.slice(0, 500)}`, pageMeta)
        : new ExpectedToolError("meta_ads_page_write_failed", `Meta refused the Page write: ${r.status} ${raw.slice(0, 500)}`, pageMeta);
    }
    throw kind === "read"
      ? graphError(tenant_id, r.status, raw, "meta_ads_query_failed", "Meta Ads request failed")
      : graphError(tenant_id, r.status, raw, "meta_ads_write_failed", "Meta Ads write failed");
  }
  if (account) {
    if ((usage?.regain_minutes ?? 0) > 0) {
      await startMetaCooldown(account, cooldownEnd(usage), `usage regain ${usage?.regain_minutes} min (${caller})`);
    } else if (gate.probe) {
      await clearMetaCooldown(account);
    }
    await noteUsageHigh(tenant_id, account, caller, usage);
  }
  return r.json();
}

function cooldownEnd(usage: { regain_minutes: number } | null): number {
  const minutes = usage && usage.regain_minutes > 0 ? usage.regain_minutes : DEFAULT_COOLDOWN_MINUTES;
  return Date.now() + minutes * 60_000;
}

function readUsage(r: { headers: { get(n: string): string | null } }): { pct: number; regain_minutes: number } | null {
  try {
    return parseMetaUsageHeaders((n) => r.headers.get(n));
  } catch {
    return null;
  }
}

function logMetaError(a: {
  tenant_id: string;
  caller: string;
  http_status: number;
  env: GraphErrorEnvelope | null;
  raw: string;
  ad_account: string;
}): Promise<void> {
  try {
    const text = typeof a.env?.message === "string" && a.env.message ? a.env.message : a.raw.slice(0, 300);
    return logEvent({
      level: "warn",
      source: "meta-ads",
      code: "meta_api_error",
      message: redactError(text) || `HTTP ${a.http_status}`,
      tenant_id: a.tenant_id,
      meta: {
        caller: a.caller,
        ...(typeof a.env?.code === "number" ? { graph_code: a.env.code } : {}),
        ...(typeof a.env?.error_subcode === "number" ? { subcode: a.env.error_subcode } : {}),
        ad_account: a.ad_account,
        http_status: a.http_status,
      },
    }).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

export const USAGE_HIGH_PCT = 90;
const USAGE_HIGH = new Set<string>();

async function noteUsageHigh(tenant_id: string, ad_account: string, caller: string, usage: { pct: number; regain_minutes: number } | null): Promise<void> {
  try {
    if (!usage) return;
    if (usage.pct < USAGE_HIGH_PCT) {
      USAGE_HIGH.delete(ad_account);
      return;
    }
    if (USAGE_HIGH.has(ad_account)) return;
    USAGE_HIGH.add(ad_account);
    await logEvent({
      level: "warn",
      source: "meta-ads",
      code: "meta_usage_high",
      message: `Meta usage at ${Math.round(usage.pct)}% of its limit`,
      tenant_id,
      meta: { caller, ad_account, usage_pct: Math.round(usage.pct), regain_minutes: usage.regain_minutes },
    }).catch(() => {});
  } catch {
  }
}

export async function fbGetAllPages<T>(
  tenant_id: string,
  path: string,
  params: Record<string, string | number | undefined>,
  maxPages = 100,
  opts: GraphCallOpts = {},
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const j = (await fbGet(tenant_id, path, after ? { ...params, after } : params, opts)) as {
      data?: T[];
      paging?: { next?: string; cursors?: { after?: string } };
    };
    out.push(...(j.data ?? []));
    if (!j.paging?.next) return out;
    after = j.paging.cursors?.after;
    if (!after) {
      throw new ExpectedToolError("meta_ads_pagination_incomplete", `Meta ${path}: a next page without a cursor`);
    }
  }
  throw new ExpectedToolError("meta_ads_pagination_incomplete", `Meta ${path}: more than ${maxPages} pages`);
}

const USAGE_WARN_PCT = 75;
const USAGE_BY_TENANT = new Map<string, MetaUsage>();

export type MetaUsage = { pct: number; regain_minutes: number; at: number };

export function _resetMetaUsage(): void {
  USAGE_BY_TENANT.clear();
}

export function metaUsage(tenant_id: string): MetaUsage | null {
  return USAGE_BY_TENANT.get(tenant_id) ?? null;
}

export function parseMetaUsageHeaders(get: (n: string) => string | null): { pct: number; regain_minutes: number } | null {
  let pct: number | null = null;
  let regain = 0;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  try {
    const raw = get("x-ad-account-usage");
    if (raw) {
      const u = JSON.parse(raw) as { acc_id_util_pct?: unknown };
      const p = num(u?.acc_id_util_pct);
      if (p !== null) pct = Math.max(pct ?? 0, p);
    }
  } catch {
  }
  try {
    const raw = get("x-business-use-case-usage");
    if (raw) {
      const u = JSON.parse(raw) as Record<string, Array<Record<string, unknown>>>;
      for (const list of Object.values(u ?? {})) {
        for (const e of Array.isArray(list) ? list : []) {
          for (const k of ["call_count", "total_cputime", "total_time"]) {
            const p = num(e?.[k]);
            if (p !== null) pct = Math.max(pct ?? 0, p);
          }
          const r = num(e?.estimated_time_to_regain_access);
          if (r !== null) regain = Math.max(regain, r);
        }
      }
    }
  } catch {
  }
  return pct === null && regain === 0 ? null : { pct: pct ?? 0, regain_minutes: regain };
}

export function recordAdAccountUsage(r: { headers: { get(n: string): string | null } }, path: string, tenant_id?: string): void {
  try {
    const usage = parseMetaUsageHeaders((n) => r.headers.get(n));
    if (!usage) return;
    if (tenant_id) USAGE_BY_TENANT.set(tenant_id, { ...usage, at: Date.now() });
    if (usage.pct >= USAGE_WARN_PCT || usage.regain_minutes > 0) {
      console.warn(
        `[meta-ads] rate-limit headroom low: ${usage.pct}% of quota used, ` +
          `regain in ${usage.regain_minutes} min (path=${path || "batch"})`,
      );
    }
  } catch {
  }
}

export function metaDateRange(preset: string, now: Date = new Date()): { since: string; until: string } {
  const days =
    (
      {
        last_7d: 7,
        last_14d: 14,
        last_28d: 28,
        last_30d: 30,
      } as Record<string, number>
    )[preset] ?? (preset === "this_month" || preset === "last_month" ? 0 : 7);
  if (days) return fullDaysWindow(days, now);
  if (preset === "last_month") {
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    return { since: ymd(lastMonth), until: ymd(lastDay) };
  }
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { since: ymd(since), until: ymd(now) };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function metaActionValue(
  actions: Array<{ action_type?: string; value?: string }> | undefined,
  type: string,
): number {
  if (!actions) return 0;
  const found = actions.find((a) => a.action_type === type);
  return found ? Number(found.value ?? 0) : 0;
}

export async function fbPost(
  tenant_id: string,
  path: string,
  params: Record<string, string>,
  opts: GraphCallOpts = {},
): Promise<unknown> {
  notePlatformWrite();
  return graphCall(tenant_id, path, opts, "write", (token) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) body.set(k, v);
    body.set("access_token", token);
    return fetch(`${FB_BASE}/${path}`, { method: "POST", body, signal: AbortSignal.timeout(15_000) });
  });
}

export async function getAdAccountCurrency(tenant_id: string): Promise<string> {
  const creds = await metaAdsCreds(tenant_id);
  const j = (await fbGet(tenant_id, creds.ad_account_id, { fields: "currency" })) as {
    currency?: string;
  };
  if (!j.currency) {
    throw new ExpectedToolError(
      "meta_ads_currency_unknown",
      `Could not resolve currency for ${creds.ad_account_id}`,
    );
  }
  return j.currency;
}
