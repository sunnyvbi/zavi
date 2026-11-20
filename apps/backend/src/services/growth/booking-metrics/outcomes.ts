
import type { Document } from "mongodb";
import type { ReadSession } from "@/services/data-gateway/session";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { CatalogColumn } from "@/services/tools/operator-db/types";
import type { AmountUnit, BookingEngine, RefundBasis } from "./config";

export type OutcomeMap = {
  engine: BookingEngine;
  booking_source: string;
  date_field: string;
  status_field: string;
  terminal_statuses: string[];
  completed_at_field: string;
  customer_ref_field: string;
  revenue_field: string | null;
  refund_field: string | null;
  refund_basis: RefundBasis;
  amount_unit: AmountUnit;
  currency: string | null;
  confirmed_at: string;
  outcome_confirmed_at: string;
};

export type OutcomeMapResult =
  | { ok: true; map: OutcomeMap }
  | { ok: false; missing: string[]; message: string };

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);

export async function getOutcomeMap(
  tenant_id: string,
  read: (tenant_id: string) => Promise<Row | null> = readOutcomeRow,
): Promise<OutcomeMapResult> {
  const row = await read(tenant_id);
  if (!row || row.state !== "confirmed") {
    return {
      ok: false,
      missing: ["booking_mapping"],
      message:
        "The orders/bookings table is not confirmed yet. The founder confirms it once on the Performance page (booking mapping).",
    };
  }
  const missing: string[] = [];
  const status_field = str(row.status_field);
  const completed_at_field = str(row.completed_at_field);
  const customer_ref_field = str(row.customer_ref_field);
  const terminal = Array.isArray(row.terminal_statuses)
    ? [...new Set((row.terminal_statuses as unknown[]).filter((s): s is string => typeof s === "string" && s.length > 0))]
    : [];
  if (!status_field) missing.push("status_field");
  if (!completed_at_field) missing.push("completed_at_field");
  if (!customer_ref_field) missing.push("customer_ref_field");
  if (terminal.length === 0) missing.push("terminal_statuses");
  const source = str(row.booking_source);
  if (missing.length === 0 && str(row.outcome_basis) !== outcomeBasis(row)) {
    return {
      ok: false,
      missing: ["reconfirm_after_mapping_change"],
      message:
        "The booking mapping (its table, created-at field or status field) changed after the finished-order fields were confirmed. Confirm them again (growth__read_outcome_fields).",
    };
  }
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      message: `Not confirmed yet: ${missing.map(describeMissing).join("; ")}. Propose them with growth__read_outcome_fields and save what the founder confirms.`,
    };
  }
  return {
    ok: true,
    map: {
      engine: row.engine as BookingEngine,
      booking_source: source!,
      date_field: String(row.date_field),
      status_field: status_field!,
      terminal_statuses: terminal,
      completed_at_field: completed_at_field!,
      customer_ref_field: customer_ref_field!,
      revenue_field: str(row.revenue_field),
      refund_field: str(row.refund_field),
      refund_basis: (row.refund_basis as RefundBasis) ?? "none",
      amount_unit: row.amount_unit === "cents" ? "cents" : "dollars",
      currency: str(row.currency)?.toUpperCase() ?? null,
      confirmed_at: String(row.confirmed_at ?? ""),
      outcome_confirmed_at: String(row.outcome_confirmed_at ?? ""),
    },
  };
}

export function outcomeBasis(row: Row): string {
  return [row.engine, row.booking_source, row.date_field, row.status_field]
    .filter((v) => v !== null && v !== undefined)
    .map(String)
    .join("|");
}

export function describeMissing(key: string): string {
  switch (key) {
    case "booking_mapping":
      return "the orders/bookings table";
    case "status_field":
      return "which field holds the order status";
    case "completed_at_field":
      return "which field says when an order finished";
    case "customer_ref_field":
      return "which field says who the customer is";
    case "terminal_statuses":
      return "which status values mean an order finished";
    case "revenue_field":
      return "which field holds the order's revenue";
    case "currency":
      return "the currency the revenue is in";
    default:
      return key;
  }
}

async function readOutcomeRow(tenant_id: string): Promise<Row | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("booking_metric_config")
    .select(
      "tenant_id, engine, booking_source, date_field, status_field, revenue_field, refund_field, refund_basis, currency, amount_unit, state, confirmed_at, completed_at_field, customer_ref_field, terminal_statuses, outcome_basis, outcome_confirmed_at",
    )
    .maybeSingle();
  if (error) throw new Error(`booking outcome map read failed: ${error.message}`);
  return (data as Row | null) ?? null;
}

