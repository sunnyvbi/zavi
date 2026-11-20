
import type { Document } from "mongodb";
import type { ReadSession } from "@/services/data-gateway/session";
import { mongoField, pgIdent } from "./outcomes";

export type Scalar = string | number | boolean;
export type UtilEngine = "mongodb" | "postgres";
export type KeyFamily = "objectId" | "string" | "number";

export type UtilizationMap = {
  supply_table: string;
  supply_key_field: string;
  location_fields: string[];
  active_field: string | null;
  active_values: Scalar[] | null;
  occupancy_table: string;
  occupancy_unit_field: string;
  occupancy_start_field: string;
  occupancy_end_field: string;
  occupancy_status_field: string | null;
  occupying_values: Scalar[] | null;
};

export const MAX_LOCATIONS = 500;
const DAY_MS = 86_400_000;
const MONGO_OPTS = { maxTimeMS: 30_000, allowDiskUse: true, failIfTruncated: true };

export class DataChangedDuringReadError extends Error {
  constructor() {
    super("active units changed during the read");
    this.name = "DataChangedDuringReadError";
  }
}

export class TooManyLocationsError extends Error {
  constructor() {
    super(`more than ${MAX_LOCATIONS} locations`);
    this.name = "TooManyLocationsError";
  }
}

export function keyFamilyOf(engine: UtilEngine, type: string): KeyFamily | null {
  const t = type.trim();
  if (engine === "mongodb") {
    const parts = t.split("|").filter((p) => p && p !== "Null");
    if (parts.length === 0) return null;
    if (parts.every((p) => p === "ObjectId")) return "objectId";
    if (parts.every((p) => p === "String")) return "string";
    if (parts.every((p) => p === "Int32" || p === "Long")) return "number";
    return null;
  }
  const l = t.toLowerCase();
  if (/^(smallint|integer|bigint|int2|int4|int8|int|serial|bigserial)$/.test(l)) return "number";
  if (/^(text|uuid|citext|character varying|varchar|character|char|bpchar)(\(\d+\))?$/.test(l)) return "string";
  return null;
}

export function isNativeTime(engine: UtilEngine, type: string): boolean {
  if (engine === "mongodb") return type.split("|").filter((p) => p && p !== "Null").join("|") === "Date";
  return /^(timestamp with time zone|timestamptz)$/i.test(type.trim());
}

export function mongoRefConvertible(type: string): boolean {
  const parts = type.split("|").filter((p) => p && p !== "Null");
  return parts.length > 0 && parts.every((p) => p === "ObjectId" || p === "String" || p === "Int32" || p === "Long");
}

const inList = (field: string, values: Scalar[]): Document => ({ [mongoField(field)]: { $in: values } });

function activeMatch(map: UtilizationMap): Document {
  return map.active_field && map.active_values ? inList(map.active_field, map.active_values) : {};
}

function locPart(field: string): Document {
  return { $toLower: { $trim: { input: { $convert: { input: `$${mongoField(field)}`, to: "string", onError: null, onNull: null } } } } };
}

function locTuple(map: UtilizationMap): Document[] {
  return map.location_fields.map(locPart);
}

function convertRef(field: string, family: KeyFamily): Document {
  const to = family === "objectId" ? "objectId" : family === "string" ? "string" : "long";
  return { $convert: { input: `$${mongoField(field)}`, to, onError: null, onNull: null } };
}

const UNION_MS: Document = {
  $let: {
    vars: {
      r: {
        $reduce: {
          input: { $sortArray: { input: "$iv", sortBy: { s: 1 } } },
          initialValue: { end: null, tot: 0 },
          in: {
            $let: {
              vars: {
                from: { $cond: [{ $and: [{ $ne: ["$$value.end", null] }, { $gt: ["$$value.end", "$$this.s"] }] }, "$$value.end", "$$this.s"] },
              },
              in: {
                end: { $cond: [{ $or: [{ $eq: ["$$value.end", null] }, { $gt: ["$$this.e", "$$value.end"] }] }, "$$this.e", "$$value.end"] },
                tot: { $add: ["$$value.tot", { $max: [0, { $subtract: ["$$this.e", "$$from"] }] }] },
              },
            },
          },
        },
      },
    },
    in: "$$r.tot",
  },
};

