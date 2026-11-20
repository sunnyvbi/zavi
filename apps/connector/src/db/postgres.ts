import { Client, type ClientConfig } from "pg";
import {
  sampleJsonKeys,
  annotatePgStructuredColumns,
  pgColumnType,
  PG_COLUMNS_SQL,
  PG_ANCESTORS_SQL,
  ancestorsMap,
  capWithAncestors,
  type AncestorRow,
  type PgColumnRow,
  type PgTypeRef,
} from "@zavi/shared/db-guard";
import { COLUMN_BATCH, CONNECT_TIMEOUT_MS, DriverUnsupported, SAFE_NAME, TABLE_CAP, type Driver, type IntroColumn, type IntroTable, type Introspection, type SqlRunOptions, type SqlRunResult } from "./types";

type PgClient = Pick<Client, "connect" | "query" | "end">;
export type PgFactory = (config: ClientConfig) => PgClient;

const defaultFactory: PgFactory = (config) => new Client(config);

export function sslModeOf(cs: string): string | null {
  try {
    const m = new URL(cs).searchParams.get("sslmode");
    return m ? m.toLowerCase() : null;
  } catch {
    const m = /(?:^|\s)sslmode\s*=\s*'?([a-z-]+)'?/i.exec(cs.replace(/'(?:\\.|[^'\\])*'/g, (q) => (/^'[a-z-]+'$/i.test(q) ? q : "''")));
    return m ? m[1]!.toLowerCase() : null;
  }
}

export function pgHostOf(cs: string): string {
  try {
    const u = new URL(cs);
    return decodeURIComponent(u.hostname).replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    const m = /(?:^|\s)host\s*=\s*'?([^\s']*)'?/i.exec(cs);
    return (m?.[1] ?? "").toLowerCase();
  }
}

