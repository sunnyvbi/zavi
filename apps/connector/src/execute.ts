import { EJSON, type Document } from "bson";
import {
  MAX_CELL_CHARS,
  MAX_COLS,
  MAX_DEPTH,
  MAX_PARENTS,
  MAX_RESULT_BYTES,
  parseConnectorResult,
  stripHiddenColumns,
  stripJsonInRows,
  suppressSmallGroups,
  type ConnectorResult,
  type Policy,
} from "@zavi/shared/db-guard";
import type { Checked } from "./check";
import type { Driver, Introspection } from "./db/types";
import type { WhatCanLeave } from "./rules";

type Cell = string | number | boolean | null;
const ENVELOPE_BYTES = 200;
const BUDGET = MAX_RESULT_BYTES - ENVELOPE_BYTES;

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

function clip(s: string): string {
  return s.length > MAX_CELL_CHARS ? s.slice(0, MAX_CELL_CHARS - 1) + "…" : s;
}

export function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return clip(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
  if (typeof v === "boolean") return v;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return clip("base64:" + Buffer.from(v).toString("base64"));
  try {
    return clip(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)) ?? String(v));
  } catch {
    return clip(String(v));
  }
}

export function wireDoc(doc: unknown): unknown {
  const ej = EJSON.serialize(doc as Document, { relaxed: true }) as unknown;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return clip(v);
    if (v === null || typeof v !== "object") return v;
    if (depth >= MAX_DEPTH - 1) return "[nested too deep]";
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x, depth + 1);
    return o;
  };
  return walk(ej, 0);
}

function fitRows<T>(items: T[], make: (n: number) => unknown): number {
  if (bytes(make(items.length)) <= BUDGET) return items.length;
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(make(mid)) <= BUDGET) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function rowsResult(columns: string[], rawRows: Record<string, unknown>[], truncated: boolean, removed: string[], rule: WhatCanLeave): ConnectorResult {
  if (columns.length > MAX_COLS) return { status: "failed", reason: `The result has ${columns.length} columns; the connector sends at most ${MAX_COLS}. Select fewer columns.` };
  const long = columns.find((c) => c.length > 128);
  if (long) return { status: "failed", reason: "A result column name is longer than 128 characters. Alias it to a shorter name." };
  const rows = rawRows.map((r) => columns.map((c) => toCell(r[c])));
  const make = (n: number): ConnectorResult => ({
    status: "done",
    data: { kind: "rows", columns, rows: rows.slice(0, n), truncated: truncated || n < rows.length, removed_columns: removed.slice(0, MAX_COLS).map((c) => c.slice(0, 128)), rule },
  });
  return make(fitRows(rows, make));
}

export function describeResult(intro: Introspection, policy: Policy | null): ConnectorResult {
  const tables = intro.tables
    .filter((t) => policy !== null && policy.isAllowed(t.name, true))
    .map((t) => ({
      name: t.name,
      columns: t.columns.filter((c) => !policy!.isHidden(t.name, c.name)).map((c) => ({
          name: c.name,
          type: c.type.slice(0, 128),
          nullable: c.nullable,
          ...(c.json_keys && c.json_keys.length > 0 ? { json_keys: c.json_keys.slice(0, 200).filter((k) => k.length <= 64) } : {}),
          ...(c.json_sampled ? { json_sampled: c.json_sampled } : {}),
          ...(c.json_map_like ? { json_map_like: true } : {}),
        })),
      rowEstimate: t.rowEstimate,
      ...(t.partitioned
        ? { partitioned: true, partitions: (t.partitions ?? []).filter((p) => policy!.isAllowed(p, true)).slice(0, 1000) }
        : {}),
      ...(t.parents && t.parents.length > 0 ? { parents: t.parents.slice(0, MAX_PARENTS) } : {}),
    }));
  const make = (n: number): ConnectorResult => ({
    status: "done",
    data: {
      kind: "describe",
      introspection: {
        dialect: intro.dialect,
        tables: tables.slice(0, n),
        skippedUnsafeNames: 0,
        namesSeenTotal: tables.length,
        deadlineHit: intro.deadlineHit,
        listingTruncated: n < tables.length,
      },
    },
  });
  return make(fitRows(tables, make));
}

