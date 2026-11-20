
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { getSecret } from "@/services/secrets/vault";
import { getBoolSettingStrictResolved } from "@/services/settings";
import { pgSslOption } from "@/services/tools/operator-db/pg-ssl";
import { probeCandidate, MANAGED_DB_LOGIN, readDbGeneration } from "@/services/data-gateway";
import { inngest } from "@/../workers/client";

export const MANAGED_RO_ROLE = MANAGED_DB_LOGIN;
const FLAG_KEY = "built_app_operator_db_enabled";

export type ManagedOperatorDbOutcome =
  | "connected"
  | "disabled"
  | "no_app_db"
  | "founder_connected"
  | "already_connected"
  | "not_read_only"
  | "unreachable"
  | "refused"
  | "opted_out";

export type ManagedOperatorDbDeps = {
  isEnabled: (tenant_id: string) => Promise<boolean>;
  readDbRow: (tenant_id: string) => Promise<{ mode: string; status: string; vault_key: string | null } | null>;
  readOperatorDb: (tenant_id: string) => Promise<{ managed_by: string | null } | undefined>;
  isOptedOut: (tenant_id: string) => Promise<boolean>;
  getSecret: (tenant_id: string, key: string) => Promise<string | null>;
  grantReadOnlyRole: (ownerUri: string, role: string, password: string) => Promise<void>;
  verifyReadOnly: (uri: string) => Promise<boolean>;
  probe: (uri: string, tenant_id: string) => Promise<boolean>;
  store: (tenant_id: string, uri: string) => Promise<boolean>;
  enqueueDiscovery: (tenant_id: string) => Promise<void>;
  newPassword: () => string;
  withAppDbLock: <T>(ownerUri: string, fn: () => Promise<T>) => Promise<T>;
};

export function readOnlyUri(ownerUri: string, role: string, password: string): string {
  const u = new URL(ownerUri);
  u.username = role;
  u.password = password;
  return u.toString();
}

async function withPg<T>(uri: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({
    connectionString: uri,
    ssl: pgSslOption(uri),
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
  });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => undefined);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const realManagedOperatorDbDeps: ManagedOperatorDbDeps = {
  isEnabled: (tenant_id) => getBoolSettingStrictResolved(FLAG_KEY, tenant_id),
  async readDbRow(tenant_id) {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("tenant_resources")
      .select("mode, status, vault_key")
      .eq("resource_kind", "db")
      .maybeSingle<{ mode: string; status: string; vault_key: string | null }>();
    if (error) throw new Error(`db row read failed: ${error.message}`);
    return data ?? null;
  },
  async readOperatorDb(tenant_id) {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("connector_metadata")
      .select("managed_by")
      .eq("slug", "operator_db")
      .maybeSingle<{ managed_by: string | null }>();
    if (error) throw new Error(`connector_metadata read failed: ${error.message}`);
    return data ?? undefined;
  },
  async isOptedOut(tenant_id) {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("tenant_db_settings")
      .select("managed_db_opt_out_at")
      .maybeSingle<{ managed_db_opt_out_at: string | null }>();
    if (error) throw new Error(`tenant_db_settings read failed: ${error.message}`);
    return Boolean(data?.managed_db_opt_out_at);
  },
  getSecret,
  async grantReadOnlyRole(ownerUri, role, password) {
    if (!/^[a-z_][a-z0-9_]*$/.test(role) || !/^[0-9a-f]{32,}$/.test(password)) {
      throw new Error("invalid read-only role parameters");
    }
    await withPg(ownerUri, async (c) => {
      const exists = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]);
      await c.query(
        exists.rowCount
          ? `ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${password}'`
          : `CREATE ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${password}'`,
      );
      await c.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
      await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${role}`);
    });
  },
  async verifyReadOnly(uri) {
    return withPg(uri, async (c) => {
      const r = await c.query<{ ok: boolean }>(
        `SELECT NOT r.rolsuper AND NOT r.rolcreaterole AND NOT r.rolcreatedb
            AND NOT pg_has_role(current_user, 'pg_write_all_data', 'USAGE')
            AND NOT has_schema_privilege(current_user, 'public', 'CREATE')
            AND NOT has_database_privilege(current_user, current_database(), 'CREATE')
            AND NOT EXISTS (
              SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
               WHERE m.member = r.oid)
            AND NOT EXISTS (
              SELECT 1 FROM information_schema.role_table_grants
               WHERE grantee = current_user AND privilege_type <> 'SELECT')
            AS ok
           FROM pg_roles r WHERE r.rolname = current_user`,
      );
      return r.rows[0]?.ok === true;
    });
  },
  async probe(uri, tenant_id) {
    for (let i = 0; i < 3; i++) {
      const ctx = { tenant_id, caller: { kind: "background" as const, feature: "App database setup" } };
      if ((await probeCandidate(ctx, "postgres", uri)).ok) return true;
      await sleep(3000);
    }
    return false;
  },
  async store(tenant_id, uri) {
    const { data, error } = await tenantRpc(asTenantId(tenant_id), "set_managed_operator_db_connection", {
      p_connection_string: uri,
    });
    if (error) throw new Error(`set_managed_operator_db_connection failed: ${error.code ?? "unknown"}`);
    return data === true;
  },
  async enqueueDiscovery(tenant_id) {
    const generation = await Promise.resolve().then(() => readDbGeneration(tenant_id)).catch(() => undefined);
    await inngest.send({ name: "operator-db.discover.requested", data: { tenant_id, ...(generation !== undefined ? { generation } : {}) } });
  },
  newPassword: () => randomBytes(24).toString("hex"),
  async withAppDbLock(ownerUri, fn) {
    const c = new Client({
      connectionString: ownerUri,
      ssl: pgSslOption(ownerUri),
      connectionTimeoutMillis: 10000,
      statement_timeout: 60000,
    });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('zavi_operator_db_connect'))`);
      try {
        return await fn();
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
      }
    } finally {
      await c.end().catch(() => undefined);
    }
  },
};

