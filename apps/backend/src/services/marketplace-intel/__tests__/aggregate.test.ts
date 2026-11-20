import { describe, expect, it } from "vitest";
import {
  assembleIntel,
  assertReadOnlyMongo,
  computeMongoRollup,
  MONGO_DATE_SAMPLE_ROWS,
  MONGO_ROLLUP_MAX_TIME_MS,
  regionKeyOf,
  regionMappingOf,
  rollupFromKeyedRows,
  type GeoWeekRawRow,
  type SupplyRawRow,
} from "../aggregate";
import type { GeoWeekCell, MarketplaceIntelConfig, SupplySnapshot } from "../contract";
import { MAX_ROWS_PER_READ } from "@zavi/shared/db-guard";
import { buildRegionIndex, MARKETPLACE_TOTAL_REGION, NO_LOCATION_REGION, OTHER_REGION } from "../regions";

const TENANT = "00000000-0000-4000-8000-000000000001";

const goodsConfig: MarketplaceIntelConfig = {
  tenant_id: TENANT,
  dialect: "mongodb",
  location_source: "order",
  supply_source: "listings",
  bookings: {
    table: "orders",
    created_at_field: "created_at",
    geo_field: "city",
    listing_ref_field: null,
    seller_ref_field: null,
    buyer_ref_field: null,
    gmv_proxy_field: null,
  },
  listings: { table: "items", id_field: "_id", geo_field: "city", listed_at_field: null },
  location_table: null,
  category: { source: "none_on_trips", note: "test" },
  intent_events: { search: null, view: null, contact: null },
  provenance: { source: "self_serve_confirmed", validated: true },
};

type ReadKind = "dates" | "locations" | "weeks" | "supply" | "totalweeks" | "totalsupply";

function readKindOf(pipeline: unknown[]): ReadKind {
  const json = JSON.stringify(pipeline);
  if (json.includes('"unreadable"')) return "dates";
  if (json.includes('"$limit":300')) return "locations";
  const perRegion = json.includes("__zavi_key");
  if (json.includes('"$isoWeek"')) return perRegion ? "weeks" : "totalweeks";
  return perRegion ? "supply" : "totalsupply";
}

function fakeDb(rows: Partial<Record<`${string}:${ReadKind}`, unknown[]>>) {
  const calls: Array<{ collection: string; kind: ReadKind; pipeline: unknown[]; options?: unknown }> = [];
  return {
    calls,
    collection(name: string) {
      return {
        aggregate<T = unknown>(pipeline: unknown[], options?: unknown) {
          const kind = readKindOf(pipeline);
          calls.push({ collection: name, kind, pipeline, options });
          return {
            async toArray(): Promise<T[]> {
              return (rows[`${name}:${kind}`] ?? []) as T[];
            },
          };
        },
      };
    },
  };
}

function rollupFromRaw(
  geoRows: GeoWeekRawRow[],
  supplyRows: SupplyRawRow[],
  config: MarketplaceIntelConfig,
) {
  const locations = [
    ...geoRows.map((r) => ({ raw: r.geo, weight: r.bookings_n ?? 0 })),
    ...supplyRows.map((r) => ({ raw: r.geo, weight: r.count ?? 0 })),
  ];
  const index = buildRegionIndex(locations);
  const keyOf = new Map(regionMappingOf(locations, index).map((m) => [m.raw, m.key]));
  const key = (raw: unknown) => keyOf.get(raw) ?? NO_LOCATION_REGION;
  const weeks = new Map<string, GeoWeekRawRow>();
  for (const r of geoRows) {
    const id = `${key(r.geo)}|${r.isoWeekYear}|${r.isoWeek}`;
    const prev = weeks.get(id);
    weeks.set(id, prev ? { ...prev, bookings_n: (prev.bookings_n ?? 0) + (r.bookings_n ?? 0) } : { ...r, geo: key(r.geo) });
  }
  const supply = new Map<string, SupplyRawRow>();
  for (const r of supplyRows) {
    const prev = supply.get(key(r.geo));
    supply.set(key(r.geo), prev ? { ...prev, count: (prev.count ?? 0) + (r.count ?? 0) } : { ...r, geo: key(r.geo) });
  }
  return rollupFromKeyedRows([...weeks.values()], [...supply.values()], config, index, {
    demand_basis: "bookings",
    min_cell: 5,
  });
}