export function isLoopbackHost(host: string): boolean {
  return host === "" || host.startsWith("/") || host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export function sslAttempts(cs: string): ClientConfig["ssl"][] {
  const mode = sslModeOf(cs);
  if (mode === "disable") return [false];
  if (mode === "verify-ca" || mode === "verify-full") return [{ rejectUnauthorized: true }];
  if (isLoopbackHost(pgHostOf(cs)) && (mode === null || mode === "prefer" || mode === "allow")) return [{ rejectUnauthorized: false }, false];
  return [{ rejectUnauthorized: false }];
}

export const NO_TLS_MESSAGE =
  "This database didn't offer an encrypted connection. If it's on a trusted local network, add sslmode=disable to the connection string.";

export type Transport = "verified_tls" | "unverified_tls" | "plaintext";

const NO_TLS = /does not support SSL/i;

export const SET_TZ = "SELECT set_config('TimeZone', $1, false)";

export function openPostgres(connectionString: string, factory: PgFactory = defaultFactory): Driver {
  let preferPlain = false;
  let transport: Transport | null = null;

  async function connect(timeoutMs: number): Promise<PgClient> {
    const attempts = sslAttempts(connectionString);
    const order = preferPlain && attempts.includes(false) ? [false as const] : attempts;
    let last: unknown;
    for (const ssl of order) {
      const client = factory({
        connectionString,
        ssl,
        statement_timeout: timeoutMs,
        query_timeout: timeoutMs + 2_000,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        application_name: "zavi-connector",
      });
      try {
        await client.connect();
        if (ssl === false && attempts[0] !== false) preferPlain = true;
        transport = ssl === false ? "plaintext" : (ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized ? "verified_tls" : "unverified_tls";
        return client;
      } catch (e) {
        last = e;
        await client.end().catch(() => undefined);
        if (!(ssl !== false && NO_TLS.test(String((e as Error)?.message ?? "")))) break;
      }
    }
    if (NO_TLS.test(String((last as Error)?.message ?? "")) && !attempts.includes(false)) throw new Error(NO_TLS_MESSAGE);
    throw last;
  }

  async function inReadOnly<T>(timeoutMs: number, timeZone: string | undefined, fn: (c: PgClient) => Promise<T>): Promise<T> {
    const client = await connect(timeoutMs);
    try {
      if (timeZone) {
        await client.query(SET_TZ, [timeZone]).catch(() => undefined);
      }
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${Math.round(timeoutMs)}`);
      await client.query("SET LOCAL search_path = pg_catalog, pg_temp");
      try {
        return await fn(client);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  const sql = async (text: string, params: unknown[], opts: SqlRunOptions): Promise<SqlRunResult> =>
    inReadOnly(opts.timeoutMs, opts.timeZone, async (c) => {
      const body = text.replace(/;\s*$/, "");
      await c.query(`DECLARE zavi_cur NO SCROLL CURSOR FOR ${body}`, params);
      const r = await c.query(`FETCH FORWARD ${opts.maxRows + 1} FROM zavi_cur`);
      const got = (r.rows ?? []) as Record<string, unknown>[];
      const truncated = got.length > opts.maxRows;
      return { columns: (r.fields ?? []).map((f: { name: string }) => f.name), rows: truncated ? got.slice(0, opts.maxRows) : got, truncated };
    });

  async function introspect(deadlineAt: number): Promise<Introspection> {
    return inReadOnly(5_000, undefined, async (c) => {
      const all = await c.query(
        `SELECT t.table_name, c.reltuples::bigint AS est
           FROM information_schema.tables t
           LEFT JOIN pg_namespace n ON n.nspname = t.table_schema
           LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid
          WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          ORDER BY t.table_name`,
      );
      const listed = (all.rows as { table_name: string; est: string | null }[]).map((r) => ({
        name: r.table_name,
        est: r.est == null || Number(r.est) < 0 ? null : Number(r.est),
      }));
      const safe = listed.filter((r) => SAFE_NAME.test(r.name));
      const ancestorsOf = ancestorsMap((await c.query(PG_ANCESTORS_SQL)).rows as AncestorRow[]);
      const byName = new Map(safe.map((r) => [r.name, r]));
      const picked = capWithAncestors(safe.map((r) => r.name), TABLE_CAP, ancestorsOf, new Set(byName.keys())).map((n) => byName.get(n)!);
      const parts = await c.query(
        `WITH RECURSIVE tree AS (
           SELECT c.oid AS root, i.inhrelid AS child
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_inherits i ON i.inhparent = c.oid
            WHERE n.nspname = 'public' AND c.relkind = 'p'
           UNION
           SELECT t.root, i.inhrelid FROM tree t JOIN pg_inherits i ON i.inhparent = t.child
         )
         SELECT p.relname AS parent,
                array_agg(CASE WHEN ns.nspname = 'public' THEN ch.relname ELSE ns.nspname || '.' || ch.relname END) AS parts
           FROM tree t JOIN pg_class p ON p.oid = t.root JOIN pg_class ch ON ch.oid = t.child JOIN pg_namespace ns ON ns.oid = ch.relnamespace
          GROUP BY p.relname
         UNION ALL
         SELECT c.relname, NULL FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'p' AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhparent = c.oid)`,
      );
      const partitionsOf = new Map<string, string[]>((parts.rows as { parent: string; parts: string[] | null }[]).map((r) => [r.parent, r.parts ?? []]));
      let deadlineHit = false;
      const cols = new Map<string, IntroColumn[]>();
      const typeRefs: PgTypeRef[] = [];
      const names = picked.map((p) => p.name);
      for (let i = 0; i < names.length; i += COLUMN_BATCH) {
        if (Date.now() > deadlineAt) {
          deadlineHit = true;
          break;
        }
        const r = await c.query(PG_COLUMNS_SQL, [names.slice(i, i + COLUMN_BATCH)]);
        for (const row of r.rows as (PgColumnRow & { table_name: string; column_name: string; is_nullable: string })[]) {
          const list = cols.get(row.table_name) ?? [];
          list.push({ name: row.column_name, type: pgColumnType(row), nullable: row.is_nullable === "YES" });
          cols.set(row.table_name, list);
          if (row.data_type === "USER-DEFINED") typeRefs.push({ table: row.table_name, column: row.column_name, schema: row.type_schema ?? null, name: row.udt_name ?? null });
        }
      }
      const tables: IntroTable[] = [];
      for (const p of picked) {
        const columns = cols.get(p.name);
        if (!columns) continue;
        const partitions = partitionsOf.get(p.name);
        const parents = ancestorsOf.get(p.name);
        tables.push({ name: p.name, columns, rowEstimate: p.est, ...(partitions ? { partitioned: true, partitions } : {}), ...(parents && parents.length > 0 ? { parents } : {}) });
      }
      await sampleJsonKeys("postgres", tables, async (q) => ((await c.query(q)).rows ?? []) as Record<string, unknown>[], { deadlineAt });
      await annotatePgStructuredColumns(tables, typeRefs, async (q, params) => ((await c.query(q, params)).rows ?? []) as Record<string, unknown>[], { deadlineAt });
      return {
        dialect: "postgres",
        database: null,
        tables,
        skippedUnsafeNames: listed.length - safe.length,
        namesSeenTotal: listed.length,
        deadlineHit,
        listingTruncated: safe.length > picked.length,
      };
    });
  }

  return {
    dialect: "postgres",
    database: null,
    test: async () => {
      await inReadOnly(5_000, undefined, async (c) => {
        await c.query("SELECT 1");
      });
    },
    introspect,
    sql,
    mongo: () => {
      throw new DriverUnsupported("MongoDB reads", "Postgres");
    },
    transport: () => transport,
    close: async () => undefined,
  };
}
