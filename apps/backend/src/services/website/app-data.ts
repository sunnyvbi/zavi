
import { Client } from "pg";
import { z } from "zod";
import { getSecret } from "@/services/secrets/vault";
import { tenantClient, type TenantId } from "@/services/tenant-client";
import { normalizeCell, wasCellTruncated, type RowBrowseCell } from "@/services/tools/operator-db/row-browser";

export function enumLabelList(raw: unknown): string[] | null {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string" && raw.startsWith("{") && raw.endsWith("}")) {
    const inner = raw.slice(1, -1);
    if (!inner) return null;
    return inner.split(",").map((v) => v.replace(/^"(.*)"$/, "$1"));
  }
  return null;
}

const QUERY_TIMEOUT_MS = 5_000;
const MAX_TABLES = 200;
const MAX_COLUMNS = 100;
const MAX_MUTATION_BYTES = 64_000;
export const APP_ROWS_MAX_LIMIT = 100;
export const APP_ROWS_DEFAULT_LIMIT = 25;
export const APP_ROWS_MAX_OFFSET = 100_000;

const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export const rowKeySchema = z.record(z.string(), scalarSchema).refine((v) => Object.keys(v).length > 0, {
  message: "row key is required",
});
export const rowValuesSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const keys = Object.keys(value);
  if (keys.length > MAX_COLUMNS) ctx.addIssue({ code: "custom", message: `at most ${MAX_COLUMNS} fields` });
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    ctx.addIssue({ code: "custom", message: "values must be JSON-serializable" });
    return;
  }
  if (bytes > MAX_MUTATION_BYTES) {
    ctx.addIssue({ code: "custom", message: `values exceed ${MAX_MUTATION_BYTES} bytes` });
  }
});

export type AppDataColumn = {
  name: string;
  type: string;
  nullable: boolean;
  has_default: boolean;
  generated: boolean;
  primary_key: boolean;
  writable: boolean;
  enum_values: string[] | null;
};

export type AppDataTable = {
  name: string;
  row_estimate: number | null;
  columns: AppDataColumn[];
  primary_key: string[];
  writable: boolean;
};

export type AppDataRowPage = {
  dialect: "postgres";
  table: string;
  columns: AppDataColumn[];
  rows: Record<string, RowBrowseCell>[];
  row_keys: Record<string, RowBrowseCell>[];
  row_versions: string[];
  truncated_columns: string[][];
  has_more: boolean;
  masked_columns: string[];
  writable: boolean;
};

export class AppDataError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly causeCode?: string,
    public readonly details?: {
      postgres_code: string;
      constraint?: string;
      table?: string;
      column?: string;
    },
  ) {
    super(message);
    this.name = "AppDataError";
  }
}

type ResourceRow = {
  mode: string | null;
  status: string | null;
  provider: string | null;
  vault_key: string | null;
};

export async function resolveGeneratedAppDatabase(tenantId: TenantId): Promise<string> {
  const { data, error } = await tenantClient(tenantId)
    .from("tenant_resources")
    .select("mode,status,provider,vault_key")
    .eq("resource_kind", "db")
    .maybeSingle();
  if (error) throw new AppDataError("app_db_resource_read_failed", "Could not resolve the app database.");
  const row = data as ResourceRow | null;
  if (!row || row.mode !== "provisioned" || row.provider !== "neon" || row.status !== "ready") {
    throw new AppDataError("app_db_not_ready", "The generated app database is not ready.");
  }
  if (!row.vault_key) throw new AppDataError("app_db_secret_missing", "The app database credential is missing.");
  const connectionString = await getSecret(tenantId, row.vault_key);
  if (!connectionString) throw new AppDataError("app_db_secret_missing", "The app database credential is missing.");
  return connectionString;
}

export const HIDDEN_APP_TABLES: ReadonlySet<string> = new Set([
  "_schema_meta",
  "_schema_migrations",
  "invites",
  "_zavi_audit",
]);

