
import { z } from "zod";
import { getComposioApiKey } from "./api-key";
import { assertStreamableUrlAllowed } from "@/services/mcp/streamable-guards";
import { tiktokResponseError } from "./tiktok-response-error";

const API_BASE =
  process.env.COMPOSIO_API_BASE?.trim() || "https://backend.composio.dev";

const linkResponseSchema = z.object({
  redirect_url: z.string().url().optional(),
  redirectUrl: z.string().url().optional(),
  connected_account_id: z.string().optional(),
  connectedAccountId: z.string().optional(),
  id: z.string().optional(),
});

export type LinkResult = {
  redirect_url: string;
  connected_account_id: string;
};

export type ImportedBearerAccount = { connected_account_id: string };

const listItemSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
});

export async function composioFetch(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const url = `${API_BASE.replace(/\/$/, "")}${path}`;
  assertStreamableUrlAllowed(url);
  return fetch(url, {
    method,
    headers: {
      "x-api-key": getComposioApiKey(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
    ...(signal ? { signal } : {}),
  });
}

function redirectFrom(j: Record<string, unknown>): { redirect: string | undefined; id: string | undefined } {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const nested = (j.connectionData ?? j.connection_data) as { val?: { redirectUrl?: unknown; redirect_url?: unknown } } | undefined;
  const redirect = str(j.redirect_url) ?? str(j.redirectUrl) ?? str(nested?.val?.redirectUrl) ?? str(nested?.val?.redirect_url);
  const id = str(j.connected_account_id) ?? str(j.connectedAccountId) ?? str(j.id);
  return { redirect, id };
}

async function composioLinkHosted(args: { user_id: string; auth_config_id: string; callback_url: string }): Promise<LinkResult> {
  const res = await composioFetch("POST", "/api/v3/connected_accounts/link", {
    user_id: args.user_id,
    auth_config_id: args.auth_config_id,
    callback_url: args.callback_url,
  });
  if (!res.ok) {
    throw new Error(`composio link HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const json = linkResponseSchema.parse(await res.json());
  const redirect = json.redirect_url ?? json.redirectUrl;
  const id = json.connected_account_id ?? json.connectedAccountId ?? json.id;
  if (!redirect || !id) {
    throw new Error("composio link: missing redirect_url or connected_account_id in response");
  }
  return { redirect_url: redirect, connected_account_id: id };
}

async function composioCreateWithData(args: {
  user_id: string;
  auth_config_id: string;
  callback_url: string;
  connection_data: Record<string, string>;
}): Promise<LinkResult> {
  const res = await composioFetch("POST", "/api/v3/connected_accounts", {
    auth_config: { id: args.auth_config_id },
    connection: { user_id: args.user_id, callback_url: args.callback_url, data: args.connection_data },
  });
  if (!res.ok) {
    throw new Error(`composio create HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const { redirect, id } = redirectFrom((await res.json()) as Record<string, unknown>);
  if (!redirect || !id) {
    throw new Error("composio create: missing redirect_url or connected_account_id in response");
  }
  return { redirect_url: redirect, connected_account_id: id };
}

export async function composioLink(args: {
  user_id: string;
  auth_config_id: string;
  callback_url: string;
  connection_data?: Record<string, string>;
}): Promise<LinkResult> {
  if (args.connection_data) return composioCreateWithData({ ...args, connection_data: args.connection_data });
  return composioLinkHosted(args);
}

export async function composioImportBearerToken(args: {
  user_id: string;
  auth_config_id: string;
  access_token: string;
  connection_data?: Record<string, string>;
}): Promise<ImportedBearerAccount> {
  const res = await composioFetch("POST", "/api/v3.1/connected_accounts", {
    auth_config: { id: args.auth_config_id },
    connection: {
      user_id: args.user_id,
      state: {
        authScheme: "BEARER_TOKEN",
        val: {
          status: "ACTIVE",
          token: args.access_token,
          ...(args.connection_data ?? {}),
        },
      },
    },
  });
  if (!res.ok) {
    throw new Error(`composio bearer import HTTP ${res.status}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  const id = typeof json.id === "string"
    ? json.id
    : typeof json.connected_account_id === "string"
      ? json.connected_account_id
      : typeof json.connectedAccountId === "string"
        ? json.connectedAccountId
        : null;
  if (!id) throw new Error("composio bearer import: missing connected account id");
  return { connected_account_id: id };
}

export async function composioPatchBearerToken(args: {
  connected_account_id: string;
  access_token: string;
}): Promise<void> {
  const res = await composioFetch(
    "PATCH",
    `/api/v3.1/connected_accounts/${encodeURIComponent(args.connected_account_id)}`,
    {
      connection: {
        state: {
          authScheme: "BEARER_TOKEN",
          val: { token: args.access_token },
        },
      },
    },
  );
  if (!res.ok) {
    throw new Error(`composio bearer patch HTTP ${res.status}`);
  }
}

async function composioVerifyListed(args: {
  user_id: string;
  auth_config_id: string;
  connected_account_id: string;
}, statuses?: string): Promise<boolean> {
  const qs = new URLSearchParams({
    user_ids: args.user_id,
    auth_config_ids: args.auth_config_id,
    limit: "100",
    ...(statuses ? { statuses } : {}),
  });
  const res = await composioFetch("GET", `/api/v3/connected_accounts?${qs.toString()}`);
  if (!res.ok) {
    throw new Error(`composio list HTTP ${res.status}`);
  }
  const data = (await res.json()) as { items?: unknown[]; data?: unknown[] };
  const items = (data.items ?? data.data ?? []) as unknown[];
  for (const it of items) {
    const parsed = listItemSchema.safeParse(it);
    if (parsed.success && parsed.data.id === args.connected_account_id) return true;
  }
  return false;
}

export function composioVerifyActive(args: Parameters<typeof composioVerifyListed>[0]): Promise<boolean> {
  return composioVerifyListed(args, "ACTIVE");
}

export function composioVerifyOwned(args: Parameters<typeof composioVerifyListed>[0]): Promise<boolean> {
  return composioVerifyListed(args);
}

export type ComposioAuthConfigInfo = {
  id: string;
  is_composio_managed: boolean;
  auth_scheme: string | null;
  status: string | null;
};

export async function composioGetAuthConfig(id: string): Promise<ComposioAuthConfigInfo> {
  const res = await composioFetch("GET", `/api/v3/auth_configs/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`composio auth config HTTP ${res.status}`);
  const j = (await res.json()) as Record<string, unknown> | null;
  return {
    id,
    is_composio_managed: j?.is_composio_managed === true,
    auth_scheme: typeof j?.auth_scheme === "string" ? j.auth_scheme : null,
    status: typeof j?.status === "string" ? j.status : null,
  };
}

export function authConfigSupportsBearerImport(config: ComposioAuthConfigInfo): boolean {
  return !config.is_composio_managed && config.auth_scheme === "BEARER_TOKEN" && config.status === "ENABLED";
}

export type ComposioAccountState = { status: string | null; status_reason: string | null; updated_at: string | null; user_id: string | null; subdomain: string | null };
export async function composioGetAccount(connected_account_id: string): Promise<ComposioAccountState> {
  const res = await composioFetch("GET", `/api/v3/connected_accounts/${encodeURIComponent(connected_account_id)}`);
  if (!res.ok) throw new Error(`composio get account HTTP ${res.status}`);
  const j = (await res.json()) as Record<string, unknown> | null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    status: str(j?.status),
    status_reason: str(j?.status_reason) ?? str(j?.statusReason),
    updated_at: str(j?.updated_at) ?? str(j?.updatedAt),
    user_id: str(j?.user_id) ?? str(j?.userId),
    subdomain: str((j?.data as Record<string, unknown> | undefined)?.subdomain),
  };
}

export async function composioDisconnect(connected_account_id: string): Promise<void> {
  const res = await composioFetch(
    "DELETE",
    `/api/v3/connected_accounts/${encodeURIComponent(connected_account_id)}`,
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`composio delete HTTP ${res.status}`);
  }
}

export type ComposioExecResult = {
  ok: boolean;
  status: number;
  data: unknown;
  error: unknown;
  outcome_unknown: boolean;
  retry_after_s?: number | null;
};

const ERROR_ONLY_KEYS = new Set(["error", "request", "status", "status_code", "message", "http_error"]);
export function wrappedVendorError(data: unknown): string | null {
  for (const d of [data, (data as { data?: unknown } | null)?.data]) {
    if (!d || typeof d !== "object" || Array.isArray(d)) continue;
    const o = d as Record<string, unknown>;
    if (typeof o.error === "string" && o.error.trim() && Object.keys(o).every((k) => ERROR_ONLY_KEYS.has(k))) {
      return o.error.trim();
    }
  }
  return null;
}

export async function composioExecuteTool(a: {
  tool_slug: string; user_id: string; connected_account_id: string; arguments: Record<string, unknown>;
}, signal?: AbortSignal): Promise<ComposioExecResult> {
  let res: Response;
  try {
    res = await composioFetch("POST", `/api/v3.1/tools/execute/${encodeURIComponent(a.tool_slug)}`, {
      user_id: a.user_id, connected_account_id: a.connected_account_id, arguments: a.arguments,
    }, signal);
  } catch {
    return { ok: false, status: 0, data: null, error: "composio_transport_error", outcome_unknown: true };
  }
  let json: { successful?: unknown; data?: unknown; error?: unknown } | null;
  try {
    const parsed: unknown = await res.json();
    json = parsed && typeof parsed === "object" ? (parsed as typeof json) : null;
  } catch {
    json = null;
  }
  const data = json?.data ?? null;
  const error = json?.error ?? null;
  if (res.ok) {
    const tiktokError = tiktokResponseError(a.tool_slug, data);
    if (json?.successful === true && tiktokError) return { ok: false, status: res.status, data, ...tiktokError };
    const wrapped = wrappedVendorError(data);
    if (json?.successful === true && wrapped) return { ok: false, status: res.status, data, error: wrapped, outcome_unknown: false };
    if (json?.successful === true) return { ok: true, status: res.status, data, error, outcome_unknown: false };
    const definite = json?.successful === false && error !== null && error !== "";
    return { ok: false, status: res.status, data, error: definite ? error : "composio_ambiguous_response", outcome_unknown: !definite };
  }
  if (res.status >= 500) {
    return { ok: false, status: res.status, data, error: error ?? "composio_ambiguous_response", outcome_unknown: true };
  }
  return { ok: false, status: res.status, data, error, outcome_unknown: false };
}

export type OwnedComposioAccount = {
  readonly tenant_id: string; readonly toolkit: string; readonly connected_account_id: string;
  readonly auth_config_id: string;
  readonly __owned: unique symbol;
};

const PROXY_HOSTS: Record<string, ReadonlySet<string>> = {
  reddit_ads: new Set(["ads-api.reddit.com"]),
  instagram: new Set(["graph.instagram.com", "graph.facebook.com"]),
  youtube: new Set(["www.googleapis.com", "youtube.googleapis.com"]),
  google_analytics: new Set(["analyticsdata.googleapis.com", "analyticsadmin.googleapis.com"]),
  google_search_console: new Set(["searchconsole.googleapis.com", "www.googleapis.com"]),
  googledrive: new Set(["www.googleapis.com", "sheets.googleapis.com"]),
};

export function isProxyEndpointAllowed(toolkit: string, endpoint: string): boolean {
  if (endpoint.startsWith("/") && !endpoint.startsWith("//")) return true;
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  const https = url.protocol === "https:";
  const plain = !url.username && !url.password && !url.port && !url.hash;
  const ownHost = PROXY_HOSTS[toolkit]?.has(url.hostname) ?? false;
  return https && plain && ownHost;
}

const RATE_LIMIT_HEADER = /^(retry-after|x-ratelimit-(remaining|reset|used))$/i;

function rateLimitHeaders(headers: Record<string, unknown> | undefined): { rate_limit?: Record<string, string> } {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (RATE_LIMIT_HEADER.test(key) && typeof value === "string") kept[key.toLowerCase()] = value;
  }
  return Object.keys(kept).length ? { rate_limit: kept } : {};
}

export async function composioProxy(a: {
  account: OwnedComposioAccount; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; endpoint: string; body?: unknown;
  headers?: Record<string, string>;
}, signal?: AbortSignal): Promise<{ ok: boolean; status: number; json: Record<string, unknown>; rate_limit?: Record<string, string>; location?: string }> {
  if (!isProxyEndpointAllowed(a.account.toolkit, a.endpoint)) {
    return { ok: false, status: 0, json: { error: "composio_proxy_endpoint_not_allowed" } };
  }
  try {
    const res = await composioFetch("POST", "/api/v3.1/tools/execute/proxy", {
      connected_account_id: a.account.connected_account_id, method: a.method, endpoint: a.endpoint,
      ...(a.body !== undefined ? { body: a.body } : {}),
      ...(a.headers ? { parameters: Object.entries(a.headers).map(([name, value]) => ({ name, value, type: "header" })) } : {}),
    }, signal);
    const j = (await res.json().catch(() => ({}))) as { status?: number; data?: unknown; error?: { status?: number }; headers?: Record<string, unknown> };
    const rate = rateLimitHeaders(j.headers);
    if (j.error) return { ok: false, status: typeof j.error.status === "number" ? j.error.status : res.status, json: j as Record<string, unknown>, ...rate };
    const status = typeof j.status === "number" ? j.status : res.status;
    const loc = Object.entries(j.headers ?? {}).find(([k]) => k.toLowerCase() === "location")?.[1];
    return {
      ok: res.ok && status < 400, status, json: (j.data ?? {}) as Record<string, unknown>, ...rate,
      ...(typeof loc === "string" && loc ? { location: loc } : {}),
    };
  } catch {
    return { ok: false, status: 0, json: { error: "composio_transport_error" } };
  }
}
