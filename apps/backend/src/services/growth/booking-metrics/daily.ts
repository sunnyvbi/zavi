
import type { Document } from "mongodb";
import { withReadSession, type ReadSession } from "@/services/data-gateway";
import { ExpectedToolError } from "@/services/tools/types";
import type { BookingMetricConfig } from "./config";

const CALLER = { kind: "background" as const, feature: "Booking metrics" };

const SKIP_CODES = new Set([
  "operator_db_not_connected",
  "operator_db_not_discovered",
  "operator_db_secret_missing",
  "connector_not_ready",
  "connector_offline",
  "connector_timeout",
  "connector_busy",
  "connector_read_failed",
  "connector_invalid_result",
  "data_access_refused",
]);

export type BookingDailyRow = {
  date: string;
  bookings: number;
  revenue_native: number | null;
};

export type OperatorBookingsDaily = {
  rows: BookingDailyRow[];
  currency: string | null;
};

function safeField(name: string): string {
  if (typeof name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(name)) {
    throw new Error(`booking-metrics: unsafe field name: ${String(name)}`);
  }
  return name;
}

function ident(name: string): string {
  if (
    typeof name !== "string" ||
    !/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?$/.test(name)
  ) {
    throw new Error(`booking-metrics: bad SQL identifier: ${String(name)}`);
  }
  return name;
}

