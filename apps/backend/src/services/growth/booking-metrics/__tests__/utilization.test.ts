import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { effectivePolicy, guardMongoAggregate, guardSql } from "@zavi/shared/db-guard";
import {
  buildMongoOccupancy,
  buildMongoSupply,
  buildMongoUndated,
  buildPgCoverage,
  buildPgLocations,
  isNativeTime,
  keyFamilyOf,
  mongoRefConvertible,
  readUtilization,
  shapeResult,
  TooManyLocationsError,
  DataChangedDuringReadError,
  MAX_LOCATIONS,
  type UtilizationMap,
} from "../utilization";
import { EXPECT, MAP, ROWS, UNITS, W_SINCE, W_UNTIL, day } from "./utilization-fixture";
import { openPglite, pgSession, type Pg } from "./pglite";

const col = (name: string, type: string) => ({ name, type, nullable: true });
const ROW = { auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] };

const MONGO_MAP: UtilizationMap = { ...MAP, supply_key_field: "_id", occupancy_unit_field: "unitRef", occupancy_start_field: "period.start", occupancy_end_field: "period.end" };
const MONGO_CATALOG = {
  tables: [
    { name: "units", rowEstimate: 6, columns: [col("_id", "ObjectId"), col("city", "String"), col("region", "String"), col("state", "String"), col("owner", "String")] },
    { name: "stays", rowEstimate: 9, columns: [col("unitRef", "String"), col("period", "Document"), col("period.start", "Date"), col("period.end", "Date"), col("status", "String")] },
  ],
};
const PG_CATALOG = {
  tables: [
    { name: "units", rowEstimate: 6, columns: ["id", "city", "region", "state"].map((n) => col(n, "text")) },
    { name: "stays", rowEstimate: 9, columns: ["unit_id", "starts_at", "ends_at", "status"].map((n) => col(n, "text")) },
  ],
};

describe("occupancy queries pass the database guard", () => {
  const mongoPolicy = effectivePolicy(ROW, MONGO_CATALOG, "mongodb");
  it.each([
    ["supply", "units", buildMongoSupply(MONGO_MAP)],
    ["occupancy (objectId keys)", "stays", buildMongoOccupancy(MONGO_MAP, "objectId", W_SINCE, W_UNTIL)],
    ["occupancy (number keys)", "stays", buildMongoOccupancy(MONGO_MAP, "number", W_SINCE, W_UNTIL)],
    ["occupancy (no status, no active field)", "stays", buildMongoOccupancy({ ...MONGO_MAP, occupancy_status_field: null, occupying_values: null, active_field: null, active_values: null }, "string", W_SINCE, W_UNTIL)],
    ["undated rows", "stays", buildMongoUndated(MONGO_MAP)],
  ])("MongoDB: %s", (_l, coll, pipeline) => {
    const g = guardMongoAggregate(coll, pipeline, { policy: mongoPolicy });
    expect(g.ok, JSON.stringify(g)).toBe(true);
  });

  it("a hidden location field is refused by the guard, not read", () => {
    const policy = effectivePolicy({ ...ROW, hidden_fields: ["units.city"] }, MONGO_CATALOG, "mongodb");
    expect(guardMongoAggregate("units", buildMongoSupply(MONGO_MAP), { policy }).ok).toBe(false);
  });

  const pgPolicy = effectivePolicy(ROW, PG_CATALOG, "postgres");
  it.each([
    ["locations", buildPgLocations(MAP)],
    ["coverage", buildPgCoverage(MAP)],
    ["locations, no filters", buildPgLocations({ ...MAP, active_field: null, active_values: null, occupancy_status_field: null, occupying_values: null })],
  ])("Postgres: %s", (_l, sql) => {
    const g = guardSql(sql, { policy: pgPolicy, dialect: "postgres" });
    expect(g.ok, JSON.stringify(g)).toBe(true);
  });

  it("a field name that is not a plain path never reaches a query", () => {
    expect(() => buildMongoSupply({ ...MONGO_MAP, location_fields: ["$where"] })).toThrow(/unsafe field/);
    expect(() => buildPgLocations({ ...MAP, occupancy_start_field: 'x"; drop table y;--' })).toThrow(/bad SQL identifier/);
  });
});