function flattenGroup(r: Document): Record<string, unknown> {
  if (!("_id" in r)) return r;
  const { _id, ...rest } = r;
  return _id && typeof _id === "object" && !Array.isArray(_id) && !(_id instanceof Date) ? { ...(_id as Record<string, unknown>), ...rest } : rest;
}

const columnsOf = (rows: Record<string, unknown>[]) => {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
};

export type ExecDeps = { driver: Driver; intro: Introspection };

export async function execute(c: Extract<Checked, { ok: true }>, d: ExecDeps): Promise<ConnectorResult> {
  const result = await run(c, d);
  const check = parseConnectorResult(result);
  if (!check.ok) return { status: "failed", reason: `The connector's result did not fit the protocol: ${check.reason}`.slice(0, 500) };
  return result;
}

async function run(c: Extract<Checked, { ok: true }>, d: ExecDeps): Promise<ConnectorResult> {
  if (c.kind === "describe") return describeResult(d.intro, c.policy);

  if (c.kind === "sql") {
    const r = await d.driver.sql(c.text, c.params, { maxRows: c.maxRows, timeoutMs: c.timeoutMs, timeZone: c.timeZone, utcOffset: c.utcOffset });
    const hiddenLc = new Set(c.hidden.map((h) => h.toLowerCase()));
    const columns = r.columns.filter((col) => !hiddenLc.has(col.toLowerCase()));
    const removed = c.hidden;
    const rows = stripJsonInRows(stripHiddenColumns(r.rows, c.hidden), { policy: c.policy, tables: c.tables, hidden: c.hidden, passthrough: c.passthrough, structured: c.structured, fieldNames: r.columns });
    return rowsResult(columns, rows, r.truncated, removed, c.rule);
  }

  if (c.kind === "summary") {
    const cs = c.compiled;
    const raw =
      cs.kind === "sql"
        ? (await d.driver.sql(cs.text, cs.params, { maxRows: c.limit, timeoutMs: c.timeoutMs })).rows
        : ((await d.driver.mongo().aggregate(cs.collection, cs.pipeline, c.limit, Math.min(c.timeoutMs, 30_000))).docs as Record<string, unknown>[]);
    const rows = stripJsonInRows(suppressSmallGroups(raw.map((r) => flattenGroup(r as Document))), {
      policy: c.policy,
      tables: [c.table],
      hidden: c.policy.hiddenFields(c.table),
    });
    return rowsResult(columnsOf(rows), rows, false, [], c.rule);
  }

  const m = d.driver.mongo();
  const docsDone = (docs: Document[], truncated: boolean): ConnectorResult => {
    const wire = docs.map((x) => wireDoc(c.strip(x)));
    const make = (n: number): ConnectorResult => ({
      status: "done",
      data: { kind: "docs", docs: wire.slice(0, n), truncated: truncated || n < wire.length, removed_columns: c.hidden.slice(0, MAX_COLS).map((h) => h.slice(0, 128)), rule: c.rule },
    });
    return make(fitRows(wire, make));
  };
  switch (c.action) {
    case "find":
    case "findOne": {
      const r = await m.find(c.collection, c.filter, c.options, c.maxRows, c.maxTimeMS);
      return docsDone(r.docs, c.action === "findOne" ? false : r.truncated);
    }
    case "aggregate": {
      const r = await m.aggregate(c.collection, c.pipeline, c.maxRows, c.maxTimeMS, c.options.allowDiskUse === true);
      return docsDone(r.docs, r.truncated);
    }
    case "countDocuments":
      return { status: "done", data: { kind: "count", count: Math.max(0, Math.floor(await m.countDocuments(c.collection, c.filter, c.options.limit as number | undefined, c.maxTimeMS))) } };
    case "estimatedDocumentCount":
      return { status: "done", data: { kind: "count", count: Math.max(0, Math.floor(await m.estimatedDocumentCount(c.collection, c.maxTimeMS))) } };
    case "listCollections": {
      const list = (await m.listCollections(c.maxTimeMS)).filter((x) => c.policy.resolve(x.name, true) !== null).slice(0, c.maxRows);
      return docsDone(list.map((x) => ({ name: x.name, ...(x.type ? { type: x.type } : {}) })), false);
    }
  }
}
