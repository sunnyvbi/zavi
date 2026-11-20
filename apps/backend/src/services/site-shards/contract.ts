
export type ShardEnv = "prod" | "dev";
export type ShardState = "provisioning" | "open" | "full" | "draining" | "retired";
export type BackendMode = "static" | "pooled" | "dedicated";
export type ShardPurpose = "pool" | "validation";

export type ShardRow = {
  id: string;
  env: ShardEnv;
  name: string;
  project_ref: string | null;
  url: string | null;
  region: string;
  state: ShardState;
  is_canary: boolean;
  schema_version: string | null;
  provision_step: string | null;
  max_sites: number;
  site_count: number;
  created_at: string;
  dedicated_site_id?: string | null;
  purpose?: ShardPurpose;
};

export type ShardMetrics = Partial<{
  records: number;
  bytes: number;
  requests_per_min: number;
  p95_ms: number;
  cpu_pct: number;
  connections: number;
  auth_users: number;
  sessions: number;
  emails_per_hour: number;
}>;

export const SHARD_NAME_RE = /^zavi-shard-(prod|dev)-[0-9]{1,6}$/;
export const shardName = (env: ShardEnv, n: number) => `zavi-shard-${env}-${n}`;

export const PROVISION_DONE = "done";

export const REQUIRED_SHARD_SCHEMA = "0005_contracts_archive_reindex";

export type CollectionDef = {
  name: string;
  kind: "records" | "files";
  rules: Record<string, string[]>;
  schema: Record<string, unknown>;
  fields: Record<string, unknown>;
  indexes: Record<string, unknown>;
  archived?: boolean;
  recipient?: { reference: string } | null;
  unique?: Array<{ fields: string[]; nulls: "distinct" | "not_distinct" }>;
  states?: CollectionStates | null;
  references?: Record<string, { collection: string; on_delete: "restrict" | "cascade" | "nullify" }>;
};

export type Principal = string;
export type CollectionStates = {
  field: string;
  values: string[];
  initial: string;
  read?: Record<string, Principal[]>;
  transitions: Array<{ from: string; to: string; principals: Principal[] }>;
};

export type ActionDef = {
  target: { collection: string; counter: string };
  delta: number;
  initial: number;
  bounds: { min: number; max: number } | { min: number; maxField: string };
  creates: { collection: string; targetField: string };
  principals: Principal[];
  idempotency: "required";
  inverse?: {
    name: string;
    delta: number;
    transition: { from: string; to: string };
    principals: Principal[];
    idempotency: "required";
  };
};

export type AggregateDef = {
  collection: string;
  fn: "count" | "sum" | "avg";
  field?: string;
  filters?: string[];
  principals: Principal[];
};

export type SiteContractDef = {
  schema_version: 1 | 2;
  roles: string[];
  capabilities: string[];
  actions: Record<string, ActionDef>;
  aggregates: Record<string, AggregateDef>;
};

export const EMPTY_SITE_CONTRACT: SiteContractDef = { schema_version: 1, roles: [], capabilities: [], actions: {}, aggregates: {} };

export type ManifestValidation =
  | { ok: true; value: unknown; hash: string }
  | { ok: false; issues?: Array<{ path?: string; message?: string }>; errors?: string[] };

export interface SiteManifestPackage {
  validateManifest(raw: unknown): ManifestValidation;
  diffManifest(prev: unknown | null, next: unknown): unknown[];
  shardCollectionRow?: (name: string, c: unknown) => {
    name: string; kind: "records" | "files"; rules: unknown; schema: unknown; fields: unknown; indexes: unknown;
    recipient: unknown; uniques: unknown; states: unknown; references: unknown;
  };
  siteContractRow?: (m: unknown) => { schema_version: 1 | 2; roles: unknown; capabilities: unknown; actions: unknown; aggregates: unknown };
}

export const V2_SHARD_SCHEMA = "0008_relational_api";

export type ShardHandle = { id: string; project_ref: string; url: string };

export interface PooledSiteAuth {
  ensureFounderAdmin(input: { shard: ShardHandle; site_id: string; email: string }): Promise<{ user_id: string }>;
  ownerMagicLink(input: { shard: ShardHandle; site_id: string; email: string; redirect_to: string }): Promise<string>;
  deleteAuthUser(input: { shard: ShardHandle; auth_user_id: string }): Promise<void>;
  ensureCustomer?(input: { shard: ShardHandle; site_id: string; email: string; admin_email: string }): Promise<{ user_id: string }>;
  customerMagicLink?(input: { shard: ShardHandle; site_id: string; email: string; redirect_to: string }): Promise<string>;
}

export type ShardAuthHooks = Record<string, unknown>;

export type ShardSecretName = "service_key" | "anon_key" | "broker_db_url" | "hook_secret";

export type BindingStatus = "active" | "paused" | "tombstoned";
export type GatewayBinding = {
  v: 1;
  site_id: string;
  shard_id: string;
  shard_url: string;
  status: BindingStatus;
  binding_version: number;
  manifest_hash: string;
  tombstoned_at?: string;
};
export const shardKvKey = (project_ref: string) => `shard:${project_ref}`;

export interface ShardSql {
  query(project_ref: string, sql: string): Promise<unknown[]>;
}

export interface ShardStorage {
  list(shard: ShardHandle, prefix: string): Promise<string[]>;
  remove(shard: ShardHandle, names: string[]): Promise<void>;
}

export const SITE_FILES_BUCKET = "site-files";

export class NoShardCapacity extends Error {
  constructor(env: string) {
    super(`no shard capacity in ${env}`);
    this.name = "NoShardCapacity";
  }
}

export function isSiteDatabaseCapacityError(e: unknown): boolean {
  if (e instanceof NoShardCapacity) return true;
  const err = e as { name?: unknown; capacity?: unknown } | null | undefined;
  if (!err || typeof err !== "object") return false;
  if (err.name === "NoShardCapacity") return true;
  return err.name === "TestSiteUnavailable" && err.capacity === true;
}
