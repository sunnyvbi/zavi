
import {
  SUPABASE_MGMT_BASE,
  SupabaseMgmtError,
  assertProjectRef,
  createSupabaseMgmt,
  supabaseMgmtConfig,
  type MgmtFetch,
  type MgmtProject,
  type SupabaseMgmt,
} from "@/services/sites/supabase-mgmt";
import { assertPoolerHost } from "./broker-db-url";

export type SigningKey = { id: string; kid: string | null; algorithm: string; status: string };

export interface ShardMgmt {
  readonly orgId: string;
  createProject(input: { name: string; dbPass: string; region: string }): Promise<MgmtProject>;
  apiKeys(ref: string): Promise<{ anon: string; service_role: string }>;
  listProjectsByName(name: string): Promise<MgmtProject[]>;
  isHealthy(ref: string): Promise<boolean>;
  query(ref: string, sql: string): Promise<unknown[]>;
  getExposedSchemas(ref: string): Promise<string>;
  setExposedSchemas(ref: string, schemas: string): Promise<void>;
  getAuthConfig(ref: string): Promise<Record<string, unknown>>;
  patchAuthConfig(ref: string, patch: Record<string, unknown>): Promise<void>;
  listSigningKeys(ref: string): Promise<SigningKey[]>;
  importSigningKey(ref: string, input: { private_jwk: Record<string, unknown>; status: "standby" | "in_use" }): Promise<SigningKey>;
  setSigningKeyStatus(ref: string, id: string, status: "standby" | "in_use" | "previously_used" | "revoked"): Promise<void>;
  publishableKey(ref: string): Promise<string>;
  poolerHost(ref: string): Promise<string>;
}

const ok2xx = (s: number) => s >= 200 && s < 300;
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sentStrings(v: unknown, out: Set<string>, seen: Set<object>): Set<string> {
  if (typeof v === "string") {
    if (v.length >= 8) out.add(v);
  } else if (v && typeof v === "object" && !seen.has(v)) {
    seen.add(v);
    for (const x of Object.values(v)) sentStrings(x, out, seen);
  }
  return out;
}

function refusalDetail(text: string, sent: unknown): string | undefined {
  const msg = (parse(text) as { message?: unknown } | null)?.message;
  if (typeof msg !== "string") return undefined;
  const secrets = sentStrings(sent, new Set(), new Set());
  const d = (sent as { private_jwk?: { d?: unknown } } | null)?.private_jwk?.d;
  if (typeof d === "string" && d) secrets.add(d);
  let out = msg;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join("[redacted]");
  out = out.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return out.slice(0, 200) || undefined;
}

function toKey(raw: unknown): SigningKey | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.id !== "string" || !KEY_ID_RE.test(r.id)) return null;
  const jwk = (r.public_jwk ?? {}) as Record<string, unknown>;
  return {
    id: r.id,
    kid: typeof jwk.kid === "string" ? jwk.kid : typeof r.kid === "string" ? r.kid : null,
    algorithm: String(r.algorithm ?? ""),
    status: String(r.status ?? ""),
  };
}

export const ZAVI_PLATFORM_REFS: readonly string[] = Object.freeze(["wmycgyjsenvgtczlupoe", "dgzgwclslzzzrjopbobp"]);

export function platformRefs(env: Record<string, string | undefined> = process.env): Set<string> {
  const out = new Set(ZAVI_PLATFORM_REFS);
  try {
    const host = new URL(String(env.SUPABASE_URL ?? "")).hostname;
    const m = /^([a-z0-9]{20})\.supabase\.co$/.exec(host);
    if (m) out.add(m[1]);
  } catch {
  }
  return out;
}

export function assertNotPlatformRef(ref: string, env: Record<string, string | undefined> = process.env): string {
  if (platformRefs(env).has(String(ref ?? "").trim())) throw new Error("refusing a shard operation on Zavi's own Supabase project");
  return ref;
}

const REF_METHODS = [
  "apiKeys", "isHealthy", "query", "getExposedSchemas", "setExposedSchemas", "getAuthConfig", "patchAuthConfig",
  "listSigningKeys", "importSigningKey", "publishableKey", "setSigningKeyStatus", "poolerHost",
] as const;

function guardPlatform(m: ShardMgmt, env: Record<string, string | undefined>): ShardMgmt {
  const g = { ...m } as Record<string, unknown>;
  for (const k of REF_METHODS) {
    const fn = (m as unknown as Record<string, (...a: unknown[]) => unknown>)[k].bind(m);
    g[k] = async (ref: string, ...rest: unknown[]) => {
      assertNotPlatformRef(ref, env);
      return fn(ref, ...rest);
    };
  }
  g.listProjectsByName = async (name: string) => {
    const found = await m.listProjectsByName(name);
    for (const p of found) assertNotPlatformRef(p.ref, env);
    return found;
  };
  g.createProject = async (input: { name: string; dbPass: string; region: string }) => {
    const p = await m.createProject(input);
    assertNotPlatformRef(p.ref, env);
    return p;
  };
  return Object.freeze(g) as unknown as ShardMgmt;
}