export function fieldsMissingFromCatalog(map: OutcomeMap, columns: CatalogColumn[], fields: string[]): string[] {
  return fields.filter((f) => !fieldInColumns(map.engine, columns, f));
}

export function fieldInColumns(engine: BookingEngine, columns: CatalogColumn[], field: string): boolean {
  if (columns.some((c) => c.name === field)) return true;
  if (engine !== "mongodb") return false;
  return columns.some((c) => field.startsWith(`${c.name}.`) && /document|object/i.test(c.type));
}

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export function mongoField(name: string): string {
  if (typeof name !== "string" || name.length > 128 || !FIELD_RE.test(name)) {
    throw new Error(`booking outcomes: unsafe field name: ${String(name)}`);
  }
  return name;
}

export function pgIdent(name: string, kind: "column" | "table"): string {
  const part = "[A-Za-z_][A-Za-z0-9_]{0,62}";
  const re = kind === "column" ? new RegExp(`^${part}$`) : new RegExp(`^${part}(?:\\.${part})?$`);
  if (typeof name !== "string" || !re.test(name)) throw new Error(`booking outcomes: bad SQL identifier: ${String(name)}`);
  return name
    .split(".")
    .map((p) => `"${p}"`)
    .join(".");
}

export type OutcomeWindow = { since: Date; until: Date; tz: string };

const asDate = (expr: string): Document => ({ $convert: { input: expr, to: "date", onError: null, onNull: null } });
const asText = (expr: string): Document => ({ $convert: { input: expr, to: "string", onError: null, onNull: null } });
const dayOf = (expr: string, tz: string): Document => ({ $dateToString: { format: "%Y-%m-%d", date: expr, timezone: tz } });
const isNum = (expr: string): Document => ({ $isNumber: expr });

function mongoMoney(map: OutcomeMap): Document {
  const refund =
    map.refund_field && map.refund_basis === "booking_created_net"
      ? { $ifNull: [`$${mongoField(map.refund_field)}`, 0] }
      : { $literal: 0 };
  return { rev: `$${mongoField(map.revenue_field!)}`, ref: refund };
}

