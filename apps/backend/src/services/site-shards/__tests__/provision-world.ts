import { signerSecretName, type ProvisionDeps } from "../provision";
import type { ShardRow } from "../contract";
import type { ShardMgmt, SigningKey } from "../shard-mgmt";
import type { ShardMigrationFile } from "../migrations";

export const CALLBACK = "https://auth.zavisites.com/callback";
export const HOOK_BASE = "https://api.zaviagent.com";
export const files: ShardMigrationFile[] = [{ version: "0001_core", sql: "-- core", sha256: "x" }];

export function world(opts: { existingProjects?: number; healthyAfter?: number; publishable?: string; brokerRole?: boolean; ignoreHooks?: boolean; poolerHost?: string | null } = {}) {
  const log: string[] = [];
  const vault = new Map<string, string>();
  const sqlLog: string[] = [];
  let row: ShardRow | null = null;
  const regUpdates: Array<Record<string, unknown>> = [];
  const registry = {
    async register({ env, name, region, is_canary }: { env: "dev"; name: string; region: string; is_canary?: boolean }) {
      row ??= {
        id: "aaaaaaaa-0000-4000-8000-000000000001", env, name, project_ref: null, url: null, region,
        state: "provisioning", is_canary: !!is_canary, schema_version: null, provision_step: null,
        max_sites: 2000, site_count: 0, created_at: "2026-10-01T00:00:00Z",
      };
      return row;
    },
    async getSecret(_id: string, name: string) {
      return vault.get(name) ?? null;
    },
    async setSecret(_id: string, name: string, value: string) {
      log.push(`vault:${name}`);
      vault.set(name, value);
    },
    async record(_id: string, _v: string, sha: string) {
      return sha;
    },
    async update(_id: string, patch: Record<string, unknown>) {
      regUpdates.push(patch);
      row = { ...(row as ShardRow), ...(patch as Partial<ShardRow>) };
      return row;
    },
  };
  let projects = Array.from({ length: opts.existingProjects ?? 0 }, (_, i) => ({ ref: `existingref${i}`, name: "zavi-shard-dev-1", organization_id: "org", status: "ACTIVE_HEALTHY" }));
  let healthChecks = 0;
  let exposed = "public, graphql_public";
  let auth: Record<string, unknown> = { external_email_enabled: true };
  let keys: SigningKey[] = [];
  const ledger = new Set<string>();
  let graphql = 1;
  const publishable = opts.publishable ?? "sb_publishable_abc123";
  const mgmt: ShardMgmt = {
    orgId: "org",
    async createProject({ name }) {
      log.push("createProject");
      const p = { ref: "newshardref01", name, organization_id: "org", status: "COMING_UP" };
      projects.push(p);
      return p;
    },
    async listProjectsByName(name) {
      return projects.filter((p) => p.name === name);
    },
    async isHealthy() {
      healthChecks++;
      return healthChecks > (opts.healthyAfter ?? 0);
    },
    async query(_ref, sql) {
      sqlLog.push(sql);
      if (sql.includes("pg_roles")) return [{ n: opts.brokerRole === false ? 0 : 1 }];
      if (sql.includes("to_regclass")) return [{ present: ledger.size > 0 }];
      if (sql.startsWith("select version")) return [...ledger].map((version) => ({ version }));
      if (sql.includes("insert into zsite.migrations")) ledger.add(/'([^']+)'/.exec(sql)![1]);
      if (sql === "-- core") log.push("schema");
      if (sql.startsWith("drop extension")) graphql = 0;
      if (sql.includes("pg_extension")) return [{ n: graphql }];
      return [];
    },
    async getExposedSchemas() {
      return exposed;
    },
    async setExposedSchemas(_r, s) {
      log.push(`exposed:${s}`);
      exposed = s;
    },
    async getAuthConfig() {
      return auth;
    },
    async patchAuthConfig(_r, patch) {
      log.push("authConfig");
      const p = { ...patch };
      if (opts.ignoreHooks) delete p.hook_send_email_enabled;
      auth = { ...auth, ...p };
      delete auth.hook_send_email_secrets;
    },
    async apiKeys() {
      return { anon: "anon-jwt", service_role: "service-jwt" };
    },
    async listSigningKeys() {
      return keys;
    },
    async importSigningKey(_r, { private_jwk, status }) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(private_jwk.kid))) {
        throw new Error("supabase signing key import failed (400): private_jwk.kid: Invalid UUID");
      }
      log.push(`import:${status}`);
      const k = { id: `key${keys.length}`, kid: String(private_jwk.kid), algorithm: "ES256", status };
      keys.push(k);
      return k;
    },
    async publishableKey() {
      return publishable;
    },
    async poolerHost() {
      if (opts.poolerHost === null) throw new Error("pooler config (no primary pooler)");
      return opts.poolerHost ?? "aws-1-us-west-1.pooler.supabase.com";
    },
    async setSigningKeyStatus(_r, id, status) {
      log.push(`keyStatus:${id}:${status}`);
      keys = keys.map((k) => (k.id === id ? { ...k, status } : k));
    },
  };
  const secrets: Array<{ name: string; value: string }> = [];
  const signer = {
    async put(ref: string, jwk: Record<string, unknown>) {
      log.push("signer.put");
      secrets.push({ name: signerSecretName(ref), value: JSON.stringify(jwk) });
    },
  };
  const kvMap = new Map<string, string>();
  const kv = {
    async get(k: string) {
      return kvMap.get(k) ?? null;
    },
    async put(k: string, v: string) {
      log.push(`kv.put:${k}`);
      kvMap.set(k, v);
    },
  };
  const deps: ProvisionDeps = {
    registry: registry as unknown as ProvisionDeps["registry"],
    mgmt,
    files,
    hookBaseUrl: HOOK_BASE,
    secrets: registry as unknown as ProvisionDeps["secrets"],
    brokerCallbackUrl: CALLBACK,
    signer,
    kv,
    sleep: async () => undefined,
    now: () => 1_700_000_000_000,
    generateJwk: (kid) => ({ kty: "EC", crv: "P-256", x: "X", y: "Y", d: "PRIVATE-D", kid }),
  };
  return { deps, log, projects, regUpdates, secrets, kvMap, vault, sqlLog, get row() { return row as ShardRow; }, get auth() { return auth; }, get keys() { return keys; }, seedKey(k: SigningKey) { keys.push(k); } };
}