export function createShardMgmt(deps: { fetchFn?: MgmtFetch; env?: Record<string, string | undefined>; base?: SupabaseMgmt } = {}): ShardMgmt {
  return guardPlatform(createRawShardMgmt(deps), deps.env ?? process.env);
}

function createRawShardMgmt(deps: { fetchFn?: MgmtFetch; env?: Record<string, string | undefined>; base?: SupabaseMgmt }): ShardMgmt {
  const cfg = supabaseMgmtConfig(deps.env ?? process.env);
  const base = deps.base ?? createSupabaseMgmt({ config: cfg, fetchFn: deps.fetchFn });
  const fetchFn: MgmtFetch = deps.fetchFn ?? ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<MgmtFetch>);

  async function call(op: string, path: string, method = "GET", body?: unknown): Promise<unknown> {
    let res;
    try {
      res = await fetchFn(`${SUPABASE_MGMT_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new SupabaseMgmtError(op, 0);
    }
    if (!ok2xx(res.status)) throw new SupabaseMgmtError(op, res.status, refusalDetail(await res.text().catch(() => ""), body));
    return parse(await res.text().catch(() => ""));
  }

  return {
    orgId: base.orgId,
    async createProject({ name, dbPass, region }) {
      if (!/^[a-z]{2}-[a-z]+-[0-9]$/.test(region)) throw new Error("invalid region");
      const d = (await call("create project", "/v1/projects", "POST", {
        name,
        organization_id: cfg.orgId,
        db_pass: dbPass,
        region,
      })) as Record<string, unknown> | null;
      const ref = String(d?.id ?? d?.ref ?? "");
      if (!/^[a-z0-9]{8,40}$/.test(ref)) throw new SupabaseMgmtError("create project", 200);
      if (d?.region !== undefined && d.region !== region) throw new Error(`project created in ${String(d.region)}, not ${region}`);
      return { ref, name: String(d?.name ?? name), organization_id: String(d?.organization_id ?? cfg.orgId), status: String(d?.status ?? "") };
    },
    apiKeys: (r) => base.apiKeys(r),
    listProjectsByName: (n) => base.listProjectsByName(n),
    isHealthy: (r) => base.isHealthy(r),
    query: (r, sql) => base.query(r, sql),

    async getExposedSchemas(ref) {
      const d = (await call("postgrest config", `/v1/projects/${assertProjectRef(ref)}/postgrest`)) as { db_schema?: unknown } | null;
      return typeof d?.db_schema === "string" ? d.db_schema : "";
    },
    async setExposedSchemas(ref, schemas) {
      await call("postgrest config", `/v1/projects/${assertProjectRef(ref)}/postgrest`, "PATCH", { db_schema: schemas });
    },
    async getAuthConfig(ref) {
      const d = await call("auth config", `/v1/projects/${assertProjectRef(ref)}/config/auth`);
      return d && typeof d === "object" ? (d as Record<string, unknown>) : {};
    },
    async patchAuthConfig(ref, patch) {
      await call("auth config", `/v1/projects/${assertProjectRef(ref)}/config/auth`, "PATCH", patch);
    },
    async listSigningKeys(ref) {
      const d = (await call("signing keys", `/v1/projects/${assertProjectRef(ref)}/config/auth/signing-keys`)) as
        | { keys?: unknown[] }
        | unknown[]
        | null;
      const list = Array.isArray(d) ? d : Array.isArray(d?.keys) ? d.keys : [];
      return list.map(toKey).filter((k): k is SigningKey => !!k);
    },
    async importSigningKey(ref, { private_jwk, status }) {
      const d = await call("signing key import", `/v1/projects/${assertProjectRef(ref)}/config/auth/signing-keys`, "POST", {
        algorithm: "ES256",
        private_jwk,
        status,
      });
      const k = toKey(d);
      if (!k) throw new SupabaseMgmtError("signing key import", 200);
      return k;
    },
    async publishableKey(ref) {
      const d = await call("api keys", `/v1/projects/${assertProjectRef(ref)}/api-keys?reveal=true`);
      const rows = (Array.isArray(d) ? d : []) as Array<{ type?: unknown; api_key?: unknown }>;
      const k = rows.find((r) => r?.type === "publishable" && typeof r.api_key === "string" && r.api_key.startsWith("sb_publishable_"));
      if (!k) throw new SupabaseMgmtError("api keys (no publishable key)", 200);
      return k.api_key as string;
    },
    async poolerHost(ref) {
      const d = await call("pooler config", `/v1/projects/${assertProjectRef(ref)}/config/database/pooler`);
      const rows = (Array.isArray(d) ? d : []) as Array<{ database_type?: unknown; db_host?: unknown }>;
      const primary = rows.find((r) => r?.database_type === "PRIMARY");
      if (!primary) throw new SupabaseMgmtError("pooler config (no primary pooler)", 200);
      try {
        return assertPoolerHost(primary.db_host);
      } catch {
        throw new SupabaseMgmtError("pooler config (not a shared pooler host)", 200);
      }
    },
    async setSigningKeyStatus(ref, id, status) {
      if (!KEY_ID_RE.test(id)) throw new Error("invalid signing key id");
      await call("signing key status", `/v1/projects/${assertProjectRef(ref)}/config/auth/signing-keys/${id}`, "PATCH", { status });
    },
  };
}