export function buildMongoSupply(map: UtilizationMap): Document[] {
  const key = mongoField(map.supply_key_field);
  return [
    { $match: activeMatch(map) },
    { $project: { _id: 0, k: `$${key}`, l: locTuple(map) } },
    {
      $facet: {
        locs: [{ $group: { _id: "$l", units: { $sum: 1 } } }, { $sort: { units: -1, _id: 1 } }, { $limit: MAX_LOCATIONS + 2 }],
        keys: [
          { $group: { _id: "$k", n: { $sum: 1 } } },
          {
            $group: {
              _id: null,
              dup: { $sum: { $cond: [{ $gt: ["$n", 1] }, { $subtract: ["$n", 1] }, 0] } },
              nullk: { $sum: { $cond: [{ $eq: ["$_id", null] }, "$n", 0] } },
            },
          },
        ],
      },
    },
  ];
}

export function buildMongoOccupancy(map: UtilizationMap, family: KeyFamily, since: Date, until: Date): Document[] {
  const start = mongoField(map.occupancy_start_field);
  const end = mongoField(map.occupancy_end_field);
  const match: Document = { [start]: { $lt: until }, [end]: { $gt: since } };
  if (map.occupancy_status_field && map.occupying_values) Object.assign(match, inList(map.occupancy_status_field, map.occupying_values));
  return [
    { $match: match },
    {
      $project: {
        _id: 0,
        u: convertRef(map.occupancy_unit_field, family),
        s: { $max: [`$${start}`, { $literal: since }] },
        e: { $min: [`$${end}`, { $literal: until }] },
      },
    },
    { $addFields: { ms: { $subtract: ["$e", "$s"] } } },
    {
      $facet: {
        invalid: [{ $match: { ms: { $lte: 0 } } }, { $count: "n" }],
        nounit: [{ $match: { ms: { $gt: 0 }, u: null } }, { $count: "n" }],
        locs: [
          { $match: { ms: { $gt: 0 }, u: { $ne: null } } },
          { $group: { _id: "$u", iv: { $push: { s: "$s", e: "$e" } }, raw: { $sum: "$ms" } } },
          { $addFields: { booked: UNION_MS } },
          {
            $lookup: {
              from: map.supply_table,
              localField: "_id",
              foreignField: mongoField(map.supply_key_field),
              pipeline: [{ $match: activeMatch(map) }, { $project: { _id: 0, l: locTuple(map) } }],
              as: "x",
            },
          },
          {
            $group: {
              _id: { l: { $arrayElemAt: ["$x.l", 0] }, on: { $gt: [{ $size: "$x" }, 0] } },
              units: { $sum: 1 },
              rows: { $sum: { $size: "$iv" } },
              booked: { $sum: "$booked" },
              raw: { $sum: "$raw" },
            },
          },
          { $sort: { booked: -1 } },
          { $limit: MAX_LOCATIONS + 2 },
        ],
      },
    },
  ];
}

export function buildMongoUndated(map: UtilizationMap): Document[] {
  const match: Document = {
    $or: [{ [mongoField(map.occupancy_start_field)]: { $not: { $type: "date" } } }, { [mongoField(map.occupancy_end_field)]: { $not: { $type: "date" } } }],
  };
  if (map.occupancy_status_field && map.occupying_values) Object.assign(match, inList(map.occupancy_status_field, map.occupying_values));
  return [{ $match: match }, { $count: "n" }];
}

