import { describe, expect, it, vi } from "vitest";
import { effectivePolicy, guardMongoAggregate, MAX_QUERY_BYTES } from "@zavi/shared/db-guard";
import { computeMongoRollup, fitMappingToGuard, MAX_RAW_LOCATIONS, type MarketplaceIntelMongoDb, type RegionMapping } from "../aggregate";
import type { LocationSource, MarketplaceIntelConfig, SupplySource } from "../contract";

const COLUMNS = ["_id", "city", "created_at", "listed_at", "item_ref", "seller_ref", "buyer_ref"].map((name) => ({ name }));
const policy = effectivePolicy(
  { auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] },
  { tables: ["orders", "items", "customers"].map((name) => ({ name, columns: COLUMNS })) },
  "mongodb",
);

function configFor(location_source: LocationSource, supply_source: SupplySource, listed_at: boolean): MarketplaceIntelConfig {
  return {
    tenant_id: "00000000-0000-4000-8000-0000000000aa",
    dialect: "mongodb",
    location_source,
    supply_source,
    bookings: {
      table: "orders",
      created_at_field: "created_at",
      geo_field: location_source === "order" ? "city" : null,
      listing_ref_field: "item_ref",
      seller_ref_field: "seller_ref",
      buyer_ref_field: "buyer_ref",
      gmv_proxy_field: null,
    },
    listings: { table: "items", id_field: "_id", geo_field: "city", listed_at_field: listed_at ? "listed_at" : null },
    location_table: { table: "customers", id_field: "_id", geo_field: "city" },
    category: { source: "none_on_trips", note: "" },
    intent_events: { search: null, view: null, contact: null },
    provenance: { source: "self_serve_confirmed", validated: true },
  };
}

function guardedDb(locations: Array<{ _id: unknown; n: number }> = []) {
  const refusals: string[] = [];
  const pipelines: unknown[][] = [];
  const db: MarketplaceIntelMongoDb = {
    collection(name: string) {
      return {
        aggregate<T>(pipeline: unknown[]) {
          pipelines.push(pipeline);
          const g = guardMongoAggregate(name, pipeline, { policy });
          if (!g.ok) refusals.push(`${name}: ${(g as { reason: string }).reason}`);
          const first = JSON.stringify(pipeline).includes(`"$limit":${MAX_RAW_LOCATIONS}`);
          return { toArray: async () => (first ? locations : []) as T[] };
        },
      };
    },
  };
  return { db, refusals, pipelines, reads: () => pipelines.length };
}

const MANY_LONG_LOCATIONS = Array.from({ length: MAX_RAW_LOCATIONS }, (_, i) => ({
  _id: `${1000 + i} Long Industrial Park Road, Unit ${i}, ${"Some Distant Township ".repeat(16)}`,
  n: MAX_RAW_LOCATIONS - i,
}));

const SHAPES: Array<[LocationSource, SupplySource, boolean]> = [];
for (const loc of ["order", "listing", "user", "none"] as const) {
  for (const sup of ["listings", "sellers_on_orders", "none"] as const) {
    SHAPES.push([loc, sup, false]);
    if (sup === "listings") SHAPES.push([loc, sup, true]);
  }
}

describe("the Mongo rollup's reads pass the database guard", () => {
  it.each(SHAPES)("location %s, supply %s, listing date %s", async (loc, sup, listedAt) => {
    const g = guardedDb();
    await computeMongoRollup(g.db, configFor(loc, sup, listedAt));
    expect(g.reads()).toBeGreaterThan(2);
    expect(g.refusals).toEqual([]);
  });

  it.each(SHAPES)("with %s / %s / %s and the most locations the first read returns, every read still fits", async (loc, sup, listedAt) => {
    const g = guardedDb(MANY_LONG_LOCATIONS);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await computeMongoRollup(g.db, configFor(loc, sup, listedAt));
      const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("marketplace_rollup.locations_cut"));
      expect(JSON.parse(line!).moved_to_other).toBeGreaterThan(0);
      expect(line).not.toContain("Industrial");
    } finally {
      warn.mockRestore();
    }
    expect(g.refusals).toEqual([]);
    const regionReads = g.pipelines.filter((p) => JSON.stringify(p).includes("__zavi_key"));
    for (const p of regionReads) expect(JSON.stringify(p)).toContain(MANY_LONG_LOCATIONS[0]!._id as string);
  });

  it("a hidden field on the joined collection is still removed inside the lookup", async () => {
    const hiding = effectivePolicy(
      { auto_hide: false, hidden_fields: ["items.secret"], unhidden_fields: [], disabled_tables: [] },
      { tables: ["orders", "items"].map((name) => ({ name, columns: [...COLUMNS, { name: "secret" }] })) },
      "mongodb",
    );
    const guarded: unknown[] = [];
    const db: MarketplaceIntelMongoDb = {
      collection(name: string) {
        return {
          aggregate<T>(pipeline: unknown[]) {
            const g = guardMongoAggregate(name, pipeline, { policy: hiding });
            expect(g.ok).toBe(true);
            if (g.ok) guarded.push(g.pipeline);
            return { toArray: async () => [] as T[] };
          },
        };
      },
    };
    await computeMongoRollup(db, configFor("listing", "none", false));
    expect(JSON.stringify(guarded)).toContain(`"$unset":["secret"]`);
  });
});

describe("fitMappingToGuard", () => {
  const mapping = Array.from({ length: 50 }, (_, i) => ({ raw: `place ${i}`, key: `k${i}` }));
  const build = (m: RegionMapping) => [[{ $match: { x: { $in: m.map((e) => String(e.raw) + "x".repeat(400)) } } }]];

  it("keeps the whole mapping when it fits", () => {
    const small = mapping.slice(0, 5);
    expect(fitMappingToGuard(small, build)).toEqual(small);
  });

  it("keeps the longest busiest-first prefix that fits the guard's size cap", () => {
    const kept = fitMappingToGuard(mapping, build);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(mapping.length);
    expect(kept).toEqual(mapping.slice(0, kept.length));
    expect(JSON.stringify(build(kept)[0]).length).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    expect(JSON.stringify(build(mapping.slice(0, kept.length + 1))[0]).length).toBeGreaterThan(MAX_QUERY_BYTES);
  });

  it("keeps a region whole: a quiet spelling of a kept place is never cut away from it", () => {
    const split = [...mapping.slice(0, 49), { raw: "place 0 (other spelling)", key: "k0" }];
    const kept = fitMappingToGuard(split, build);
    const keptKeys = new Set(kept.map((e) => e.key));
    for (const key of keptKeys) {
      expect(kept.filter((e) => e.key === key)).toEqual(split.filter((e) => e.key === key));
    }
    expect(keptKeys.has("k0")).toBe(true);
    expect(JSON.stringify(build(kept)[0]).length).toBeLessThanOrEqual(MAX_QUERY_BYTES);
  });

  it("ranks regions by their rows across every spelling, and spends no room on values that are Other anyway", () => {
    const pad = "x".repeat(6000);
    const m = [
      { raw: `B${pad}`, key: "b", weight: 100 },
      { raw: `other-ish${pad}`, key: "__other__", weight: 90 },
      { raw: `A${pad}`, key: "a", weight: 60 },
      { raw: `A variant${pad}`, key: "a", weight: 60 },
    ];
    const one = (x: RegionMapping) => [[{ $match: { v: { $in: x.map((e) => e.raw) } } }]];
    const kept = fitMappingToGuard(m, one);
    expect(kept.map((e) => e.key)).toEqual(["a", "a"]);
  });
});