export async function withGeneratedAppClient<T>(tenantId: TenantId, fn: (client: Client) => Promise<T>): Promise<T> {
  const connectionString = await resolveGeneratedAppDatabase(tenantId);
  return withClient(connectionString, fn);
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function publicTable(name: string): string {
  return `${quoteIdent("public")}.${quoteIdent(name)}`;
}

export function isProtectedAppDataColumn(name: string): boolean {
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const parts = normalized.split("_").filter(Boolean);
  const has = (value: string) => parts.includes(value);
  const pair = (left: string, right: string) =>
    parts.some((part, index) => part === left && parts[index + 1] === right);

  return has("password") || has("passwd") || has("pwd") || has("credential") ||
    has("credentials") || has("secret") ||
    normalized === "token" || normalized.endsWith("_token") ||
    normalized === "otp" || normalized.endsWith("_otp") ||
    normalized === "mfa_code" || normalized.endsWith("_mfa_code") ||
    pair("api", "key") || pair("access", "key") || pair("private", "key") ||
    pair("secret", "key") || pair("access", "token") || pair("refresh", "token") ||
    pair("auth", "token") || pair("bearer", "token") || pair("session", "token") ||
    pair("api", "token");
}

function publicColumns(table: AppDataTable): AppDataColumn[] {
  return table.columns.filter((column) => !isProtectedAppDataColumn(column.name));
}

function publicTableMetadata(table: AppDataTable): AppDataTable {
  const columns = publicColumns(table);
  const visibleNames = new Set(columns.map((column) => column.name));
  return {
    ...table,
    columns,
    primary_key: table.primary_key.filter((name) => visibleNames.has(name)),
  };
}

function safeProjection(table: AppDataTable): string {
  return publicColumns(table).map((column) => quoteIdent(column.name)).join(", ");
}

function projectionWithVersion(table: AppDataTable): string {
  const projection = safeProjection(table);
  return `${projection ? `${projection}, ` : ""}xmin::text AS __zavi_xmin`;
}

function withClient<T>(connectionString: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString,
    statement_timeout: QUERY_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    connectionTimeoutMillis: 8_000,
  });
  return client.connect().then(() => fn(client)).finally(() => client.end().catch(() => undefined));
}

type ColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  is_identity: "YES" | "NO";
  is_generated: "ALWAYS" | "NEVER";
  primary_key: boolean;
  row_estimate: string | null;
  enum_labels: string[] | null;
};

async function introspectTables(client: Client): Promise<AppDataTable[]> {
  const result = await client.query<ColumnRow>(
    `SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable,
            c.column_default, c.is_identity, c.is_generated,
            COALESCE(pk.primary_key, false) AS primary_key,
            -- reltuples is NOT NULL and is -1 (not NULL) for a never-analyzed
            -- relation since PG 14, which is the NORMAL state for a generated app
            -- that drops and recreates its tables. Left raw, the console renders
            -- "~-1 rows". NULLIF restores the "unknown" the UI already handles.
            NULLIF(cls.reltuples, -1)::bigint::text AS row_estimate,
            en.labels AS enum_labels
       FROM information_schema.columns c
       LEFT JOIN LATERAL (
         SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
           FROM pg_type t
           JOIN pg_enum e ON e.enumtypid = t.oid
           JOIN pg_namespace tn ON tn.oid = t.typnamespace
          WHERE t.typname = c.udt_name
            AND tn.nspname = c.udt_schema
       ) en ON true
       JOIN pg_class cls ON cls.relname = c.table_name
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace AND ns.nspname = c.table_schema
       LEFT JOIN (
         SELECT tc.table_schema, tc.table_name, kcu.column_name, true AS primary_key
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name
            AND kcu.constraint_schema = tc.constraint_schema
            -- Postgres constraint names are unique per TABLE, not per schema.
            -- Without this, two tables that both name their PK the same thing
            -- (say pk_id) cross-match: the column row is emitted twice,
            -- primary_key becomes [id, id], and validateKey's length check then
            -- rejects EVERY update and delete on that table as a bad row key.
            AND kcu.table_name = tc.table_name
          WHERE tc.constraint_type = 'PRIMARY KEY'
       ) pk ON pk.table_schema = c.table_schema
           AND pk.table_name = c.table_name
           AND pk.column_name = c.column_name
      WHERE c.table_schema = 'public'
        AND cls.relkind = 'r'
        AND c.table_name NOT IN ('_schema_meta', '_schema_migrations', 'invites', '_zavi_audit')
      ORDER BY c.table_name, c.ordinal_position
      LIMIT ${MAX_TABLES * MAX_COLUMNS}`,
  );
  const byName = new Map<string, AppDataTable>();
  for (const row of result.rows) {
    if (HIDDEN_APP_TABLES.has(row.table_name)) continue;
    let table = byName.get(row.table_name);
    if (!table) {
      table = {
        name: row.table_name,
        row_estimate: row.row_estimate == null || Number(row.row_estimate) < 0
          ? null
          : Number(row.row_estimate),
        columns: [],
        primary_key: [],
        writable: false,
      };
      byName.set(row.table_name, table);
    }
    const generated = row.is_identity === "YES" || row.is_generated === "ALWAYS";
    const secret = isProtectedAppDataColumn(row.column_name);
    const column: AppDataColumn = {
      name: row.column_name,
      type: row.data_type === "USER-DEFINED" ? row.udt_name : row.data_type,
      nullable: row.is_nullable === "YES",
      has_default: row.column_default !== null || row.is_identity === "YES",
      generated,
      primary_key: row.primary_key,
      writable: !generated && !secret,
      enum_values: secret ? null : enumLabelList(row.enum_labels),
    };
    if (table.columns.some((existing) => existing.name === column.name)) continue;
    table.columns.push(column);
    if (row.primary_key && !table.primary_key.includes(row.column_name)) {
      table.primary_key.push(row.column_name);
    }
  }
  return [...byName.values()].slice(0, MAX_TABLES).map((table) => ({
    ...table,
    writable:
      table.primary_key.length > 0 &&
      table.primary_key.every((name) => !isProtectedAppDataColumn(name)),
  }));
}