export function buildPgCtes(map: UtilizationMap): { ctes: string; params: (since: Date, until: Date) => unknown[] } {
  const supply = pgIdent(map.supply_table, "table");
  const occ = pgIdent(map.occupancy_table, "table");
  const key = pgIdent(map.supply_key_field, "column");
  const unit = pgIdent(map.occupancy_unit_field, "column");
  const s = pgIdent(map.occupancy_start_field, "column");
  const e = pgIdent(map.occupancy_end_field, "column");
  const loc = `ARRAY[${map.location_fields.map((f) => `COALESCE(lower(trim((${pgIdent(f, "column")})::text)), '')`).join(", ")}]::text[]`;
  let n = 2;
  const activeIdx = map.active_field && map.active_values ? ++n : null;
  const statusIdx = map.occupancy_status_field && map.occupying_values ? ++n : null;
  const activeWhere = activeIdx ? `WHERE (${pgIdent(map.active_field!, "column")})::text = ANY($${activeIdx}::text[])` : "";
  const statusWhere = statusIdx ? `AND (${pgIdent(map.occupancy_status_field!, "column")})::text = ANY($${statusIdx}::text[])` : "";
  const ctes = `
    WITH units AS (
      SELECT (${key})::text AS k, ${loc} AS l FROM ${supply} ${activeWhere}
    ), keyed AS (
      SELECT k, MIN(l) AS l FROM units WHERE k IS NOT NULL GROUP BY k
    ), occ AS (
      SELECT (${unit})::text AS u, GREATEST(${s}, $1::timestamptz) AS s, LEAST(${e}, $2::timestamptz) AS e
      FROM ${occ}
      WHERE ${s} < $2::timestamptz AND ${e} > $1::timestamptz ${statusWhere}
    ), valid AS (
      SELECT u, s, e FROM occ WHERE e > s AND u IS NOT NULL
    ), swept AS (
      SELECT u, s, e, MAX(e) OVER (PARTITION BY u ORDER BY s, e ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_end
      FROM valid
    ), per_unit AS (
      SELECT u, COUNT(*) AS rows,
             SUM(GREATEST(0, EXTRACT(EPOCH FROM (e - GREATEST(s, COALESCE(prev_end, s)))))) * 1000 AS booked,
             SUM(EXTRACT(EPOCH FROM (e - s))) * 1000 AS raw
      FROM swept GROUP BY u
    )`;
  const values = (vals: Scalar[] | null) => (vals ?? []).map(String);
  return {
    ctes,
    params: (since, until) => {
      const p: unknown[] = [since.toISOString(), until.toISOString()];
      if (activeIdx) p.push(values(map.active_values));
      if (statusIdx) p.push(values(map.occupying_values));
      return p;
    },
  };
}

export function buildPgLocations(map: UtilizationMap): string {
  return `${buildPgCtes(map).ctes}
    SELECT kd.l AS l, COUNT(*)::float8 AS units,
           COALESCE(SUM(p.booked), 0)::float8 AS booked, COALESCE(SUM(p.raw), 0)::float8 AS raw,
           COALESCE(SUM(p.rows), 0)::float8 AS rows
    FROM keyed kd LEFT JOIN per_unit p ON p.u = kd.k
    GROUP BY kd.l ORDER BY 2 DESC, 1 LIMIT ${MAX_LOCATIONS + 2}`;
}

export function buildPgCoverage(map: UtilizationMap): string {
  const occ = pgIdent(map.occupancy_table, "table");
  const s = pgIdent(map.occupancy_start_field, "column");
  const e = pgIdent(map.occupancy_end_field, "column");
  const { ctes } = buildPgCtes(map);
  const statusIdx = map.active_field && map.active_values ? 4 : 3;
  const statusWhere = map.occupancy_status_field && map.occupying_values ? `AND (${pgIdent(map.occupancy_status_field, "column")})::text = ANY($${statusIdx}::text[])` : "";
  return `${ctes}
    SELECT
      (SELECT COUNT(*) FROM units WHERE k IS NULL)::float8 AS null_keys,
      (SELECT COUNT(*) FROM units WHERE k IS NOT NULL)::float8 - (SELECT COUNT(*) FROM keyed)::float8 AS dup_keys,
      (SELECT COUNT(*) FROM occ WHERE e <= s)::float8 AS invalid,
      (SELECT COUNT(*) FROM occ WHERE u IS NULL AND e > s)::float8 AS nounit,
      (SELECT COUNT(*) FROM per_unit p WHERE NOT EXISTS (SELECT 1 FROM keyed kd WHERE kd.k = p.u))::float8 AS off_units,
      (SELECT COALESCE(SUM(p.rows), 0) FROM per_unit p WHERE NOT EXISTS (SELECT 1 FROM keyed kd WHERE kd.k = p.u))::float8 AS off_rows,
      (SELECT COALESCE(SUM(p.booked), 0) FROM per_unit p WHERE NOT EXISTS (SELECT 1 FROM keyed kd WHERE kd.k = p.u))::float8 AS off_booked,
      (SELECT COUNT(*) FROM ${occ} WHERE (${s} IS NULL OR ${e} IS NULL) ${statusWhere})::float8 AS undated`;
}

export type LocationRow = {
  location: Record<string, string | null>;
  label: string;
  units: number;
  capacity_unit_days: number;
  booked_unit_days: number;
  occupancy: number;
  double_booked_unit_days: number;
  occupying_rows: number;
};