function mysqlIdent(name: string): string {
  const validated = ident(name);
  return validated
    .split(".")
    .map((p) => `\`${p}\``)
    .join(".");
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function fetchOperatorBookingsDaily(
  tenant_id: string,
  cfg: BookingMetricConfig,
  opts: { sinceIso: string; untilIso: string },
): Promise<OperatorBookingsDaily | null> {
  const since = new Date(`${opts.sinceIso}T00:00:00Z`);
  const until = new Date(`${opts.untilIso}T00:00:00Z`);
  if (cfg.engine !== "mongodb" && cfg.engine !== "postgres" && cfg.engine !== "mysql") {
    return null;
  }
  try {
    return await withReadSession(
      { tenant_id, caller: CALLER },
      async (session) => {
        if (cfg.engine === "mongodb") return fetchMongo(session, cfg, since, until);
        if (cfg.engine === "postgres") return fetchPostgres(session, cfg, opts.sinceIso, opts.untilIso);
        return fetchMysql(session, cfg, opts.sinceIso, opts.untilIso);
      },
      { statementTimeoutMs: MYSQL_STMT_TIMEOUT_MS, utcOffsetSession: cfg.engine === "mysql" },
    );
  } catch (e) {
    if (e instanceof ExpectedToolError && SKIP_CODES.has(e.code)) return null;
    throw e;
  }
}

export function buildMongoPipeline(
  cfg: BookingMetricConfig,
  since: Date,
  until: Date,
): Document[] {
  const dateField = safeField(cfg.date_field);
  const match: Document = { [dateField]: { $gte: since, $lt: until } };
  if (cfg.status_field && cfg.completed_statuses.length > 0) {
    match[safeField(cfg.status_field)] = { $in: cfg.completed_statuses };
  }

  const group: Document = {
    _id: {
      $dateToString: {
        format: "%Y-%m-%d",
        date: `$${dateField}`,
        timezone: cfg.reporting_timezone,
      },
    },
    bookings: { $sum: 1 },
  };
  if (cfg.revenue_field) {
    const revField = safeField(cfg.revenue_field);
    const base: Document = { $ifNull: [`$${revField}`, 0] };
    const revExpr: Document =
      cfg.refund_field && cfg.refund_basis === "booking_created_net"
        ? { $subtract: [base, { $ifNull: [`$${safeField(cfg.refund_field)}`, 0] }] }
        : base;
    group.revenue = { $sum: revExpr };
  }

  const pipeline: Document[] = [{ $match: match }, { $group: group }];
  if (cfg.revenue_field && cfg.amount_unit === "cents") {
    pipeline.push({ $addFields: { revenue: { $divide: ["$revenue", 100] } } });
  }
  if (cfg.revenue_field) {
    pipeline.push({ $addFields: { revenue: { $max: ["$revenue", 0] } } });
  }
  pipeline.push({ $sort: { _id: 1 } }, { $limit: 400 });
  return pipeline;
}

async function fetchMongo(
  session: ReadSession,
  cfg: BookingMetricConfig,
  since: Date,
  until: Date,
): Promise<OperatorBookingsDaily> {
  const pipeline = buildMongoPipeline(cfg, since, until);
  const raw = (await session
    .mongo()
    .aggregate(cfg.booking_source, pipeline as Record<string, unknown>[], { maxTimeMS: 8000 })) as Array<{
    _id?: string;
    bookings?: unknown;
    revenue?: unknown;
  }>;
  const rows: BookingDailyRow[] = raw.map((r) => ({
    date: String(r._id ?? ""),
    bookings: round2(num(r.bookings)),
    revenue_native: cfg.revenue_field ? round2(num(r.revenue)) : null,
  }));
  return { rows, currency: cfg.currency };
}

export function buildPostgresRevenueSelect(cfg: BookingMetricConfig): string {
  if (!cfg.revenue_field) return "NULL::float8 AS revenue";
  const revCol = ident(cfg.revenue_field);
  const sumExpr =
    cfg.refund_field && cfg.refund_basis === "booking_created_net"
      ? `SUM(COALESCE(${revCol},0) - COALESCE(${ident(cfg.refund_field)},0))`
      : `SUM(COALESCE(${revCol},0))`;
  const scaled = cfg.amount_unit === "cents" ? `(${sumExpr}) / 100.0` : sumExpr;
  return `COALESCE(GREATEST(${scaled}, 0),0)::float8 AS revenue`;
}

async function fetchPostgres(
  session: ReadSession,
  cfg: BookingMetricConfig,
  sinceIso: string,
  untilIso: string,
): Promise<OperatorBookingsDaily> {
  const table = ident(cfg.booking_source);
  const dateCol = ident(cfg.date_field);

  const revenueSelect = buildPostgresRevenueSelect(cfg);

  const params: unknown[] = [cfg.reporting_timezone, sinceIso, untilIso];
  let statusClause = "";
  if (cfg.status_field && cfg.completed_statuses.length > 0) {
    params.push(cfg.completed_statuses);
    statusClause = `AND ${ident(cfg.status_field)} = ANY($4)`;
  }

  const sql = `
    SELECT to_char((${dateCol} AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day,
           COUNT(*)::float8 AS bookings,
           ${revenueSelect}
    FROM ${table}
    WHERE ${dateCol} >= $2::timestamptz AND ${dateCol} < $3::timestamptz
      ${statusClause}
    GROUP BY 1
    ORDER BY 1
    LIMIT 400
  `;

  const res = await session.query(sql, params);
  const rows: BookingDailyRow[] = res.rows.map((r: Record<string, unknown>) => ({
    date: String(r.day ?? ""),
    bookings: round2(num(r.bookings)),
    revenue_native: cfg.revenue_field ? round2(num(r.revenue)) : null,
  }));
  return { rows, currency: cfg.currency };
}

const MYSQL_STMT_TIMEOUT_MS = 8000;

export type MysqlTzMode = "named" | "utc";

export function buildMysqlRevenueSelect(cfg: BookingMetricConfig): string {
  if (!cfg.revenue_field) return "NULL AS revenue";
  const revCol = mysqlIdent(cfg.revenue_field);
  const sumExpr =
    cfg.refund_field && cfg.refund_basis === "booking_created_net"
      ? `SUM(COALESCE(${revCol},0) - COALESCE(${mysqlIdent(cfg.refund_field)},0))`
      : `SUM(COALESCE(${revCol},0))`;
  const scaled = cfg.amount_unit === "cents" ? `(${sumExpr}) / 100.0` : sumExpr;
  return `COALESCE(GREATEST(${scaled}, 0),0) AS revenue`;
}

export function buildMysqlDailyQuery(
  cfg: BookingMetricConfig,
  tzMode: MysqlTzMode,
  sinceIso: string,
  untilIso: string,
): { sql: string; params: string[] } {
  const table = mysqlIdent(cfg.booking_source);
  const dateCol = mysqlIdent(cfg.date_field);
  const revenueSelect = buildMysqlRevenueSelect(cfg);
  const params: string[] = [];

  let dayExpr: string;
  if (tzMode === "named") {
    dayExpr = `DATE_FORMAT(CONVERT_TZ(${dateCol}, '+00:00', ?), '%Y-%m-%d')`;
    params.push(cfg.reporting_timezone);
  } else {
    dayExpr = `DATE_FORMAT(${dateCol}, '%Y-%m-%d')`;
  }

  params.push(`${sinceIso} 00:00:00`, `${untilIso} 00:00:00`);

  let statusClause = "";
  if (cfg.status_field && cfg.completed_statuses.length > 0) {
    const placeholders = cfg.completed_statuses.map(() => "?").join(", ");
    statusClause = `AND ${mysqlIdent(cfg.status_field)} IN (${placeholders})`;
    params.push(...cfg.completed_statuses);
  }

  const sql = `
    SELECT ${dayExpr} AS day,
           COUNT(*) AS bookings,
           ${revenueSelect}
    FROM ${table}
    WHERE ${dateCol} >= ? AND ${dateCol} < ?
      ${statusClause}
    GROUP BY 1
    ORDER BY 1
    LIMIT 400
  `;
  return { sql, params };
}

export function isUtcZone(tz: string): boolean {
  return !tz || tz === "UTC" || tz === "Etc/UTC" || tz === "+00:00" || tz === "Z";
}

export type MysqlTzResolution = MysqlTzMode | "unsupported";

export type MysqlQueryFn = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
export async function resolveMysqlTzMode(q: MysqlQueryFn, tz: string): Promise<MysqlTzResolution> {
  if (isUtcZone(tz)) return "utc";
  try {
    const arr = await q("SELECT CONVERT_TZ('2020-06-01 12:00:00','+00:00',?) AS c", [tz]);
    return arr[0] && arr[0].c != null ? "named" : "unsupported";
  } catch {
    return "unsupported";
  }
}

async function fetchMysql(
  session: ReadSession,
  cfg: BookingMetricConfig,
  sinceIso: string,
  untilIso: string,
): Promise<OperatorBookingsDaily | null> {
  const q: MysqlQueryFn = async (sql, params) => (await session.query(sql, params)).rows;
  const resolution = await resolveMysqlTzMode(q, cfg.reporting_timezone);
  if (resolution === "unsupported") {
    return null;
  }
  const { sql, params } = buildMysqlDailyQuery(cfg, resolution, sinceIso, untilIso);
  const arr = await q(sql, params);
  const out: BookingDailyRow[] = arr.map((r) => ({
    date: String(r.day ?? ""),
    bookings: round2(num(r.bookings)),
    revenue_native: cfg.revenue_field ? round2(num(r.revenue)) : null,
  }));
  return { rows: out, currency: cfg.currency };
}
