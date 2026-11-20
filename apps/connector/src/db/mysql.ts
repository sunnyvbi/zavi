import { sampleJsonKeys } from "@zavi/shared/db-guard";
import type { Readable } from "node:stream";
import { createConnection, type Connection, type ConnectionOptions } from "mysql2/promise";
import { clampStatementTimeoutMs, inlineMysqlLimitParams, mysqlPlaceholderProblem } from "@zavi/shared/db-guard";
import { COLUMN_BATCH, CONNECT_TIMEOUT_MS, DriverUnsupported, SAFE_NAME, TABLE_CAP, type Driver, type IntroColumn, type IntroTable, type Introspection, type SqlRunOptions, type SqlRunResult } from "./types";

type MysqlConn = Pick<Connection, "query" | "end" | "destroy">;
export type MysqlFactory = (opts: ConnectionOptions) => Promise<MysqlConn>;
type StreamableCore = { execute(sql: string, values?: unknown[]): { stream(options?: { highWaterMark?: number }): Readable } };

const defaultFactory: MysqlFactory = (opts) => createConnection(opts);

export function mysqlDatabaseOf(uri: string): string | null {
  try {
    const db = decodeURIComponent(new URL(uri).pathname.replace(/^\//, "").split("/")[0] ?? "");
    return db || null;
  } catch {
    return null;
  }
}

export async function applyStatementTimeout(conn: MysqlConn, raw: number): Promise<"mysql" | "mariadb" | "none"> {
  const ms = clampStatementTimeoutMs(raw);
  try {
    await conn.query(`SET SESSION MAX_EXECUTION_TIME = ${Math.round(ms)}`);
    return "mysql";
  } catch {
    try {
      await conn.query(`SET SESSION max_statement_time = ${ms / 1000}`);
      return "mariadb";
    } catch {
      return "none";
    }
  }
}

const LOOPBACK = (h: string) => h === "" || h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);

export function mysqlTls(uri: string): { ssl?: { rejectUnauthorized: boolean }; transport: "verified_tls" | "unverified_tls" | "plaintext" } {
  let host = "";
  let sslParam: string | null = null;
  try {
    const u = new URL(uri);
    host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    sslParam = u.searchParams.get("ssl");
  } catch {
    return { ssl: { rejectUnauthorized: false }, transport: "unverified_tls" };
  }
  if (sslParam !== null) {
    if (/^(false|0)$/i.test(sslParam.trim())) return { transport: "plaintext" };
    return { transport: /rejectUnauthorized"?\s*:\s*false/i.test(sslParam) ? "unverified_tls" : "verified_tls" };
  }
  if (LOOPBACK(host)) return { transport: "plaintext" };
  return { ssl: { rejectUnauthorized: false }, transport: "unverified_tls" };
}

export const MYSQL_NO_TLS_MESSAGE =
  "This database didn't offer an encrypted connection. If it's on a trusted local network, add ssl=false to the connection string.";

export function openMysql(uri: string, factory: MysqlFactory = defaultFactory): Driver {
  const database = mysqlDatabaseOf(uri);
  const tls = mysqlTls(uri);

  async function inReadOnly<T>(timeoutMs: number, o: { timeZone?: string; utcOffset?: boolean }, fn: (c: MysqlConn) => Promise<T>): Promise<T> {
    const conn = await connect();
    let broken = false;
    try {
      await applyStatementTimeout(conn, timeoutMs);
      if (o.utcOffset) await conn.query("SET time_zone = '+00:00'");
      if (o.timeZone) await conn.query("SET time_zone = ?", [o.timeZone]).catch(() => undefined);
      await conn.query("START TRANSACTION READ ONLY");
      return await fn(conn);
    } catch (e) {
      broken = true;
      throw e;
    } finally {
      if (broken) conn.destroy();
      else {
        await conn.query("ROLLBACK").catch(() => undefined);
        await conn.end().catch(() => conn.destroy());
      }
    }
  }

  async function connect(): Promise<MysqlConn> {
    try {
      return await factory({
        uri,
        ...(tls.ssl ? { ssl: tls.ssl } : {}),
        connectTimeout: CONNECT_TIMEOUT_MS,
        multipleStatements: false,
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
      });
    } catch (e) {
      if (tls.ssl && /does not support secure connection/i.test(String((e as Error)?.message ?? ""))) throw new Error(MYSQL_NO_TLS_MESSAGE);
      throw e;
    }
  }

  const sql = (text: string, params: unknown[], opts: SqlRunOptions): Promise<SqlRunResult> =>
    inReadOnly(opts.timeoutMs, opts, async (conn) => {
      const problem = mysqlPlaceholderProblem(text, params.length);
      if (problem) throw new Error(problem);
      const prepared = inlineMysqlLimitParams(text, params);
      const core = (conn as unknown as { connection: StreamableCore }).connection;
      const stream = core.execute(prepared.sql, prepared.params.map((v) => (v === undefined ? null : v))).stream({ highWaterMark: 64 });
      const got: Record<string, unknown>[] = [];
      let fields: string[] | null = null;
      stream.on("fields", (f: { name: string }[]) => {
        fields = f.map((x) => x.name);
      });
      let cut = false;
      try {
        for await (const row of stream) {
          got.push(row as Record<string, unknown>);
          if (got.length > opts.maxRows) {
            cut = true;
            break;
          }
        }
      } finally {
        if (!stream.destroyed) stream.destroy();
      }
      if (cut) throw Object.assign(new CutEarly(), { result: { got, fields } });
      return { columns: fields ?? Object.keys(got[0] ?? {}), rows: got, truncated: false };
    }).catch((e: unknown) => {
      if (e instanceof CutEarly) {
        const { got, fields } = (e as CutEarly & { result: { got: Record<string, unknown>[]; fields: string[] | null } }).result;
        return { columns: fields ?? Object.keys(got[0] ?? {}), rows: got.slice(0, opts.maxRows), truncated: true };
      }
      throw e;
    });

  async function introspect(deadlineAt: number): Promise<Introspection> {
    return inReadOnly(5_000, {}, async (conn) => {
      const [tRows] = await conn.query({
        sql: `SELECT table_name AS n, table_rows AS est FROM information_schema.tables
               WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name`,
        timeout: 5_000,
      });
      const listed = (tRows as { n: string; est: number | string | null }[]).map((r) => ({ name: String(r.n), est: r.est == null ? null : Number(r.est) }));
      const safe = listed.filter((r) => SAFE_NAME.test(r.name));
      const picked = safe.slice(0, TABLE_CAP);
      const cols = new Map<string, IntroColumn[]>();
      let deadlineHit = false;
      for (let i = 0; i < picked.length; i += COLUMN_BATCH) {
        if (Date.now() > deadlineAt) {
          deadlineHit = true;
          break;
        }
        const chunk = picked.slice(i, i + COLUMN_BATCH).map((p) => p.name);
        const [cRows] = await conn.query({
          sql: `SELECT table_name AS tbl, column_name AS name, data_type AS type, is_nullable AS nullable FROM information_schema.columns
                 WHERE table_schema = DATABASE() AND table_name IN (${chunk.map(() => "?").join(",")}) ORDER BY table_name, ordinal_position`,
          values: chunk,
          timeout: 5_000,
        });
        for (const c of cRows as { tbl: string; name: string; type: string; nullable: string }[]) {
          const list = cols.get(String(c.tbl)) ?? [];
          list.push({ name: String(c.name), type: String(c.type), nullable: String(c.nullable).toUpperCase() === "YES" });
          cols.set(String(c.tbl), list);
        }
      }
      const tables: IntroTable[] = [];
      for (const p of picked) {
        const columns = cols.get(p.name);
        if (columns) tables.push({ name: p.name, columns, rowEstimate: p.est });
      }
      await sampleJsonKeys("mysql", tables, async (q) => (await conn.query({ sql: q, timeout: 5_000 }))[0] as Record<string, unknown>[], { deadlineAt, database });
      return { dialect: "mysql", database, tables, skippedUnsafeNames: listed.length - safe.length, namesSeenTotal: listed.length, deadlineHit, listingTruncated: safe.length > picked.length };
    });
  }

  return {
    dialect: "mysql",
    database,
    test: async () => {
      await inReadOnly(5_000, {}, async (c) => {
        await c.query("SELECT 1");
      });
    },
    introspect,
    sql,
    mongo: () => {
      throw new DriverUnsupported("MongoDB reads", "MySQL");
    },
    transport: () => tls.transport,
    close: async () => undefined,
  };
}

class CutEarly extends Error {}