async function loadTable(client: Client, requested: string): Promise<AppDataTable> {
  const tables = await introspectTables(client);
  const table = tables.find((candidate) => candidate.name === requested);
  if (!table) throw new AppDataError("app_db_bad_table", "Unknown table for this app.");
  return table;
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) return APP_ROWS_DEFAULT_LIMIT;
  return Math.max(1, Math.min(APP_ROWS_MAX_LIMIT, Math.floor(value)));
}

function clampOffset(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  const offset = Math.floor(value);
  if (offset > APP_ROWS_MAX_OFFSET) throw new AppDataError("app_db_offset_too_large", "Requested page is out of range.");
  return offset;
}

type PrimaryKeyMode = "reject" | "natural-only";

function validateValues(
  table: AppDataTable,
  raw: unknown,
  opts: { allowEmpty: boolean; primaryKey: PrimaryKeyMode },
): Record<string, unknown> {
  const parsed = rowValuesSchema.safeParse(raw);
  if (!parsed.success) throw new AppDataError("app_db_invalid_values", parsed.error.issues[0]?.message ?? "Invalid values.");
  const values = parsed.data;
  if (!opts.allowEmpty && Object.keys(values).length === 0) {
    throw new AppDataError("app_db_invalid_values", "At least one field is required.");
  }
  const columns = new Map(table.columns.map((column) => [column.name, column]));
  for (const name of Object.keys(values)) {
    const column = columns.get(name);
    if (!column) throw new AppDataError("app_db_bad_column", `Unknown column: ${name}`);
    if (!column.writable) throw new AppDataError("app_db_protected_column", `Column cannot be edited: ${name}`);
    if (column.primary_key) {
      if (opts.primaryKey === "reject") {
        throw new AppDataError("app_db_protected_column", `Primary-key column cannot be edited: ${name}`);
      }
      if (column.has_default) {
        throw new AppDataError(
          "app_db_protected_column",
          `Primary-key column is assigned by the database and cannot be set: ${name}`,
        );
      }
    }
  }
  return values;
}

function assertNoRequiredCredentialColumn(table: AppDataTable, values: Record<string, unknown>): void {
  const blocking = table.columns.find(
    (column) =>
      isProtectedAppDataColumn(column.name) &&
      !column.nullable &&
      !column.has_default &&
      !column.generated &&
      !(column.name in values),
  );
  if (!blocking) return;
  throw new AppDataError(
    "app_db_credential_required",
    `This table requires a password credential (${blocking.name}), which the console cannot set. Create this user through your app's own signup flow instead.`,
  );
}