function orders(city: string, isoWeek: number, bookings_n: number): GeoWeekRawRow {
  return {
    geo: city,
    isoWeekYear: 2026,
    isoWeek,
    bookings_n,
    active_supply_n: bookings_n,
    active_supply_ids: Array.from({ length: bookings_n }, (_, i) => `${city}-${isoWeek}-${i}`),
    gmv_proxy_n: null,
  };
}

function cell(overrides: Partial<GeoWeekCell>): GeoWeekCell {
  return {
    tenant_id: TENANT,
    state: null,
    geo_label: "Lagos",
    week_start: "2026-06-01",
    bookings_n: 0,
    active_supply_n: 0,
    gmv_proxy_n: null,
    demand_basis: "bookings",
    supply_basis: "booked_listings",
    confidence: "medium",
    suppressed: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<SupplySnapshot>): SupplySnapshot {
  return {
    tenant_id: TENANT,
    state: null,
    geo_label: "Lagos",
    total_listings: 0,
    completed_listings: 0,
    basis: "listing_status",
    confidence: "medium",
    as_of: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("rollup from region-keyed rows (shared by Mongo and SQL)", () => {
  it("keeps non-US places as their own regions and joins their supply", () => {
    const { cells, supply } = rollupFromRaw(
      [orders("Lagos", 24, 20), orders("Nairobi", 24, 10), orders("lagos ", 25, 16)],
      [
        { geo: "Lagos", status: "__all__", count: 40 },
        { geo: "Nairobi", status: "__all__", count: 40 },
        { geo: "Kampala", status: "__all__", count: 40 },
      ],
      goodsConfig,
    );
    expect(cells.every((c) => c.state === null)).toBe(true);
    expect(new Set(cells.map((c) => c.geo_label))).toEqual(new Set(["Lagos", "Nairobi"]));
    expect(supply.map((s) => s.geo_label).sort()).toEqual(["Kampala", "Lagos", "Nairobi"]);
    expect(cells.find((c) => c.week_start === "2026-06-15")).toMatchObject({ geo_label: "Lagos", bookings_n: 16 });
  });

  it("never files a foreign place under a US state", () => {
    const { cells } = rollupFromRaw(
      [orders("Berlin, DE", 24, 9), orders("Toronto, CA", 24, 9), orders("Mumbai, IN", 24, 9)],
      [],
      { ...goodsConfig, supply_source: "none", listings: null },
    );
    expect(cells.map((c) => c.state)).toEqual([null, null, null]);
    expect(cells.map((c) => c.geo_label).sort()).toEqual(["Berlin, DE", "Mumbai, IN", "Toronto, CA"]);
  });

  it("groups clearly-American data by state across orders (cities) and listings (state codes)", () => {
    const { cells, supply } = rollupFromRaw(
      [orders("Austin, TX", 24, 30), orders("Houston", 24, 12), orders("Denver", 24, 20)],
      [
        { geo: "TX", status: "__all__", count: 50 },
        { geo: "CO", status: "__all__", count: 25 },
      ],
      goodsConfig,
    );
    expect(cells.find((c) => c.state === "TX")).toMatchObject({ geo_label: "Texas", bookings_n: 42 });
    expect(supply.find((s) => s.state === "TX")).toMatchObject({ geo_label: "Texas", total_listings: 50 });
    expect(regionKeyOf(cells.find((c) => c.state === "TX")!)).toBe(regionKeyOf(supply.find((s) => s.state === "TX")!));
  });

  it("puts blank locations under No location", () => {
    const { cells } = rollupFromRaw(
      [orders("", 24, 7), orders("Accra", 24, 7)],
      [],
      goodsConfig,
    );
    expect(cells.find((c) => c.geo_label === NO_LOCATION_REGION)?.bookings_n).toBe(7);
  });
});

describe("computeMongoRollup", () => {
  it("reads orders and listings read-only and never references a status path without a status field", async () => {
    const db = fakeDb({
      "orders:dates": [{ present: 8, unreadable: 0 }],
      "orders:locations": [{ _id: "Lagos", n: 8 }],
      "items:locations": [{ _id: "Lagos", n: 12 }],
      "orders:weeks": [{ ...orders("lagos", 24, 8) }],
      "items:supply": [{ geo: "lagos", status: "__all__", count: 12 }],
      "items:totalsupply": [{ n: 12 }],
    });
    const { cells, supply } = await computeMongoRollup(db, goodsConfig, { window_weeks: 13, min_cell: 5 });
    expect(cells[0]).toMatchObject({ geo_label: "Lagos", bookings_n: 8, week_start: "2026-06-08" });
    expect(supply[0]).toMatchObject({ geo_label: "Lagos", completed_listings: 12 });
    expect(db.calls.map((c) => `${c.collection}:${c.kind}`)).toEqual([
      "orders:dates", "orders:locations", "items:locations", "orders:weeks", "items:supply",
      "items:totalsupply",
    ]);
    expect(db.calls.every((c) => JSON.stringify(c.options) === JSON.stringify({ maxTimeMS: MONGO_ROLLUP_MAX_TIME_MS, allowDiskUse: true, failIfTruncated: true }))).toBe(true);
    const weeks = JSON.stringify(db.calls[3]?.pipeline);
    expect(weeks).toContain("$isoWeekYear");
    expect(weeks).toContain(`{"case":{"$in":["$__zavi_geo",{"$literal":["Lagos"]}]},"then":{"$literal":"lagos"}}`);
    expect(JSON.stringify(db.calls[4]?.pipeline)).toContain("$literal");
    expect(JSON.stringify(db.calls[4]?.pipeline)).not.toContain("$null");
  });

  it("fails with a date error instead of reporting no orders when most dates cannot be read", async () => {
    const db = fakeDb({ "orders:dates": [{ present: 10, unreadable: 6 }] });
    await expect(computeMongoRollup(db, goodsConfig)).rejects.toThrow(/order date field are not a readable date/);
    expect(db.calls).toHaveLength(1);
  });

  it("reads Unix times in seconds and milliseconds, not only BSON dates", async () => {
    const db = fakeDb({});
    await computeMongoRollup(db, goodsConfig);
    const dates = JSON.stringify(db.calls[0]?.pipeline);
    expect(dates).toContain(`"regex":"^[0-9]{10}$"`);
    expect(dates).toContain(`"$lt":["$$v",10000000000]`);
    expect(MONGO_DATE_SAMPLE_ROWS).toBeLessThanOrEqual(MAX_ROWS_PER_READ);
    expect(dates).toContain(`"$limit":${MONGO_DATE_SAMPLE_ROWS}`);
  });
});

describe("assembleIntel", () => {
  const sellOnce = () =>
    assembleIntel(
      [
        cell({ geo_label: "Lagos", bookings_n: 36, week_start: "2026-06-01" }),
        cell({ geo_label: "Nairobi", bookings_n: 20 }),
        cell({ geo_label: "Accra", bookings_n: 18 }),
        cell({ geo_label: "Kampala", bookings_n: 6 }),
        cell({ geo_label: OTHER_REGION, bookings_n: 400 }),
      ],
      [
        snapshot({ geo_label: "Lagos", total_listings: 40, completed_listings: 40 }),
        snapshot({ geo_label: "Nairobi", total_listings: 40, completed_listings: 40 }),
        snapshot({ geo_label: "Accra", total_listings: 40, completed_listings: 40 }),
        snapshot({ geo_label: "Kampala", total_listings: 40, completed_listings: 40 }),
        snapshot({ geo_label: "Kigali", total_listings: 12, completed_listings: 12 }),
      ],
      { tenant_id: TENANT, as_of: "2026-06-30T00:00:00.000Z", window_weeks: 13, min_cell: 5 },
    );

  it("labels each location against the tenant's other locations, not a fixed rate", () => {
    const intel = sellOnce();
    const by = Object.fromEntries(intel.regions.map((r) => [r.region_label, r]));
    expect(by.Lagos?.balance_label).toBe("demand_heavy");
    expect(by.Kampala?.balance_label).toBe("supply_heavy");
    expect(by.Nairobi?.balance_label).toBe("balanced");
    expect(by.Lagos?.demand_index).toBeGreaterThan(1.5);
    expect(intel.grouped_by).toBe("location");
  });

  it("shows a location with supply and no orders, and keeps Other locations last and unlabelled", () => {
    const intel = sellOnce();
    const kigali = intel.regions.find((r) => r.region_label === "Kigali");
    expect(kigali).toMatchObject({ bookings_n: 0, completed_listings: 12 });
    const last = intel.regions.at(-1);
    expect(last).toMatchObject({ region_key: OTHER_REGION, region_label: "Other locations", balance_label: "not_compared" });
  });

  it("totals orders over every region and supply over every location that has it", () => {
    const intel = sellOnce();
    expect(intel.total).toEqual({ bookings_n: 480, active_supply_n: 0, total_listings: null });
  });

  it("uses window totals, not sparse weekly cells, for suppression", () => {
    const intel = assembleIntel(
      [
        cell({ geo_label: "Leeds", week_start: "2026-06-01", bookings_n: 4, suppressed: true }),
        cell({ geo_label: "Leeds", week_start: "2026-06-08", bookings_n: 4, suppressed: true }),
        cell({ geo_label: "York", week_start: "2026-06-01", bookings_n: 4, suppressed: true }),
      ],
      [],
      { tenant_id: TENANT, window_weeks: 13, min_cell: 5 },
    );
    expect(intel.regions.find((r) => r.region_label === "Leeds")).toMatchObject({ bookings_n: 8, suppressed: false, balance_label: "supply_unknown" });
    expect(intel.regions.find((r) => r.region_label === "York")).toMatchObject({ suppressed: true });
    expect(intel.provenance.caveats).toContain("supply by location is not measured; showing where orders concentrate only");
  });

  it("reads rows written before regions existed without crashing", () => {
    const intel = assembleIntel(
      [cell({ state: null, geo_label: "unknown_state", bookings_n: 9 }), cell({ state: "TX", geo_label: "TX", bookings_n: 9 })],
      [snapshot({ state: "TX", geo_label: "Texas", total_listings: 5, completed_listings: 5 })],
      { tenant_id: TENANT },
    );
    expect(intel.regions.find((r) => r.region_key === OTHER_REGION)?.region_label).toBe("Other locations");
    expect(intel.regions.find((r) => r.region_key === "TX")).toMatchObject({ completed_listings: 5 });
  });

  it("uses the marketplace-wide rows for the totals, and never lists them as a location", () => {
    const intel = assembleIntel(
      [
        cell({ geo_label: "Lagos", bookings_n: 30, active_supply_n: 9, week_start: "2026-06-01" }),
        cell({ geo_label: "Nairobi", bookings_n: 20, active_supply_n: 8, week_start: "2026-06-01" }),
        cell({ geo_label: MARKETPLACE_TOTAL_REGION, bookings_n: 0, active_supply_n: 11, week_start: "2026-06-01" }),
      ],
      [
        snapshot({ geo_label: "Lagos", total_listings: 40, completed_listings: 40 }),
        snapshot({ geo_label: "Nairobi", total_listings: 30, completed_listings: 30 }),
        snapshot({ geo_label: MARKETPLACE_TOTAL_REGION, total_listings: 55, completed_listings: 55 }),
      ],
      { tenant_id: TENANT, window_weeks: 13, min_cell: 5 },
    );
    expect(intel.total).toEqual({ bookings_n: 50, active_supply_n: 11, total_listings: 55 });
    expect(intel.weeks).toEqual([{ week_start: "2026-06-01", bookings_n: 50, active_supply_n: 11 }]);
    expect(intel.regions.map((r) => r.region_label)).toEqual(["Lagos", "Nairobi"]);
  });

  it("says how much each location's numbers are worth reading, instead of 'medium' everywhere", () => {
    const intel = assembleIntel(
      [
        cell({ geo_label: "Busy", bookings_n: 300, week_start: "2026-06-01" }),
        cell({ geo_label: "Steady", bookings_n: 12, week_start: "2026-06-01" }),
        cell({ geo_label: "Thin", bookings_n: 2, week_start: "2026-06-01" }),
      ],
      [snapshot({ geo_label: "Quiet", total_listings: 9, completed_listings: 9 })],
      { tenant_id: TENANT, window_weeks: 13, min_cell: 5 },
    );
    const by = Object.fromEntries(intel.regions.map((r) => [r.region_label, r.confidence]));
    expect(by).toMatchObject({ Busy: "high", Steady: "medium", Thin: "low", Quiet: "none" });
  });

  it("a big pile of orders we could not place never reads as strong evidence", () => {
    const intel = assembleIntel(
      [
        cell({ geo_label: "Lagos", bookings_n: 300, week_start: "2026-06-01" }),
        cell({ geo_label: NO_LOCATION_REGION, bookings_n: 500, week_start: "2026-06-01" }),
        cell({ geo_label: OTHER_REGION, bookings_n: 900, week_start: "2026-06-01" }),
      ],
      [],
      { tenant_id: TENANT, window_weeks: 13, min_cell: 5 },
    );
    const by = Object.fromEntries(intel.regions.map((r) => [r.region_key, r.confidence]));
    expect(by[NO_LOCATION_REGION]).toBe("medium");
    expect(by[OTHER_REGION]).toBe("medium");
    expect(intel.regions.find((r) => r.region_label === "Lagos")?.confidence).toBe("high");
  });

  it("assembles an empty payload", () => {
    const intel = assembleIntel([], [], { tenant_id: TENANT, configured: false });
    expect(intel.regions).toEqual([]);
    expect(intel.weeks).toEqual([]);
    expect(intel.total).toEqual({ bookings_n: 0, active_supply_n: 0, total_listings: null });
  });
});

describe("Mongo pipelines for any data shape", () => {
  it("location on a listing: one $lookup on the confirmed listings collection, any id form joins, time-limited", async () => {
    const db = fakeDb({});
    const cfg: MarketplaceIntelConfig = {
      ...goodsConfig,
      location_source: "listing",
      supply_source: "sellers_on_orders",
      bookings: { ...goodsConfig.bookings, geo_field: null, listing_ref_field: "item_id", seller_ref_field: "seller_id" },
      listings: { table: "items", id_field: "_id", geo_field: "city", listed_at_field: null },
    };
    await computeMongoRollup(db, cfg, { window_weeks: 13, min_cell: 5 });
    expect(db.calls.map((c) => `${c.collection}:${c.kind}`)).toEqual([
      "orders:dates", "orders:locations", "orders:weeks", "orders:supply", "orders:totalweeks", "orders:totalsupply",
    ]);
    const json = JSON.stringify(db.calls[2]?.pipeline);
    expect(json).toContain(`"$lookup":{"from":"items","localField":"__zavi_refs","foreignField":"_id"`);
    expect(json).toContain(`{"$convert":{"input":"$item_id","to":"string","onError":null,"onNull":null}}`);
    expect(json).toContain(`{"$convert":{"input":"$item_id","to":"objectId","onError":null,"onNull":null}}`);
    expect(json).not.toContain("$expr");
    expect(db.calls[2]?.options).toEqual({ maxTimeMS: MONGO_ROLLUP_MAX_TIME_MS, allowDiskUse: true, failIfTruncated: true });
    const sellers = JSON.stringify(db.calls[3]?.pipeline);
    expect(sellers).toContain(`"r":"$seller_id"`);
    expect(sellers).not.toContain("$addToSet");
  });

  it("the read-only guard also inspects a $lookup's own pipeline", () => {
    expect(() =>
      assertReadOnlyMongo("aggregate", [{ $lookup: { from: "x", pipeline: [{ $merge: "y" }], as: "z" } }]),
    ).toThrow(/must not write/);
  });
});

describe("assertReadOnlyMongo", () => {
  it("allows reads and cursor lifecycle, refuses writes", () => {
    expect(() => assertReadOnlyMongo("aggregate", [{ $match: {} }])).not.toThrow();
    expect(() => assertReadOnlyMongo("insertOne")).toThrow(/not read-only/);
    expect(() => assertReadOnlyMongo("aggregate", [{ $merge: "x" }])).toThrow(/must not write/);
    expect(() => assertReadOnlyMongo("aggregate", [{ $out: "x" }])).toThrow(/must not write/);
    expect(() => assertReadOnlyMongo("getMore")).not.toThrow();
    expect(() => assertReadOnlyMongo("killCursors")).not.toThrow();
    expect(() => assertReadOnlyMongo({ commandName: "getMore" })).not.toThrow();
  });
});
