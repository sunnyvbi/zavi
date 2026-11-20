import type { Readable } from "node:stream";
import { Client, types as pgTypes } from "pg";
import { createConnection } from "mysql2/promise";
import { inlineMysqlLimitParams, mysqlPlaceholderProblem } from "@zavi/shared/db-guard";
import { pgSslOption } from "@/services/tools/operator-db/pg-ssl";
import { applyMysqlStatementTimeout } from "@/services/tools/operator-db/mysql-session";
import { isValidTimeZone } from "@/services/analytics/metric-time";
import { ExpectedToolError } from "@/services/tools/types";
import type { ReadSession, SqlDialect, SqlQueryOptions, SqlResult } from "../session";

export const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;

export type SqlSessionOptions = {
  timeZone?: string;
  statementTimeoutMs?: number;
  int8AsNumber?: boolean;
  utcOffsetSession?: boolean;
};

const SAFE_TZ = /^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2})$/;
export function safeSessionTimeZone(tz: unknown): string | null {
  return isValidTimeZone(tz) && SAFE_TZ.test(tz) ? tz : null;
}

export function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;\s*$/, "");
}

const unsupported = (op: string, dialect: string) =>
  new ExpectedToolError("operator_db_unsupported_dialect", `${op} is not available on a ${dialect} database.`);

export async function openSqlSession(dialect: SqlDialect, connectionString: string, opts: SqlSessionOptions = {}): Promise<ReadSession> {
  return dialect === "postgres" ? openPostgres(connectionString, opts) : openMysql(connectionString, opts);
}

async function openPostgres(connectionString: string, opts: SqlSessionOptions): Promise<ReadSession> {
  const timeout = Math.max(100, Math.round(opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS));
  const client = new Client({
    connectionString,
    ssl: pgSslOption(connectionString),
    statement_timeout: timeout,
    query_timeout: timeout,
    connectionTimeoutMillis: 8000,
    ...(opts.int8AsNumber
      ? {
          types: {
            getTypeParser: ((oid: number, format?: unknown) =>
              oid === 20
                ? (v: string | null) => (v === null ? null : Number(v))
                : (pgTypes.getTypeParser as (o: number, f?: unknown) => unknown)(oid, format)) as never,
          },
        }
      : {}),
  });
  await client.connect();
  let sessionTz: string | undefined;
  let seq = 0;
  let closed = false;
  try {
    const tz = safeSessionTimeZone(opts.timeZone);
    if (tz) {
      try {
        await client.query("SELECT set_config('TimeZone', $1, false)", [tz]);
        sessionTz = tz;
      } catch {
        sessionTz = undefined;
      }
    }
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${timeout}`);
    await client.query("SET LOCAL search_path = pg_catalog, pg_temp");
  } catch (e) {
    await client.end().catch(() => undefined);
    throw e;
  }

  const query = async (text: string, params: unknown[] = [], qopts: SqlQueryOptions = {}): Promise<SqlResult> => {
    if (closed) throw new ExpectedToolError("operator_db_session_closed", "The database session is closed.");
    const sp = `_zavi_sp_${++seq}`;
    await client.query(`SAVEPOINT ${sp}`);
    try {
      let rows: Record<string, unknown>[];
      let fields: { name: string; dataTypeID?: number }[];
      let truncated = false;
      if (qopts.maxRows !== undefined) {
        const max = Math.max(1, Math.floor(qopts.maxRows));
        const cursor = `_zavi_cur_${seq}`;
        await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${stripTrailingSemicolon(text)}`, params);
        const r = await client.query(`FETCH FORWARD ${max + 1} FROM ${cursor}`);
        await client.query(`CLOSE ${cursor}`).catch(() => undefined);
        const got = (r.rows ?? []) as Record<string, unknown>[];
        truncated = got.length > max;
        rows = truncated ? got.slice(0, max) : got;
        fields = (r.fields ?? []).map((f: { name: string; dataTypeID?: number }) => ({ name: f.name, dataTypeID: f.dataTypeID }));
      } else {
        const r = await client.query(text, params);
        rows = (r.rows ?? []) as Record<string, unknown>[];
        fields = (r.fields ?? []).map((f: { name: string; dataTypeID?: number }) => ({ name: f.name, dataTypeID: f.dataTypeID }));
      }
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      return { rows, fields, truncated };
    } catch (e) {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => undefined);
      throw e;
    }
  };

  return {
    dialect: "postgres",
    query,
    mongo: () => {
      throw unsupported("Mongo reads", "Postgres");
    },
    dynamo: () => {
      throw unsupported("DynamoDB reads", "Postgres");
    },
    sessionTimeZone: () => sessionTz,
    largestTableRows: async (names: string[]) => {
      if (names.length === 0) return null;
      try {
        const r = await query(
          "SELECT max(c.reltuples)::float8 AS n FROM pg_class c WHERE c.oid IN (SELECT to_regclass(x) FROM unnest($1::text[]) AS x)",
          [names.slice(0, 12)],
        );
        const n = Number((r.rows[0] as { n?: unknown } | undefined)?.n);
        return Number.isFinite(n) && n > 0 ? n : null;
      } catch {
        return null;
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end().catch(() => undefined);
    },
  };
}