function validateKey(table: AppDataTable, raw: unknown): Record<string, string | number | boolean | null> {
  if (!table.writable) throw new AppDataError("app_db_table_read_only", "This table has no primary key and is read-only.");
  const parsed = rowKeySchema.safeParse(raw);
  if (!parsed.success) throw new AppDataError("app_db_invalid_key", "A valid row key is required.");
  const key = parsed.data;
  if (Object.keys(key).length !== table.primary_key.length || table.primary_key.some((name) => !(name in key))) {
    throw new AppDataError("app_db_invalid_key", "The row key does not match this table's primary key.");
  }
  return key;
}

type PostgresError = Error & {
  code?: string;
  constraint?: string;
  table?: string;
  column?: string;
  detail?: string;
};

function safePgIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : undefined;
}

function postgresFailure(error: unknown): never {
  const pg = error as PostgresError;
  const code = typeof pg?.code === "string" ? pg.code : undefined;
  if (!code) throw error;
  const details = {
    postgres_code: code,
    constraint: safePgIdentifier(pg.constraint),
    table: safePgIdentifier(pg.table),
    column: safePgIdentifier(pg.column),
  };
  if (process.env.NODE_ENV !== "production") {
    console.error("[website-app-data] PostgreSQL mutation failure", {
      code: pg.code,
      constraint: pg.constraint,
      table: pg.table,
      column: pg.column,
      detail: pg.detail,
      message: pg.message,
    });
  }
  if (code === "23502") {
    const column = details.column ? `Column ${JSON.stringify(details.column)}` : "A required column";
    throw new AppDataError("app_db_required_column", `${column} is required.`, code, details);
  }
  if (code === "23503") {
    const constraint = details.constraint ? ` (${details.constraint})` : "";
    throw new AppDataError("app_db_foreign_key", `A referenced row required by this value does not exist${constraint}.`, code, details);
  }
  if (code === "23505") {
    const constraint = details.constraint ? ` for ${details.constraint}` : "";
    throw new AppDataError("app_db_conflict", `A row already exists${constraint}.`, code, details);
  }
  if (code === "23514") {
    const constraint = details.constraint ? ` ${details.constraint}` : "";
    throw new AppDataError("app_db_check_constraint", `The value violates constraint${constraint}.`, code, details);
  }
  if (code === "42703") {
    throw new AppDataError("app_db_schema_mismatch", "The database schema changed while saving. Refresh and try again.", code, details);
  }
  if (code.startsWith("23")) throw new AppDataError("app_db_constraint", "The row violates a database constraint.", code, details);
  if (code.startsWith("22")) throw new AppDataError("app_db_invalid_values", "One or more values do not match the column type.", code, details);
  throw error;
}

function mutationResult(row: Record<string, unknown>, table: AppDataTable) {
  const version = String(row.__zavi_xmin ?? "");
  const clean = { ...row };
  delete clean.__zavi_xmin;
  const values: Record<string, RowBrowseCell> = {};
  const truncated: string[] = [];
  for (const [name, value] of Object.entries(clean)) {
    if (isProtectedAppDataColumn(name)) continue;
    const cell = normalizeCell(value);
    values[name] = cell;
    if (wasCellTruncated(cell)) truncated.push(name);
  }
  const key: Record<string, RowBrowseCell> = {};
  for (const name of table.primary_key) {
    if (!isProtectedAppDataColumn(name)) key[name] = normalizeCell(clean[name], { truncate: false });
  }
  return { values, key, version, truncated };
}

export async function listGeneratedAppTables(tenantId: TenantId): Promise<AppDataTable[]> {
  const connectionString = await resolveGeneratedAppDatabase(tenantId);
  return withClient(connectionString, async (client) =>
    (await introspectTables(client)).map(publicTableMetadata));
}