export type Coverage = {
  units_without_location: number;
  booked_unit_days_without_location: number;
  duplicate_unit_keys: number;
  units_without_key: number;
  rows_on_units_not_active_today: number;
  unit_days_on_units_not_active_today: number;
  rows_without_unit: number;
  rows_end_not_after_start: number;
  rows_without_dates: number | null;
};

export type UtilizationResult = {
  window: { since: string; until: string; days: number };
  locations: LocationRow[];
  location_count: number;
  totals: { units: number; capacity_unit_days: number; booked_unit_days: number; occupancy: number | null; double_booked_unit_days: number };
  coverage: Coverage;
};

type Agg = { units: number; booked: number; raw: number; rows: number };

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function tupleOf(v: unknown, width: number): string[] {
  const arr = Array.isArray(v) ? v : [];
  return Array.from({ length: width }, (_, i) => (typeof arr[i] === "string" ? (arr[i] as string) : ""));
}

export function shapeResult(args: {
  map: UtilizationMap;
  since: Date;
  until: Date;
  supply: Map<string, number>;
  booked: Map<string, Omit<Agg, "units">>;
  coverage: Omit<Coverage, "units_without_location" | "booked_unit_days_without_location">;
  limit: number;
}): UtilizationResult {
  const { map, since, until } = args;
  const windowMs = until.getTime() - since.getTime();
  const days = windowMs / DAY_MS;
  const rows: LocationRow[] = [];
  let unlocatedUnits = 0;
  let unlocatedBooked = 0;
  const totals = { units: 0, booked: 0, raw: 0 };
  for (const [key, units] of args.supply) {
    const tuple = JSON.parse(key) as string[];
    const b = args.booked.get(key) ?? { booked: 0, raw: 0, rows: 0 };
    totals.units += units;
    totals.booked += b.booked;
    totals.raw += b.raw;
    if (tuple.every((p) => p === "")) {
      unlocatedUnits += units;
      unlocatedBooked += b.booked;
      continue;
    }
    const capacity = units * windowMs;
    const location: Record<string, string | null> = {};
    map.location_fields.forEach((f, i) => (location[f] = tuple[i] ? tuple[i]! : null));
    rows.push({
      location,
      label: tuple.map((p) => p || "(blank)").join(" / "),
      units,
      capacity_unit_days: r2(capacity / DAY_MS),
      booked_unit_days: r2(b.booked / DAY_MS),
      occupancy: r3(capacity > 0 ? b.booked / capacity : 0),
      double_booked_unit_days: r2(Math.max(0, b.raw - b.booked) / DAY_MS),
      occupying_rows: b.rows,
    });
  }
  let strayRows = 0;
  let strayBooked = 0;
  for (const [key, b] of args.booked) {
    if (args.supply.has(key)) continue;
    strayRows += b.rows;
    strayBooked += b.booked;
  }
  rows.sort((a, b) => b.occupancy - a.occupancy || b.units - a.units || a.label.localeCompare(b.label));
  const capacityAll = totals.units * windowMs;
  return {
    window: { since: since.toISOString(), until: until.toISOString(), days: r2(days) },
    locations: rows.slice(0, args.limit),
    location_count: rows.length,
    totals: {
      units: totals.units,
      capacity_unit_days: r2(capacityAll / DAY_MS),
      booked_unit_days: r2(totals.booked / DAY_MS),
      occupancy: capacityAll > 0 ? r3(totals.booked / capacityAll) : null,
      double_booked_unit_days: r2(Math.max(0, totals.raw - totals.booked) / DAY_MS),
    },
    coverage: {
      ...args.coverage,
      rows_on_units_not_active_today: args.coverage.rows_on_units_not_active_today + strayRows,
      unit_days_on_units_not_active_today: r2(args.coverage.unit_days_on_units_not_active_today + strayBooked / DAY_MS),
      units_without_location: unlocatedUnits,
      booked_unit_days_without_location: r2(unlocatedBooked / DAY_MS),
    },
  };
}