describe("type families", () => {
  it("classifies unit ids and refuses mixed or non-id types", () => {
    expect(keyFamilyOf("mongodb", "ObjectId")).toBe("objectId");
    expect(keyFamilyOf("mongodb", "String|Null")).toBe("string");
    expect(keyFamilyOf("mongodb", "Int32|Long")).toBe("number");
    expect(keyFamilyOf("mongodb", "String|ObjectId")).toBeNull();
    expect(keyFamilyOf("mongodb", "Double")).toBeNull();
    expect(keyFamilyOf("postgres", "uuid")).toBe("string");
    expect(keyFamilyOf("postgres", "bigint")).toBe("number");
    expect(keyFamilyOf("postgres", "character varying(36)")).toBe("string");
    expect(keyFamilyOf("postgres", "numeric")).toBeNull();
    expect(mongoRefConvertible("String|ObjectId")).toBe(true);
    expect(mongoRefConvertible("Array")).toBe(false);
  });
  it("accepts only zone-safe native times", () => {
    expect(isNativeTime("mongodb", "Date")).toBe(true);
    expect(isNativeTime("mongodb", "Date|String")).toBe(false);
    expect(isNativeTime("postgres", "timestamp with time zone")).toBe(true);
    expect(isNativeTime("postgres", "timestamp without time zone")).toBe(false);
  });
});

describe("shaping", () => {
  const coverage = { duplicate_unit_keys: 0, units_without_key: 0, rows_on_units_not_active_today: 0, unit_days_on_units_not_active_today: 0, rows_without_unit: 0, rows_end_not_after_start: 0, rows_without_dates: 0 };
  it("ranks by occupancy, then units; keeps unlocated units out of the ranking but in the totals", () => {
    const D = 86_400_000;
    const out = shapeResult({
      map: MAP,
      since: W_SINCE,
      until: W_UNTIL,
      supply: new Map([
        [JSON.stringify(["a", "x"]), 2],
        [JSON.stringify(["b", ""]), 4],
        [JSON.stringify(["", ""]), 1],
      ]),
      booked: new Map([
        [JSON.stringify(["a", "x"]), { booked: 12 * D, raw: 14 * D, rows: 3 }],
        [JSON.stringify(["b", ""]), { booked: 20 * D, raw: 20 * D, rows: 2 }],
        [JSON.stringify(["", ""]), { booked: 1 * D, raw: 1 * D, rows: 1 }],
      ]),
      coverage,
      limit: 25,
    });
    expect(out.locations.map((l) => l.label)).toEqual(["a / x", "b / (blank)"]);
    expect(out.locations[0]).toMatchObject({ units: 2, occupancy: 0.6, double_booked_unit_days: 2, location: { city: "a", region: "x" } });
    expect(out.locations[1]!.location).toEqual({ city: "b", region: null });
    expect(out.totals).toMatchObject({ units: 7, booked_unit_days: 33, capacity_unit_days: 70 });
    expect(out.coverage.units_without_location).toBe(1);
  });
});

describe("shaping: booked time on a place the supply read did not see", () => {
  it("is counted with units not active today, never dropped", () => {
    const D = 86_400_000;
    const out = shapeResult({
      map: MAP,
      since: W_SINCE,
      until: W_UNTIL,
      supply: new Map([[JSON.stringify(["a", "x"]), 1]]),
      booked: new Map([[JSON.stringify(["z", "y"]), { booked: 3 * D, raw: 3 * D, rows: 2 }]]),
      coverage: { duplicate_unit_keys: 0, units_without_key: 0, rows_on_units_not_active_today: 1, unit_days_on_units_not_active_today: 1, rows_without_unit: 0, rows_end_not_after_start: 0, rows_without_dates: 0 },
      limit: 25,
    });
    expect(out.coverage).toMatchObject({ rows_on_units_not_active_today: 3, unit_days_on_units_not_active_today: 4 });
    expect(out.totals.booked_unit_days).toBe(0);
  });
});

