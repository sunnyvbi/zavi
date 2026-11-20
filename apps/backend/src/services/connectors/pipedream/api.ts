
import { z } from "zod";
import {
  getPipedreamCreds,
  PIPEDREAM_API_BASE_URL,
  PIPEDREAM_MCP_BASE_URL,
} from "./creds";
import { getPipedreamAccessToken } from "./token-provider";
import { sanitizeAppSlug } from "./slug";
import { assertStreamableUrlAllowed } from "@/services/mcp/streamable-guards";

const REQUEST_TIMEOUT_MS = 15_000;

type PdFetchOpts = {
  rawBody?: Buffer;
  contentType?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

async function pdFetch(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  opts: PdFetchOpts = {},
): Promise<Response> {
  const creds = getPipedreamCreds();
  const token = await getPipedreamAccessToken();
  const url = `${PIPEDREAM_API_BASE_URL}${path}`;
  assertStreamableUrlAllowed(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const hasBody = opts.rawBody !== undefined || body !== undefined;
  try {
    return await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "x-pd-environment": creds.environment,
        ...(hasBody ? { "Content-Type": opts.contentType ?? "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.rawBody !== undefined ? new Uint8Array(opts.rawBody) : body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      redirect: "manual",
    });
  } finally {
    clearTimeout(timer);
  }
}

const connectTokenSchema = z.object({
  token: z.string().optional(),
  connect_token: z.string().optional(),
  connect_link_url: z.string().url().optional(),
  expires_at: z.string().optional(),
});

export type ConnectTokenResult = {
  connect_token: string;
  connect_link_url: string | null;
  expires_at: string | null;
};

export async function createConnectToken(args: {
  external_user_id: string;
  app_slug: string;
  success_redirect_uri: string;
  error_redirect_uri: string;
}): Promise<ConnectTokenResult> {
  const { projectId } = getPipedreamCreds();
  const res = await pdFetch("POST", `/connect/${encodeURIComponent(projectId)}/tokens`, {
    external_user_id: args.external_user_id,
    allowed_origins: undefined,
    success_redirect_uri: args.success_redirect_uri,
    error_redirect_uri: args.error_redirect_uri,
  });
  if (!res.ok) {
    throw new Error(`pipedream connect-token HTTP ${res.status}`);
  }
  const json = connectTokenSchema.parse(await res.json());
  const token = json.connect_token ?? json.token;
  if (!token) throw new Error("pipedream connect-token: no token in response");
  return {
    connect_token: token,
    connect_link_url: json.connect_link_url ?? null,
    expires_at: json.expires_at ?? null,
  };
}

const accountSchema = z.object({
  id: z.string(),
  app: z.union([z.string(), z.object({ name_slug: z.string().optional() }).passthrough()]).optional(),
  external_user_id: z.string().optional(),
  external_id: z.string().optional(),
  created_at: z.string().optional(),
});
const accountsListSchema = z.union([
  z.array(accountSchema),
  z.object({
    data: z.array(accountSchema).optional(),
    accounts: z.array(accountSchema).optional(),
  }),
]);

function appSlugOf(a: z.infer<typeof accountSchema>): string | undefined {
  if (typeof a.app === "string") return a.app;
  return a.app?.name_slug;
}

export type ConnectedAccount = { id: string; app_slug?: string; created_at?: string };

export async function listConnectedAccounts(args: {
  external_user_id: string;
  app_slug?: string;
}): Promise<ConnectedAccount[]> {
  const { projectId } = getPipedreamCreds();
  const qs = new URLSearchParams({ external_user_id: args.external_user_id });
  if (args.app_slug) qs.set("app", args.app_slug);
  const res = await pdFetch(
    "GET",
    `/connect/${encodeURIComponent(projectId)}/accounts?${qs.toString()}`,
  );
  if (!res.ok) throw new Error(`pipedream accounts-list HTTP ${res.status}`);
  const json = accountsListSchema.parse(await res.json());
  const items = Array.isArray(json) ? json : (json.data ?? json.accounts ?? []);

  return items
    .filter((a) => {
      const owner = a.external_user_id ?? a.external_id;
      if (owner !== undefined && owner !== args.external_user_id) return false;
      const slug = appSlugOf(a);
      if (args.app_slug && slug !== undefined && slug !== args.app_slug) return false;
      return true;
    })
    .map((a) => ({ id: a.id, app_slug: appSlugOf(a), created_at: a.created_at }));
}

export async function verifyAccountOwned(args: {
  external_user_id: string;
  app_slug: string;
  account_id: string;
}): Promise<boolean> {
  const accounts = await listConnectedAccounts({
    external_user_id: args.external_user_id,
    app_slug: args.app_slug,
  });
  return accounts.some((a) => a.id === args.account_id);
}

export type AccountResolution =
  | { status: "ok"; account: ConnectedAccount }
  | { status: "none" }
  | { status: "ambiguous"; count: number };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function resolveConnectedAccount(args: {
  external_user_id: string;
  app_slug: string;
  attempts?: number;
  delayMs?: number;
}): Promise<AccountResolution> {
  const attempts = args.attempts ?? 3;
  const delayMs = args.delayMs ?? 700;

  let accounts: ConnectedAccount[] = [];
  for (let i = 0; i < attempts; i++) {
    accounts = await listConnectedAccounts({
      external_user_id: args.external_user_id,
      app_slug: args.app_slug,
    });
    if (accounts.length > 0) break;
    if (i < attempts - 1) await sleep(delayMs);
  }

  if (accounts.length === 0) return { status: "none" };
  if (accounts.length === 1) return { status: "ok", account: accounts[0] };

  const stamped = accounts
    .map((a) => ({ a, t: Date.parse(a.created_at ?? "") }))
    .filter((x) => !Number.isNaN(x.t));
  if (stamped.length === 0) return { status: "ambiguous", count: accounts.length };

  const max = Math.max(...stamped.map((x) => x.t));
  const newest = stamped.filter((x) => x.t === max);
  if (newest.length !== 1) return { status: "ambiguous", count: accounts.length };
  return { status: "ok", account: newest[0].a };
}

export async function deleteConnectedAccount(account_id: string): Promise<void> {
  const { projectId } = getPipedreamCreds();
  const res = await pdFetch(
    "DELETE",
    `/connect/${encodeURIComponent(projectId)}/accounts/${encodeURIComponent(account_id)}`,
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`pipedream account-delete HTTP ${res.status}`);
  }
}

const appSchema = z.object({
  name_slug: z.string(),
  name: z.string().nullish(),
  auth_type: z.string().nullish(),
  img_src: z.string().nullish(),
  description: z.string().nullish(),
  categories: z.array(z.string()).nullish(),
  custom_fields_json: z.unknown().optional(),
});
const appsListSchema = z.object({
  data: z.array(z.unknown()).optional(),
  apps: z.array(z.unknown()).optional(),
  page_info: z.object({ end_cursor: z.string().nullish() }).partial().optional(),
});

export type CatalogApp = {
  slug: string;
  name: string;
  auth_type: string | null;
  needs_setup: boolean;
  img_src: string | null;
  description: string | null;
  categories: string[];
};

export async function listApps(args: {
  q?: string;
  cursor?: string;
  limit?: number;
}): Promise<{ apps: CatalogApp[]; next_cursor: string | null }> {
  const qs = new URLSearchParams();
  if (args.q) qs.set("q", args.q);
  if (args.cursor) qs.set("after", args.cursor);
  if (args.limit) qs.set("limit", String(Math.max(1, Math.min(100, Math.trunc(args.limit)))));
  const res = await pdFetch("GET", `/apps${qs.toString() ? `?${qs.toString()}` : ""}`);
  if (!res.ok) throw new Error(`pipedream apps-list HTTP ${res.status}`);
  const json = appsListSchema.parse(await res.json());
  const items = json.data ?? json.apps ?? [];
  const apps: CatalogApp[] = [];
  for (const raw of items) {
    const app = toCatalogApp(raw);
    if (app) apps.push(app);
  }
  const exact = args.q && !args.cursor ? sanitizeAppSlug(args.q.replace(/[\s-]+/g, "_")) : null;
  if (exact && !apps.some((a) => a.slug === exact)) {
    const hit = await getApp(exact).catch(() => null);
    if (hit) apps.unshift(hit);
  }
  return { apps, next_cursor: json.page_info?.end_cursor ?? null };
}

function toCatalogApp(raw: unknown): CatalogApp | null {
  const parsed = appSchema.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data;
  return {
    slug: a.name_slug,
    name: a.name ?? a.name_slug,
    auth_type: a.auth_type ?? null,
    img_src: a.img_src ?? null,
    description: a.description ?? null,
    categories: a.categories ?? [],
    needs_setup: a.auth_type === "custom_oauth" || a.auth_type === "oauth_byo",
  };
}

export async function appExists(slug: string): Promise<boolean> {
  return (await getAppName(slug)) !== null;
}

export async function getAppName(slug: string): Promise<string | null> {
  return (await getApp(slug))?.name ?? null;
}

export async function getApp(slug: string): Promise<CatalogApp | null> {
  const res = await pdFetch("GET", `/apps/${encodeURIComponent(slug)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`pipedream app lookup HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { name_slug?: unknown; name?: unknown } };
  if (json.data?.name_slug !== slug) return null;
  const name = typeof json.data.name === "string" && json.data.name ? json.data.name : slug;
  return (
    toCatalogApp(json.data) ?? {
      slug,
      name,
      auth_type: null,
      needs_setup: false,
      img_src: null,
      description: null,
      categories: [],
    }
  );
}

const runActionResponseSchema = z.unknown();

const AUTH_SLOT_OVERRIDES: Readonly<Record<string, string>> = {
  twitter: "app",
  instagram_business: "instagram",
  youtube_data_api: "youtubeDataApi",
};

export function authSlotFor(app_slug: string): string {
  return AUTH_SLOT_OVERRIDES[app_slug] ?? app_slug;
}

export async function runAction(args: {
  external_user_id: string;
  app_slug: string;
  account_id: string;
  action_id: string;
  configured_props: Record<string, unknown>;
}): Promise<{ ok: boolean; raw: unknown; status: number }> {
  const owned = await verifyAccountOwned({
    external_user_id: args.external_user_id,
    app_slug: args.app_slug,
    account_id: args.account_id,
  });
  if (!owned) throw new Error("pipedream runAction: account not owned by tenant");

  const { projectId } = getPipedreamCreds();
  const res = await pdFetch(
    "POST",
    `/connect/${encodeURIComponent(projectId)}/actions/run`,
    {
      external_user_id: args.external_user_id,
      id: args.action_id,
      configured_props: {
        [authSlotFor(args.app_slug)]: { authProvisionId: args.account_id },
        ...args.configured_props,
      },
    },
  );
  const raw = runActionResponseSchema.parse(await res.json());
  return { ok: res.ok, raw, status: res.status };
}

export function buildPipedreamMcpUrl(): string {
  return PIPEDREAM_MCP_BASE_URL;
}

export type ProxyResponse = {
  ok: boolean;
  status: number;
  json: Record<string, unknown>;
  headers: Record<string, string>;
};

export async function proxyRequest(args: {
  external_user_id: string;
  app_slug: string;
  account_id: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  body?: unknown;
  rawBody?: Buffer;
  contentType?: string;
  upstreamHeaders?: Record<string, string>;
  timeoutMs?: number;
}): Promise<ProxyResponse> {
  const owned = await verifyAccountOwned({
    external_user_id: args.external_user_id,
    app_slug: args.app_slug,
    account_id: args.account_id,
  });
  if (!owned) throw new Error("pipedream proxy: account not owned by tenant");
  const { projectId } = getPipedreamCreds();
  const encoded = Buffer.from(args.url, "utf-8").toString("base64url");
  const qs = new URLSearchParams({ external_user_id: args.external_user_id, account_id: args.account_id });
  const forwarded: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.upstreamHeaders ?? {})) forwarded[`x-pd-proxy-${k}`] = v;
  const res = await pdFetch(
    args.method,
    `/connect/${encodeURIComponent(projectId)}/proxy/${encoded}?${qs.toString()}`,
    args.body,
    { rawBody: args.rawBody, contentType: args.contentType, headers: forwarded, timeoutMs: args.timeoutMs },
  );
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  let json: Record<string, unknown> = {};
  try {
    const text = await res.text();
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  return { ok: res.ok, status: res.status, json, headers };
}
