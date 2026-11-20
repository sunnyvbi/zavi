
import { SiteCredentialsMissing } from "./contract";

export const SUPABASE_MGMT_BASE = "https://api.supabase.com";
export const DEFAULT_SITE_REGION = "us-west-1";

export type MgmtResponse = { status: number; text(): Promise<string> };
export type MgmtFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<MgmtResponse>;

export const MGMT_REQUEST_TIMEOUT_MS = 330_000;

export type SupabaseMgmtConfig = { token: string; orgId: string; region: string };

export function supabaseMgmtConfig(env: Record<string, string | undefined> = process.env): SupabaseMgmtConfig {
  const token = (env.SUPABASE_MGMT_TOKEN ?? "").trim();
  const orgId = (env.SUPABASE_ORG_ID ?? "").trim();
  const missing: string[] = [];
  if (!token) missing.push("SUPABASE_MGMT_TOKEN");
  if (!orgId) missing.push("SUPABASE_ORG_ID");
  if (missing.length) throw new SiteCredentialsMissing(missing);
  const region = (env.SUPABASE_SITE_REGION ?? "").trim() || DEFAULT_SITE_REGION;
  return { token, orgId, region };
}

export class SupabaseMgmtError extends Error {
  constructor(public op: string, public status: number, detail?: string) {
    super(`supabase ${op} failed (${status || "network"})${detail ? `: ${detail}` : ""}`);
    this.name = "SupabaseMgmtError";
  }
}

export class SiteSqlError extends Error {
  constructor(public sqlMessage: string) {
    super(`site SQL failed: ${sqlMessage}`);
    this.name = "SiteSqlError";
  }
}

const REF_RE = /^[a-z0-9]{8,40}$/;
export function assertProjectRef(ref: string): string {
  if (typeof ref !== "string" || !REF_RE.test(ref)) throw new Error("invalid supabase project ref");
  return ref;
}

export function projectUrl(ref: string): string {
  return `https://${assertProjectRef(ref)}.supabase.co`;
}

export function redactSqlMessage(raw: string): string {
  return String(raw ?? "")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\b(sb_(?:secret|publishable)_[A-Za-z0-9_-]{8,})/g, "[redacted]")
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export class SiteDeleteRefused extends Error {
  constructor(public reason: "name_mismatch" | "wrong_org" | "not_found") {
    super(`supabase project delete refused (${reason})`);
    this.name = "SiteDeleteRefused";
  }
}

export type MgmtProject = { ref: string; name: string; organization_id: string; status: string; region?: string };

export type SiteAuthUser = { id: string; email: string | null };

export interface SiteAuthAdmin {
  createUser(email: string): Promise<{ user: SiteAuthUser } | { exists: true }>;
  listUsers(page: number, perPage: number): Promise<SiteAuthUser[]>;
  generateMagicLink(email: string, redirectTo: string): Promise<string>;
}

export interface SupabaseMgmt {
  readonly orgId: string;
  createProject(input: { name: string; dbPass: string }): Promise<MgmtProject>;
  getProject(ref: string): Promise<MgmtProject | null>;
  listProjectsByName(name: string): Promise<MgmtProject[]>;
  isHealthy(ref: string): Promise<boolean>;
  apiKeys(ref: string): Promise<{ anon: string; service_role: string }>;
  query(ref: string, sql: string): Promise<unknown[]>;
  pause(ref: string): Promise<"ok" | "not_found" | "unsupported">;
  restore(ref: string): Promise<"ok" | "not_found">;
  deleteSiteProject(
    ref: string,
    expectedName: string,
    beforeDelete?: () => Promise<void>,
  ): Promise<"ok" | "not_found">;
  updateAuthConfig(ref: string, cfg: { site_url: string; uri_allow_list: string }): Promise<void>;
  authAdmin(ref: string, serviceRoleKey: string): SiteAuthAdmin;
}

export type SupabaseMgmtDeps = {
  fetchFn?: MgmtFetch;
  env?: Record<string, string | undefined>;
  config?: SupabaseMgmtConfig;
  timeoutMs?: number;
};

const PAUSE_REFUSAL_STATUSES = new Set([400, 402, 403, 409, 422]);