export async function readGeneratedAppRows(args: { tenantId: TenantId; table: string; limit: number; offset: number }): Promise<AppDataRowPage> {
  const connectionString = await resolveGeneratedAppDatabase(args.tenantId);
  return withClient(connectionString, async (client) => {
    const table = await loadTable(client, args.table);
    const limit = clampLimit(args.limit);
    const offset = clampOffset(args.offset);
    const order = table.primary_key.length > 0
      ? ` ORDER BY ${table.primary_key.map(quoteIdent).join(", ")}`
      : " ORDER BY ctid";
    const result = await client.query(
      `SELECT ${projectionWithVersion(table)} FROM ${publicTable(table.name)}${order} LIMIT $1 OFFSET $2`,
      [limit + 1, offset],
    );
    const hasMore = result.rows.length > limit;
    const selected = hasMore ? result.rows.slice(0, limit) : result.rows;
    const mapped = selected.map((row) => mutationResult(row as Record<string, unknown>, table));
    return {
      dialect: "postgres",
      table: table.name,
      columns: publicColumns(table),
      rows: mapped.map((row) => row.values),
      row_keys: mapped.map((row) => row.key),
      row_versions: mapped.map((row) => row.version),
      truncated_columns: mapped.map((row) => row.truncated),
      has_more: hasMore,
      masked_columns: [],
      writable: table.writable,
    };
  });
}

export async function createGeneratedAppRow(args: { tenantId: TenantId; table: string; values: unknown }) {
  const connectionString = await resolveGeneratedAppDatabase(args.tenantId);
  return withClient(connectionString, async (client) => {
    const table = await loadTable(client, args.table);
    if (!table.writable) throw new AppDataError("app_db_table_read_only", "This table has no primary key and is read-only.");
    const values = validateValues(table, args.values, { allowEmpty: true, primaryKey: "natural-only" });
    assertNoRequiredCredentialColumn(table, values);
    const names = Object.keys(values);
    const returning = projectionWithVersion(table);
    const sql = names.length === 0
      ? `INSERT INTO ${publicTable(table.name)} DEFAULT VALUES RETURNING ${returning}`
      : `INSERT INTO ${publicTable(table.name)} (${names.map(quoteIdent).join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${returning}`;
    try {
      const result = await client.query(sql, names.map((name) => values[name]));
      return mutationResult(result.rows[0] as Record<string, unknown>, table);
    } catch (error) {
      return postgresFailure(error);
    }
  });
}

export async function updateGeneratedAppRow(args: { tenantId: TenantId; table: string; key: unknown; version: string; values: unknown }) {
  const connectionString = await resolveGeneratedAppDatabase(args.tenantId);
  return withClient(connectionString, async (client) => {
    const table = await loadTable(client, args.table);
    const key = validateKey(table, args.key);
    const values = validateValues(table, args.values, { allowEmpty: false, primaryKey: "reject" });
    const names = Object.keys(values);
    const whereStart = names.length + 1;
    const where = table.primary_key.map((name, i) => `${quoteIdent(name)} IS NOT DISTINCT FROM $${whereStart + i}`).join(" AND ");
    const versionIndex = whereStart + table.primary_key.length;
    if (isRoleColumnWrite(table, names)) {
      return updateRoleRow(client, table, key, args.version, values, names);
    }
    const returning = projectionWithVersion(table);
    try {
      const result = await client.query(
        `UPDATE ${publicTable(table.name)} SET ${names.map((name, i) => `${quoteIdent(name)} = $${i + 1}`).join(", ")} WHERE ${where} AND xmin::text = $${versionIndex} RETURNING ${returning}`,
        [...names.map((name) => values[name]), ...table.primary_key.map((name) => key[name]), args.version],
      );
      if (result.rowCount !== 1) throw new AppDataError("app_db_stale_row", "This row changed since it was loaded. Refresh and try again.");
      return { ...mutationResult(result.rows[0] as Record<string, unknown>, table), roleChange: null };
    } catch (error) {
      if (error instanceof AppDataError) throw error;
      return postgresFailure(error);
    }
  });
}

export const ROLE_TABLE = "users";
export const ROLE_COLUMN = "role";

function isRoleColumnWrite(table: AppDataTable, names: string[]): boolean {
  return table.name === ROLE_TABLE && table.primary_key.length === 1 && names.includes(ROLE_COLUMN);
}

export function auditRoleValue(value: unknown): "user" | "admin" | "none" | "other" {
  if (value === null || value === undefined) return "none";
  return value === "user" || value === "admin" ? value : "other";
}