type MysqlConn = Awaited<ReturnType<typeof createConnection>>;
type StreamableCore = {
  execute(sql: string, values?: unknown[]): { stream(options?: { highWaterMark?: number }): Readable };
};
function coreOf(conn: MysqlConn): StreamableCore {
  return (conn as unknown as { connection: StreamableCore }).connection;
}

async function openMysql(connectionString: string, opts: SqlSessionOptions): Promise<ReadSession> {
  const timeout = Math.max(100, Math.round(opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS));
  const tz = safeSessionTimeZone(opts.timeZone);
  let sessionTz: string | undefined;
  let closed = false;

  const open = async (): Promise<MysqlConn> => {
    const c = await createConnection(connectionString);
    try {
      await applyMysqlStatementTimeout((sql) => c.query(sql), timeout);
      if (opts.utcOffsetSession) await c.query("SET time_zone = '+00:00'");
      if (tz) {
        try {
          await c.query("SET time_zone = ?", [tz]);
          sessionTz = tz;
        } catch {
          sessionTz = undefined;
        }
      }
      await c.query("START TRANSACTION READ ONLY");
      return c;
    } catch (e) {
      await c.end().catch(() => undefined);
      throw e;
    }
  };
  let conn = await open();

  const query = async (text: string, params: unknown[] = [], qopts: SqlQueryOptions = {}): Promise<SqlResult> => {
    if (closed) throw new ExpectedToolError("operator_db_session_closed", "The database session is closed.");
    const problem = mysqlPlaceholderProblem(text, params.length);
    if (problem) throw new ExpectedToolError("operator_db_bad_placeholders", problem);
    const prepared = inlineMysqlLimitParams(text, params);
    const sql = prepared.sql;
    const values = prepared.params.map((v) => (v === undefined ? null : v));
    if (qopts.maxRows === undefined) {
      const [rows, fields] = await conn.execute(sql, values as never[]);
      return {
        rows: (Array.isArray(rows) ? rows : []) as Record<string, unknown>[],
        fields: ((fields ?? []) as { name: string }[]).map((f) => ({ name: f.name })),
        truncated: false,
      };
    }
    const max = Math.max(1, Math.floor(qopts.maxRows));
    const stream = coreOf(conn).execute(sql, values).stream({ highWaterMark: 256 });
    const got: Record<string, unknown>[] = [];
    let cutEarly = false;
    try {
      for await (const row of stream) {
        got.push(row as Record<string, unknown>);
        if (got.length > max) {
          cutEarly = true;
          break;
        }
      }
    } finally {
      if (!stream.destroyed) stream.destroy();
    }
    if (cutEarly) {
      conn.destroy();
      conn = await open();
    }
    const truncated = got.length > max;
    const rows = truncated ? got.slice(0, max) : got;
    return { rows, fields: Object.keys(rows[0] ?? {}).map((name) => ({ name })), truncated };
  };

  return {
    dialect: "mysql",
    query,
    mongo: () => {
      throw unsupported("Mongo reads", "MySQL");
    },
    dynamo: () => {
      throw unsupported("DynamoDB reads", "MySQL");
    },
    sessionTimeZone: () => sessionTz,
    largestTableRows: async () => null,
    close: async () => {
      if (closed) return;
      closed = true;
      await conn.query("ROLLBACK").catch(() => undefined);
      await conn.end().catch(() => undefined);
    },
  };
}