export async function readUtilization(
  session: ReadSession,
  engine: UtilEngine,
  map: UtilizationMap,
  family: KeyFamily,
  w: { since: Date; until: Date; limit: number },
): Promise<UtilizationResult> {
  const width = map.location_fields.length;
  const supply = new Map<string, number>();
  const booked = new Map<string, Omit<Agg, "units">>();
  let coverage: Omit<Coverage, "units_without_location" | "booked_unit_days_without_location">;
  if (engine === "mongodb") {
    const mongo = session.mongo();
    type SupplyDoc = { locs?: Array<{ _id?: unknown; units?: unknown }>; keys?: Array<{ dup?: unknown; nullk?: unknown }> };
    type OccDoc = {
      invalid?: Array<{ n?: unknown }>;
      nounit?: Array<{ n?: unknown }>;
      locs?: Array<{ _id?: { l?: unknown; on?: unknown }; units?: unknown; rows?: unknown; booked?: unknown; raw?: unknown }>;
    };
    const readSupply = async () => ((await mongo.aggregate(map.supply_table, buildMongoSupply(map), MONGO_OPTS)) as SupplyDoc[])[0];
    let s: SupplyDoc | undefined;
    let o: OccDoc | undefined;
    for (let attempt = 0; ; attempt++) {
      s = await readSupply();
      o = ((await mongo.aggregate(map.occupancy_table, buildMongoOccupancy(map, family, w.since, w.until), MONGO_OPTS)) as OccDoc[])[0];
      const after = await readSupply();
      if (JSON.stringify(after) === JSON.stringify(s)) break;
      if (attempt >= 1) throw new DataChangedDuringReadError();
    }
    const locs = s?.locs ?? [];
    if (locs.length > MAX_LOCATIONS + 1) throw new TooManyLocationsError();
    for (const r of locs) supply.set(JSON.stringify(tupleOf(r._id, width)), num(r.units));
    let offRows = 0;
    let offBooked = 0;
    for (const r of o?.locs ?? []) {
      if (r._id?.on !== true) {
        offRows += num(r.rows);
        offBooked += num(r.booked);
        continue;
      }
      booked.set(JSON.stringify(tupleOf(r._id.l, width)), { booked: num(r.booked), raw: num(r.raw), rows: num(r.rows) });
    }
    let undated: number | null = null;
    try {
      const [u] = await mongo.aggregate(map.occupancy_table, buildMongoUndated(map), { maxTimeMS: 15_000, failIfTruncated: true });
      undated = num(u?.n);
    } catch {
      undated = null;
    }
    coverage = {
      duplicate_unit_keys: num(s?.keys?.[0]?.dup),
      units_without_key: num(s?.keys?.[0]?.nullk),
      rows_on_units_not_active_today: offRows,
      unit_days_on_units_not_active_today: r2(offBooked / DAY_MS),
      rows_without_unit: num(o?.nounit?.[0]?.n),
      rows_end_not_after_start: num(o?.invalid?.[0]?.n),
      rows_without_dates: undated,
    };
  } else {
    const { params } = buildPgCtes(map);
    const p = params(w.since, w.until);
    const locs = await session.query(buildPgLocations(map), p, { maxRows: MAX_LOCATIONS + 2 });
    if (locs.truncated || locs.rows.length > MAX_LOCATIONS + 1) throw new TooManyLocationsError();
    for (const r of locs.rows) {
      const key = JSON.stringify(tupleOf(r.l, width));
      supply.set(key, num(r.units));
      booked.set(key, { booked: num(r.booked), raw: num(r.raw), rows: num(r.rows) });
    }
    const cov = (await session.query(buildPgCoverage(map), p)).rows[0] ?? {};
    coverage = {
      duplicate_unit_keys: num(cov.dup_keys),
      units_without_key: num(cov.null_keys),
      rows_on_units_not_active_today: num(cov.off_rows),
      unit_days_on_units_not_active_today: r2(num(cov.off_booked) / DAY_MS),
      rows_without_unit: num(cov.nounit),
      rows_end_not_after_start: num(cov.invalid),
      rows_without_dates: num(cov.undated),
    };
  }
  if (supply.size > MAX_LOCATIONS + 1) throw new TooManyLocationsError();
  return shapeResult({ map, since: w.since, until: w.until, supply, booked, coverage, limit: w.limit });
}

export function mapFieldsByTable(map: UtilizationMap): Array<{ table: string; fields: string[] }> {
  return [
    {
      table: map.supply_table,
      fields: [map.supply_key_field, ...map.location_fields, ...(map.active_field ? [map.active_field] : [])],
    },
    {
      table: map.occupancy_table,
      fields: [
        map.occupancy_unit_field,
        map.occupancy_start_field,
        map.occupancy_end_field,
        ...(map.occupancy_status_field ? [map.occupancy_status_field] : []),
      ],
    },
  ];
}