describe("MongoDB reads are checked against a changing supply", () => {
  const OCC = [{ invalid: [], nounit: [], locs: [] }];
  function session(supplies: unknown[][]) {
    const calls: string[] = [];
    let i = 0;
    return {
      calls,
      s: {
        dialect: "mongodb",
        mongo: () => ({
          aggregate: async (coll: string) => {
            calls.push(coll);
            if (coll === "units") return supplies[Math.min(i++, supplies.length - 1)];
            return OCC;
          },
        }),
      } as never,
    };
  }
  const A = [{ locs: [{ _id: ["a", "x"], units: 2 }], keys: [{ dup: 0, nullk: 0 }] }];
  const B = [{ locs: [{ _id: ["a", "x"], units: 3 }], keys: [{ dup: 0, nullk: 0 }] }];
  it("uses a read whose supply was the same before and after the occupancy read", async () => {
    const { s } = session([A, B, B, B]);
    const out = await readUtilization(s, "mongodb", MAP, "string", { since: W_SINCE, until: W_UNTIL, limit: 25 });
    expect(out.totals.units).toBe(3);
  });
  it("refuses when supply changed during both attempts", async () => {
    const { s } = session([A, B, A, B]);
    await expect(readUtilization(s, "mongodb", MAP, "string", { since: W_SINCE, until: W_UNTIL, limit: 25 })).rejects.toBeInstanceOf(DataChangedDuringReadError);
  });
});

describe.skipIf(!process.env.CI && !process.env.PGLITE_DIR)("occupancy on Postgres (PGlite)", () => {
  let db: Pg;
  beforeAll(async () => {
    db = (await openPglite())!;
    await db.exec(`
      create table units (id text, city text, region text, state text);
      create table stays (unit_id text, starts_at timestamptz, ends_at timestamptz, status text);
    `);
    for (const u of UNITS) await db.query("insert into units values ($1, $2, $3, $4)", [u.id, u.city, u.region, u.state]);
    for (const r of ROWS) await db.query("insert into stays values ($1, $2, $3, $4)", [r.unit, day(r.s).toISOString(), day(r.e).toISOString(), r.status]);
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("gives the hand-computed occupancy, totals and coverage", async () => {
    const out = await readUtilization(pgSession(db), "postgres", MAP, "string", { since: W_SINCE, until: W_UNTIL, limit: 25 });
    expect(out.locations.map((l) => l.label)).toEqual(["south / east", "north / east"]);
    expect(out.locations[0]).toMatchObject(EXPECT.south);
    expect(out.locations[1]).toMatchObject(EXPECT.north);
    expect(out.totals).toMatchObject(EXPECT.totals);
    expect(out.coverage).toMatchObject({ ...EXPECT.coverage, rows_without_dates: 0 });
  });

  it("refuses a result with more locations than it may hold", async () => {
    const many = await openPglite();
    await many!.exec("create table units (id text, city text, region text, state text); create table stays (unit_id text, starts_at timestamptz, ends_at timestamptz, status text);");
    await many!.exec(`insert into units select 'k' || g, 'c' || g, 'r', 'live' from generate_series(1, ${MAX_LOCATIONS + 5}) g`);
    await expect(readUtilization(pgSession(many!), "postgres", MAP, "string", { since: W_SINCE, until: W_UNTIL, limit: 25 })).rejects.toBeInstanceOf(TooManyLocationsError);
    await many!.close();
  }, 60_000);
});