export function buildMongoFirstCompletions(map: OutcomeMap, w: OutcomeWindow): Document[] {
  const status = mongoField(map.status_field);
  const comp = mongoField(map.completed_at_field);
  const cust = mongoField(map.customer_ref_field);
  return [
    { $match: { [status]: { $in: map.terminal_statuses }, [comp]: { $ne: null }, [cust]: { $ne: null } } },
    { $project: { _id: 0, c: asText(`$${cust}`), at: asDate(`$${comp}`) } },
    { $match: { at: { $ne: null }, c: { $nin: [null, ""] } } },
    { $group: { _id: "$c", first: { $min: "$at" } } },
    {
      $facet: {
        floor: [{ $group: { _id: null, min: { $min: "$first" } } }],
        days: [
          { $match: { first: { $gte: w.since, $lt: w.until } } },
          { $group: { _id: dayOf("$first", w.tz), n: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
      },
    },
  ];
}

export function buildMongoCompletedRevenue(map: OutcomeMap, w: OutcomeWindow): Document[] {
  const status = mongoField(map.status_field);
  const comp = mongoField(map.completed_at_field);
  return [
    { $match: { [status]: { $in: map.terminal_statuses }, [comp]: { $ne: null } } },
    { $project: { _id: 0, at: asDate(`$${comp}`), ...mongoMoney(map) } },
    { $match: { at: { $gte: w.since, $lt: w.until } } },
    { $addFields: { ok: { $and: [isNum("$rev"), isNum("$ref")] } } },
    {
      $group: {
        _id: dayOf("$at", w.tz),
        orders: { $sum: { $cond: ["$ok", 1, 0] } },
        gross: { $sum: { $cond: ["$ok", "$rev", 0] } },
        refund: { $sum: { $cond: ["$ok", "$ref", 0] } },
        unreadable: { $sum: { $cond: ["$ok", 0, 1] } },
      },
    },
    { $sort: { _id: 1 } },
  ];
}

export const NO_CREATED_DAY = "0001-01-01";

export function buildMongoUnplacedByDay(map: OutcomeMap, tz: string): Document[] {
  const status = mongoField(map.status_field);
  const created = mongoField(map.date_field);
  const comp = mongoField(map.completed_at_field);
  const cust = mongoField(map.customer_ref_field);
  const project: Document = { _id: 0, d: asDate(`$${created}`), at: asDate(`$${comp}`), c: asText(`$${cust}`) };
  const stages: Document[] = [
    { $match: { [status]: { $in: map.terminal_statuses } } },
    { $project: map.revenue_field ? { ...project, ...mongoMoney(map) } : project },
    { $match: { $or: [{ at: null }, { c: { $in: [null, ""] } }] } },
  ];
  const noFinish: Document = { $eq: ["$at", null] };
  const group: Document = {
    _id: { $ifNull: [dayOf("$d", tz), NO_CREATED_DAY] },
    u_cac: { $sum: 1 },
    u_roas: { $sum: { $cond: [noFinish, 1, 0] } },
  };
  if (map.revenue_field) {
    stages.push({ $addFields: { ok: { $and: [isNum("$rev"), isNum("$ref")] } } });
    stages.push({ $addFields: { net: { $cond: ["$ok", { $subtract: ["$rev", "$ref"] }, 0] } } });
    group.pos = { $sum: { $cond: [{ $and: [noFinish, { $gt: ["$net", 0] }] }, "$net", 0] } };
    group.neg = { $sum: { $cond: [{ $and: [noFinish, { $lt: ["$net", 0] }] }, "$net", 0] } };
    group.unr = { $sum: { $cond: [{ $and: [noFinish, { $not: ["$ok"] }] }, 1, 0] } };
  }
  stages.push({ $group: group }, { $sort: { _id: 1 } });
  return stages;
}

function pgRev(map: OutcomeMap): string {
  return `(${pgIdent(map.revenue_field!, "column")})::float8`;
}
function pgRefund(map: OutcomeMap): string {
  return map.refund_field && map.refund_basis === "booking_created_net"
    ? `COALESCE((${pgIdent(map.refund_field, "column")})::float8, 0)`
    : "0::float8";
}

export function buildPgFirstCompletions(map: OutcomeMap): { days: string; floor: string } {
  const t = pgIdent(map.booking_source, "table");
  const status = pgIdent(map.status_field, "column");
  const comp = pgIdent(map.completed_at_field, "column");
  const cust = pgIdent(map.customer_ref_field, "column");
  const firsts = `
    WITH done AS (
      SELECT (${cust})::text AS c, (${comp})::timestamptz AS at
      FROM ${t}
      WHERE (${status})::text = ANY($1::text[]) AND ${comp} IS NOT NULL AND ${cust} IS NOT NULL
    ), firsts AS (
      SELECT c, MIN(at) AS first_at FROM done WHERE c <> '' GROUP BY c
    )`;
  return {
    days: `${firsts}
    SELECT to_char((first_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day, COUNT(*)::float8 AS n
    FROM firsts
    WHERE first_at >= $3::timestamptz AND first_at < $4::timestamptz
    GROUP BY 1 ORDER BY 1 LIMIT ${MAX_DAY_ROWS + 1}`,
    floor: `${firsts}
    SELECT MIN(first_at) AS floor FROM firsts`,
  };
}

export function buildPgCompletedRevenue(map: OutcomeMap): string {
  const t = pgIdent(map.booking_source, "table");
  const status = pgIdent(map.status_field, "column");
  const comp = pgIdent(map.completed_at_field, "column");
  const rev = pgRev(map);
  const ok = `(${rev} IS NOT NULL)`;
  return `
    SELECT to_char(((${comp})::timestamptz AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day,
           SUM(CASE WHEN ${ok} THEN 1 ELSE 0 END)::float8 AS orders,
           COALESCE(SUM(CASE WHEN ${ok} THEN ${rev} ELSE 0 END), 0)::float8 AS gross,
           COALESCE(SUM(CASE WHEN ${ok} THEN ${pgRefund(map)} ELSE 0 END), 0)::float8 AS refund,
           SUM(CASE WHEN ${ok} THEN 0 ELSE 1 END)::float8 AS unreadable
    FROM ${t}
    WHERE (${status})::text = ANY($1::text[]) AND ${comp} IS NOT NULL
      AND (${comp})::timestamptz >= $3::timestamptz AND (${comp})::timestamptz < $4::timestamptz
    GROUP BY 1 ORDER BY 1 LIMIT ${MAX_DAY_ROWS + 1}`;
}

export function buildPgUnplacedByDay(map: OutcomeMap): string {
  const t = pgIdent(map.booking_source, "table");
  const status = pgIdent(map.status_field, "column");
  const created = pgIdent(map.date_field, "column");
  const comp = pgIdent(map.completed_at_field, "column");
  const cust = pgIdent(map.customer_ref_field, "column");
  let money = "";
  if (map.revenue_field) {
    const rev = pgRev(map);
    const net = `(${rev} - ${pgRefund(map)})`;
    money = `,
           COALESCE(SUM(CASE WHEN ${comp} IS NULL AND ${rev} IS NOT NULL AND ${net} > 0 THEN ${net} ELSE 0 END), 0)::float8 AS pos,
           COALESCE(SUM(CASE WHEN ${comp} IS NULL AND ${rev} IS NOT NULL AND ${net} < 0 THEN ${net} ELSE 0 END), 0)::float8 AS neg,
           SUM(CASE WHEN ${comp} IS NULL AND ${rev} IS NULL THEN 1 ELSE 0 END)::float8 AS unr`;
  }
  return `
    SELECT COALESCE(to_char(((${created})::timestamptz AT TIME ZONE $2)::date, 'YYYY-MM-DD'), '${NO_CREATED_DAY}') AS d,
           COUNT(*)::float8 AS u_cac,
           SUM(CASE WHEN ${comp} IS NULL THEN 1 ELSE 0 END)::float8 AS u_roas${money}
    FROM ${t}
    WHERE (${status})::text = ANY($1::text[]) AND (${comp} IS NULL OR ${cust} IS NULL OR (${cust})::text = '')
    GROUP BY 1 ORDER BY 1 LIMIT ${MAX_DAY_ROWS + 1}`;
}

export const MAX_DAY_ROWS = 5000;

function wholeOrThrow<T>(rows: T[], truncated: boolean, what: string): T[] {
  if (truncated || rows.length > MAX_DAY_ROWS) throw new Error(`booking outcomes: ${what} has more than ${MAX_DAY_ROWS} days; refusing a partial history`);
  return rows;
}

export function pgZonelessTimeFields(map: OutcomeMap, columns: Array<{ name: string; type: string }>, fields: string[]): string[] {
  if (map.engine !== "postgres") return [];
  return fields.filter((f) => {
    const t = columns.find((c) => c.name === f)?.type ?? "";
    return !/with time zone|timestamptz/i.test(t);
  });
}

export async function readSourceWatermark(session: ReadSession, map: OutcomeMap): Promise<string> {
  assertEngine(map);
  if (map.engine === "mongodb") {
    const ms = (f: string): Document => ({ $ifNull: [{ $toLong: asDate(`$${mongoField(f)}`) }, 0] });
    const [r] = await session.mongo().aggregate(
      map.booking_source,
      [
        { $match: { [mongoField(map.status_field)]: { $in: map.terminal_statuses } } },
        { $group: { _id: null, n: { $sum: 1 }, f: { $sum: ms(map.completed_at_field) }, c: { $sum: ms(map.date_field) } } },
      ] as Row[],
      MONGO_OPTS,
    );
    return [num(r?.n), num(r?.f), num(r?.c)].join("|");
  }
  const t = pgIdent(map.booking_source, "table");
  const epoch = (f: string) => `COALESCE(SUM(EXTRACT(EPOCH FROM (${pgIdent(f, "column")})::timestamptz)), 0)::float8`;
  const r = await session.query(
    `SELECT COUNT(*)::float8 AS n, ${epoch(map.completed_at_field)} AS f, ${epoch(map.date_field)} AS c FROM ${t} WHERE (${pgIdent(map.status_field, "column")})::text = ANY($1::text[])`,
    [map.terminal_statuses],
  );
  return [num(r.rows[0]?.n), Math.round(num(r.rows[0]?.f) * 1000), Math.round(num(r.rows[0]?.c) * 1000)].join("|");
}

export type UnplacedDay = { d: string; u_cac: number; u_roas: number; pos: number; neg: number; unr: number };

export type UnplacedTotals = { u_cac: number; u_roas: number; pos: number; neg: number; unr: number };

export function unplacedThrough(days: UnplacedDay[], lastDay: string): UnplacedTotals {
  const t: UnplacedTotals = { u_cac: 0, u_roas: 0, pos: 0, neg: 0, unr: 0 };
  for (const d of days) {
    if (d.d > lastDay) continue;
    t.u_cac += d.u_cac;
    t.u_roas += d.u_roas;
    t.pos += d.pos;
    t.neg += d.neg;
    t.unr += d.unr;
  }
  return t;
}

export type FirstCompletions = {
  days: Array<{ date: string; customers: number }>;
  first_seen_floor: string | null;
};
export type CompletedRevenue = {
  days: Array<{ date: string; gross: number; refund: number; orders: number; unreadable: number }>;
};

const MONGO_OPTS = { maxTimeMS: 30_000, allowDiskUse: true, failIfTruncated: true };
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const isoOrNull = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const scaleOf = (map: OutcomeMap) => (map.amount_unit === "cents" ? 100 : 1);

function assertEngine(map: OutcomeMap): void {
  if (map.engine !== "mongodb" && map.engine !== "postgres") throw new UnsupportedEngineError(map.engine);
}

export async function readFirstCompletions(session: ReadSession, map: OutcomeMap, w: OutcomeWindow): Promise<FirstCompletions> {
  assertEngine(map);
  if (map.engine === "mongodb") {
    const [facet] = (await session.mongo().aggregate(map.booking_source, buildMongoFirstCompletions(map, w) as Row[], MONGO_OPTS)) as Array<{
      floor?: Array<{ min?: unknown }>;
      days?: Array<{ _id?: unknown; n?: unknown }>;
    }>;
    wholeOrThrow(facet?.days ?? [], false, "first finishes");
    return {
      days: (facet?.days ?? []).map((r) => ({ date: String(r._id ?? ""), customers: num(r.n) })).filter((r) => r.date),
      first_seen_floor: isoOrNull(facet?.floor?.[0]?.min),
    };
  }
  const q = buildPgFirstCompletions(map);
  const days = await session.query(q.days, [map.terminal_statuses, w.tz, w.since.toISOString(), w.until.toISOString()]);
  wholeOrThrow(days.rows, days.truncated, "first finishes");
  const floor = await session.query(q.floor, [map.terminal_statuses]);
  return {
    days: days.rows.map((r) => ({ date: String(r.day ?? ""), customers: num(r.n) })).filter((r) => r.date),
    first_seen_floor: isoOrNull(floor.rows[0]?.floor),
  };
}

export async function readUnplacedByDay(session: ReadSession, map: OutcomeMap, tz: string): Promise<UnplacedDay[]> {
  assertEngine(map);
  const scale = scaleOf(map);
  const rows =
    map.engine === "mongodb"
      ? (await session.mongo().aggregate(map.booking_source, buildMongoUnplacedByDay(map, tz) as Row[], MONGO_OPTS)).map((r) => ({ ...r, d: r._id }))
      : await (async () => {
          const r = await session.query(buildPgUnplacedByDay(map), [map.terminal_statuses, tz]);
          return wholeOrThrow(r.rows, r.truncated, "unplaced orders");
        })();
  wholeOrThrow(rows, false, "unplaced orders");
  return rows
    .map((r: Row) => ({
      d: String(r.d ?? NO_CREATED_DAY),
      u_cac: num(r.u_cac),
      u_roas: num(r.u_roas),
      pos: num(r.pos) / scale,
      neg: num(r.neg) / scale,
      unr: num(r.unr),
    }))
    .filter((r) => r.d);
}

export async function readCompletedRevenue(session: ReadSession, map: OutcomeMap, w: OutcomeWindow): Promise<CompletedRevenue> {
  if (!map.revenue_field) throw new Error("booking outcomes: no revenue field");
  assertEngine(map);
  const scale = scaleOf(map);
  const rows =
    map.engine === "mongodb"
      ? (await session.mongo().aggregate(map.booking_source, buildMongoCompletedRevenue(map, w) as Row[], MONGO_OPTS)).map((r) => ({ ...r, day: r._id }))
      : await (async () => {
          const r = await session.query(buildPgCompletedRevenue(map), [map.terminal_statuses, w.tz, w.since.toISOString(), w.until.toISOString()]);
          return wholeOrThrow(r.rows, r.truncated, "finished revenue");
        })();
  wholeOrThrow(rows, false, "finished revenue");
  return {
    days: rows
      .map((r: Row) => ({
        date: String(r.day ?? ""),
        gross: num(r.gross) / scale,
        refund: num(r.refund) / scale,
        orders: num(r.orders),
        unreadable: num(r.unreadable),
      }))
      .filter((r) => r.date),
  };
}

export class UnsupportedEngineError extends Error {
  constructor(engine: string) {
    super(`Finished-outcome reads support MongoDB and Postgres, not ${engine} yet.`);
    this.name = "UnsupportedEngineError";
  }
}