export async function isZaviManagedOperatorDb(
  tenant_id: string,
  deps: Pick<ManagedOperatorDbDeps, "readOperatorDb"> = realManagedOperatorDbDeps,
): Promise<boolean> {
  return (await deps.readOperatorDb(tenant_id))?.managed_by === "zavi";
}

export async function ensureManagedOperatorDb(
  tenant_id: string,
  deps: ManagedOperatorDbDeps = realManagedOperatorDbDeps,
): Promise<ManagedOperatorDbOutcome> {
  const existing = await deps.readOperatorDb(tenant_id);
  if (existing && existing.managed_by !== "zavi") return "founder_connected";
  if (existing) return "already_connected";
  if (await deps.isOptedOut(tenant_id)) return "opted_out";
  if (!(await deps.isEnabled(tenant_id))) return "disabled";

  const row = await deps.readDbRow(tenant_id);
  if (!row || row.mode !== "provisioned" || row.status !== "ready" || !row.vault_key) return "no_app_db";
  const ownerUri = await deps.getSecret(tenant_id, row.vault_key);
  if (!ownerUri) return "no_app_db";

  const locked = await deps.withAppDbLock(ownerUri, async (): Promise<ManagedOperatorDbOutcome | null> => {
    if (!(await deps.isEnabled(tenant_id))) return "disabled";
    const again = await deps.readOperatorDb(tenant_id);
    if (again) return again.managed_by === "zavi" ? "already_connected" : "founder_connected";
    if (await deps.isOptedOut(tenant_id)) return "opted_out";
    const password = deps.newPassword();
    await deps.grantReadOnlyRole(ownerUri, MANAGED_RO_ROLE, password);
    const uri = readOnlyUri(ownerUri, MANAGED_RO_ROLE, password);
    if (!(await deps.probe(uri, tenant_id))) return "unreachable";
    if (!(await deps.verifyReadOnly(uri))) return "not_read_only";
    if (!(await deps.store(tenant_id, uri))) return "refused";
    return null;
  });
  if (locked) return locked;

  try {
    await deps.enqueueDiscovery(tenant_id);
  } catch (e) {
    console.warn(`[managed-operator-db] tenant=${tenant_id} discovery enqueue failed: ${(e as Error).message}`);
  }
  return "connected";
}

export async function refreshManagedOperatorDbAfterDeploy(
  tenant_id: string,
  deps: ManagedOperatorDbDeps = realManagedOperatorDbDeps,
): Promise<ManagedOperatorDbOutcome | "rediscovering"> {
  const outcome = await ensureManagedOperatorDb(tenant_id, deps);
  if (outcome !== "already_connected") return outcome;
  if (!(await deps.isEnabled(tenant_id))) return "disabled";
  await deps.enqueueDiscovery(tenant_id);
  return "rediscovering";
}