export async function writeSiteAudit(
  client: Client,
  event: "app_role_changed" | "app_invite_created" | "app_invite_revoked",
  targetUserId: string | null,
  detail: Record<string, string>,
): Promise<void> {
  const exists = await client.query<{ ok: boolean }>(
    "SELECT to_regclass('public._zavi_audit') IS NOT NULL AS ok",
  );
  if (!exists.rows[0]?.ok) return;
  await client.query("SAVEPOINT zavi_audit");
  try {
    await client.query(
      "INSERT INTO public._zavi_audit (event, actor_user_id, target_user_id, detail) VALUES ($1, NULL, $2::bigint, $3::jsonb)",
      [event, targetUserId && /^\d{1,19}$/.test(targetUserId) ? targetUserId : null, JSON.stringify(detail)],
    );
    await client.query("RELEASE SAVEPOINT zavi_audit");
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT zavi_audit");
  }
}

export type RoleChange = { table: string; target_id: string; from: string; to: string };

async function updateRoleRow(
  client: Client,
  table: AppDataTable,
  key: Record<string, string | number | boolean | null>,
  version: string,
  values: Record<string, unknown>,
  names: string[],
): Promise<ReturnType<typeof mutationResult> & { roleChange: RoleChange | null }> {
  const pk = table.primary_key[0];
  const n = names.length;
  const qualified = publicColumns(table).map((column) => `t.${quoteIdent(column.name)}`).join(", ");
  const returning = `${qualified ? `${qualified}, ` : ""}t.xmin::text AS __zavi_xmin, o.__zavi_old_role`;
  const sql =
    `UPDATE ${publicTable(table.name)} AS t SET ${names.map((name, i) => `${quoteIdent(name)} = $${i + 1}`).join(", ")} ` +
    `FROM (SELECT ctid AS __zavi_ctid, ${quoteIdent(ROLE_COLUMN)}::text AS __zavi_old_role FROM ${publicTable(table.name)} ` +
    `WHERE ${quoteIdent(pk)} IS NOT DISTINCT FROM $${n + 1} FOR UPDATE) AS o ` +
    `WHERE t.ctid = o.__zavi_ctid AND t.xmin::text = $${n + 2} RETURNING ${returning}`;
  try {
    await client.query("BEGIN");
    const result = await client.query(sql, [...names.map((name) => values[name]), key[pk], version]);
    if (result.rowCount !== 1) throw new AppDataError("app_db_stale_row", "This row changed since it was loaded. Refresh and try again.");
    const raw = { ...(result.rows[0] as Record<string, unknown>) };
    const oldRole = raw.__zavi_old_role;
    delete raw.__zavi_old_role;
    const newRole = raw[ROLE_COLUMN];
    let roleChange: RoleChange | null = null;
    if (String(oldRole ?? "") !== String(newRole ?? "")) {
      roleChange = {
        table: table.name,
        target_id: String(raw[pk] ?? key[pk]),
        from: auditRoleValue(oldRole),
        to: auditRoleValue(newRole),
      };
      await writeSiteAudit(client, "app_role_changed", roleChange.target_id, {
        table: roleChange.table,
        from: roleChange.from,
        to: roleChange.to,
      });
    }
    await client.query("COMMIT");
    return { ...mutationResult(raw, table), roleChange };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof AppDataError) throw error;
    return postgresFailure(error);
  }
}

export async function deleteGeneratedAppRow(args: { tenantId: TenantId; table: string; key: unknown; version: string }): Promise<void> {
  const connectionString = await resolveGeneratedAppDatabase(args.tenantId);
  return withClient(connectionString, async (client) => {
    const table = await loadTable(client, args.table);
    const key = validateKey(table, args.key);
    const where = table.primary_key.map((name, i) => `${quoteIdent(name)} IS NOT DISTINCT FROM $${i + 1}`).join(" AND ");
    try {
      const result = await client.query(
        `DELETE FROM ${publicTable(table.name)} WHERE ${where} AND xmin::text = $${table.primary_key.length + 1}`,
        [...table.primary_key.map((name) => key[name]), args.version],
      );
      if (result.rowCount !== 1) throw new AppDataError("app_db_stale_row", "This row changed since it was loaded. Refresh and try again.");
    } catch (error) {
      if (error instanceof AppDataError) throw error;
      return postgresFailure(error);
    }
  });
}