export function isPauseUnsupported(body: string): boolean {
  const parsed = parseJson(body) as { message?: unknown; error?: unknown; msg?: unknown } | null;
  const text = [parsed?.message, parsed?.error, parsed?.msg].find((v) => typeof v === "string") ?? body;
  return /cannot be paused|can ?not pause|pausing is not (allowed|supported|available)|paid plan|plan (does not|doesn't) (allow|support)|not free[- ]?tier|downgrade it to (the )?free/i.test(
    String(text).slice(0, 2000),
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toProject(raw: unknown): MgmtProject | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ref = String(r.id ?? r.ref ?? "");
  if (!REF_RE.test(ref)) return null;
  return {
    ref,
    name: String(r.name ?? ""),
    organization_id: String(r.organization_id ?? r.organization_slug ?? ""),
    status: String(r.status ?? ""),
    ...(typeof r.region === "string" && r.region ? { region: r.region } : {}),
  };
}

const ok2xx = (s: number) => s >= 200 && s < 300;

export function createSupabaseMgmt(deps: SupabaseMgmtDeps = {}): SupabaseMgmt {
  const cfg = deps.config ?? supabaseMgmtConfig(deps.env ?? process.env);
  const fetchFn: MgmtFetch = deps.fetchFn ?? ((url, init) => fetch(url, init as RequestInit) as unknown as Promise<MgmtResponse>);

  const headers = (extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${cfg.token}`,
    Accept: "application/json",
    ...extra,
  });

  async function call(op: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<MgmtResponse> {
    let res: MgmtResponse;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctl.abort();
        reject(new Error("timeout"));
      }, deps.timeoutMs ?? MGMT_REQUEST_TIMEOUT_MS);
    });
    try {
      res = await Promise.race([
        fetchFn(`${SUPABASE_MGMT_BASE}${path}`, {
          method: init.method ?? "GET",
          headers: headers(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: ctl.signal,
        }),
        timeout,
      ]);
    } catch {
      throw new SupabaseMgmtError(op, 0);
    } finally {
      clearTimeout(timer);
    }
    return res;
  }

  async function json(op: string, res: MgmtResponse): Promise<unknown> {
    if (!ok2xx(res.status)) throw new SupabaseMgmtError(op, res.status);
    return parseJson(await res.text().catch(() => ""));
  }

  async function lifecycle(op: string, method: string, path: string): Promise<"ok" | "not_found"> {
    const res = await call(op, path, { method });
    if (res.status === 404) return "not_found";
    if (!ok2xx(res.status)) throw new SupabaseMgmtError(op, res.status);
    return "ok";
  }

  async function getProject(ref: string): Promise<MgmtProject | null> {
    const res = await call("get project", `/v1/projects/${assertProjectRef(ref)}`);
    if (res.status === 404) return null;
    return toProject(await json("get project", res));
  }

  return {
    orgId: cfg.orgId,

    async createProject({ name, dbPass }) {
      const res = await call("create project", "/v1/projects", {
        method: "POST",
        body: { name, organization_id: cfg.orgId, db_pass: dbPass, region: cfg.region },
      });
      const p = toProject(await json("create project", res));
      if (!p) throw new SupabaseMgmtError("create project", res.status);
      return p;
    },

    getProject,

    async listProjectsByName(name) {
      const res = await call("list projects", "/v1/projects");
      const data = await json("list projects", res);
      const rows = Array.isArray(data) ? data : [];
      return rows
        .map(toProject)
        .filter((p): p is MgmtProject => !!p && p.name === name && p.organization_id === cfg.orgId);
    },

    async isHealthy(ref) {
      const p = await getProject(ref);
      if (!p || p.status !== "ACTIVE_HEALTHY") return false;
      const res = await call("project health", `/v1/projects/${assertProjectRef(ref)}/health?services=auth&services=db&services=rest`);
      if (!ok2xx(res.status)) return false;
      const data = parseJson(await res.text().catch(() => ""));
      if (!Array.isArray(data) || data.length === 0) return false;
      return data.every((s) => (s as { healthy?: unknown })?.healthy === true);
    },

    async apiKeys(ref) {
      const res = await call("api keys", `/v1/projects/${assertProjectRef(ref)}/api-keys?reveal=true`);
      const data = await json("api keys", res);
      const rows = (Array.isArray(data) ? data : []) as Array<{ name?: string; api_key?: string }>;
      const anon = rows.find((k) => k?.name === "anon")?.api_key;
      const service_role = rows.find((k) => k?.name === "service_role")?.api_key;
      if (!anon || !service_role) throw new SupabaseMgmtError("api keys", res.status);
      return { anon, service_role };
    },

    async query(ref, sql) {
      const res = await call("database query", `/v1/projects/${assertProjectRef(ref)}/database/query`, {
        method: "POST",
        body: { query: sql },
      });
      if (res.status >= 400 && res.status < 500) {
        if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 408 || res.status === 429) {
          throw new SupabaseMgmtError("database query", res.status);
        }
        const body = parseJson(await res.text().catch(() => "")) as { message?: unknown } | null;
        const msg = typeof body?.message === "string" ? body.message : "query rejected";
        throw new SiteSqlError(redactSqlMessage(msg));
      }
      const data = await json("database query", res);
      return Array.isArray(data) ? data : [];
    },

    async pause(ref) {
      const res = await call("pause project", `/v1/projects/${assertProjectRef(ref)}/pause`, { method: "POST" });
      if (res.status === 404) return "not_found";
      if (ok2xx(res.status)) return "ok";
      if (PAUSE_REFUSAL_STATUSES.has(res.status) && isPauseUnsupported(await res.text().catch(() => ""))) return "unsupported";
      throw new SupabaseMgmtError("pause project", res.status);
    },

    restore(ref) {
      return lifecycle("restore project", "POST", `/v1/projects/${assertProjectRef(ref)}/restore`);
    },

    async deleteSiteProject(ref, expectedName, beforeDelete) {
      assertProjectRef(ref);
      if (typeof expectedName !== "string" || !expectedName.startsWith("zs-")) throw new SiteDeleteRefused("name_mismatch");
      const p = await getProject(ref);
      if (!p) throw new SiteDeleteRefused("not_found");
      if (p.ref !== ref || p.name !== expectedName) throw new SiteDeleteRefused("name_mismatch");
      if (!cfg.orgId || p.organization_id !== cfg.orgId) throw new SiteDeleteRefused("wrong_org");
      if (beforeDelete) await beforeDelete();
      return lifecycle("delete project", "DELETE", `/v1/projects/${ref}`);
    },

    async updateAuthConfig(ref, { site_url, uri_allow_list }) {
      const res = await call("auth config", `/v1/projects/${assertProjectRef(ref)}/config/auth`, {
        method: "PATCH",
        body: { site_url, uri_allow_list },
      });
      if (!ok2xx(res.status)) throw new SupabaseMgmtError("auth config", res.status);
    },

    authAdmin(ref, serviceRoleKey) {
      const base = `${projectUrl(ref)}/auth/v1/admin`;
      const h = (json: boolean) => ({
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Accept: "application/json",
        ...(json ? { "Content-Type": "application/json" } : {}),
      });
      async function authCall(op: string, url: string, method: string, body?: unknown): Promise<MgmtResponse> {
        try {
          return await fetchFn(url, {
            method,
            headers: h(body !== undefined),
            body: body !== undefined ? JSON.stringify(body) : undefined,
          });
        } catch {
          throw new SupabaseMgmtError(op, 0);
        }
      }
      const toUser = (raw: unknown): SiteAuthUser | null => {
        const r = (raw ?? {}) as { id?: unknown; email?: unknown };
        return typeof r.id === "string" ? { id: r.id, email: typeof r.email === "string" ? r.email : null } : null;
      };

      return {
        async createUser(email) {
          const res = await authCall("auth create user", `${base}/users`, "POST", { email, email_confirm: true });
          if (ok2xx(res.status)) {
            const user = toUser(parseJson(await res.text().catch(() => "")));
            if (!user) throw new SupabaseMgmtError("auth create user", res.status);
            return { user };
          }
          if (res.status === 422 || res.status === 400 || res.status === 409) {
            const body = parseJson(await res.text().catch(() => "")) as
              | { error_code?: unknown; code?: unknown; msg?: unknown; message?: unknown }
              | null;
            const code = String(body?.error_code ?? body?.code ?? "");
            const msg = String(body?.msg ?? body?.message ?? "");
            if (code === "email_exists" || code === "user_already_exists" || /already (been )?registered/i.test(msg)) {
              return { exists: true };
            }
          }
          throw new SupabaseMgmtError("auth create user", res.status);
        },

        async listUsers(page, perPage) {
          const p = Math.max(1, Math.floor(page));
          const n = Math.max(1, Math.min(1000, Math.floor(perPage)));
          const res = await authCall("auth list users", `${base}/users?page=${p}&per_page=${n}`, "GET");
          if (!ok2xx(res.status)) throw new SupabaseMgmtError("auth list users", res.status);
          const data = parseJson(await res.text().catch(() => "")) as { users?: unknown[] } | unknown[] | null;
          const rows = Array.isArray(data) ? data : Array.isArray(data?.users) ? data.users : [];
          return rows.map(toUser).filter((u): u is SiteAuthUser => !!u);
        },

        async generateMagicLink(email, redirectTo) {
          const res = await authCall("auth generate link", `${base}/generate_link`, "POST", {
            type: "magiclink",
            email,
            redirect_to: redirectTo,
          });
          if (!ok2xx(res.status)) throw new SupabaseMgmtError("auth generate link", res.status);
          const body = parseJson(await res.text().catch(() => "")) as
            | { action_link?: unknown; properties?: { action_link?: unknown } }
            | null;
          const link = body?.action_link ?? body?.properties?.action_link;
          if (typeof link !== "string" || !/^https:\/\//.test(link)) {
            throw new SupabaseMgmtError("auth generate link", res.status);
          }
          return link;
        },
      };
    },
  };
}
