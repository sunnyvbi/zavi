import { describe, expect, it, vi } from "vitest";
import { carryForwardConfirmedMapping, isStrictlyDateTyped, mapStillFits, type CarryForwardDeps } from "../mapping-carry-forward";
import type { CatalogTable } from "../types";
import type { ResolvedCatalog } from "../catalog";

const t = (name: string, cols: Array<[string, string]>): CatalogTable => ({
  name,
  columns: cols.map(([n, type]) => ({ name: n, type, nullable: false })),
  rowEstimate: null,
});

const TRIPS = t("trips", [["_id", "ObjectId"], ["createdAt", "Date"], ["carId", "ObjectId"], ["pickup.state", "String"]]);
const CARS = t("cars", [["_id", "ObjectId"], ["listedAt", "Date|Null"], ["state", "String"]]);

const MAP = {
  bookings: { table: "trips", label: "Trips", created_at_field: "createdAt", listing_ref_field: "carId", geo_field: "pickup.state" },
  listings: { table: "cars", label: "Cars", id_field: "_id", listed_at_field: "listedAt", geo_field: "state" },
  supply_demand: { version: 2, confirmed: true, supply_source: "listings", location_source: "order" },
};

const catalog = (tables: CatalogTable[], over: Partial<ResolvedCatalog> = {}): ResolvedCatalog =>
  ({ dialect: "mongodb", catalog: { tables }, hints: {}, catalog_hash: "new", discovery_error: null, ...over }) as ResolvedCatalog;

function deps(cat: ResolvedCatalog | null, rows: Array<{ catalog_hash: string; confirmed_map: unknown; confirmed_at: string; confirmed_by: string | null }>, carried = true) {
  const carry = vi.fn(async () => carried);
  const d: CarryForwardDeps = { getCatalog: async () => cat, readConfirmations: async () => rows, carry };
  return { d, carry };
}

describe("mapStillFits", () => {
  it("fits when every table and column is still there", () => {
    expect(mapStillFits({ tables: [TRIPS, CARS, t("users", [])] }, MAP)).toEqual({ ok: true });
  });
  it("refuses when a table is gone", () => {
    expect(mapStillFits({ tables: [TRIPS] }, MAP)).toMatchObject({ ok: false, reason: "listings: table gone" });
  });
  it("refuses when a table is ambiguous", () => {
    expect(mapStillFits({ tables: [TRIPS, CARS, CARS] }, MAP)).toMatchObject({ ok: false });
  });
  it("refuses when a column is gone", () => {
    const trips = t("trips", [["_id", "ObjectId"], ["createdAt", "Date"], ["carId", "ObjectId"]]);
    expect(mapStillFits({ tables: [trips, CARS] }, MAP)).toMatchObject({ ok: false, reason: "bookings.geo_field: column gone" });
  });
  it("refuses when a date column stops being a date", () => {
    const trips = t("trips", [["_id", "ObjectId"], ["createdAt", "String"], ["carId", "ObjectId"], ["pickup.state", "String"]]);
    expect(mapStillFits({ tables: [trips, CARS] }, MAP)).toMatchObject({ ok: false, reason: "bookings.created_at_field: no longer a date" });
  });
  it("refuses a mixed or unknown type for a date column", () => {
    const trips = t("trips", [["_id", "ObjectId"], ["createdAt", "Date|String"], ["carId", "ObjectId"], ["pickup.state", "String"]]);
    expect(mapStillFits({ tables: [trips, CARS] }, MAP)).toMatchObject({ ok: false, reason: "bookings.created_at_field: no longer a date" });
  });
  it("reads date types strictly across dialects", () => {
    for (const ok of ["Date", "Date|Null", "timestamp with time zone", "timestamptz", "datetime(3)", "date"]) expect(isStrictlyDateTyped(ok)).toBe(true);
    for (const bad of ["", "Null", "Date|String", "String", "time", "updated", undefined]) expect(isStrictlyDateTyped(bad)).toBe(false);
  });
  it("refuses a map that names no table", () => {
    expect(mapStillFits({ tables: [TRIPS] }, { supply_demand: MAP.supply_demand })).toMatchObject({ ok: false, reason: "no_tables" });
  });
});

describe("carryForwardConfirmedMapping", () => {
  const OLD = { catalog_hash: "old", confirmed_map: MAP, confirmed_at: "2026-10-09T16:37:19Z", confirmed_by: "founder" };

  it("carries the latest confirmation to the new hash when it still fits", async () => {
    const older = { catalog_hash: "older", confirmed_map: { users: { table: "gone" } }, confirmed_at: "2026-07-04T00:00:00Z", confirmed_by: "founder" };
    const { d, carry } = deps(catalog([TRIPS, CARS]), [older, OLD]);
    expect(await carryForwardConfirmedMapping("t1", d)).toBe("carried");
    expect(carry).toHaveBeenCalledWith("t1", "new");
  });

  it("never touches a hash that already has a confirmation", async () => {
    const { d, carry } = deps(catalog([TRIPS, CARS]), [OLD, { ...OLD, catalog_hash: "new" }]);
    expect(await carryForwardConfirmedMapping("t1", d)).toBe("already_confirmed");
    expect(carry).not.toHaveBeenCalled();
  });

  it("saves nothing when the schema moved under the confirmation", async () => {
    const { d, carry } = deps(catalog([TRIPS]), [OLD]);
    expect(await carryForwardConfirmedMapping("t1", d)).toBe("schema_changed");
    expect(carry).not.toHaveBeenCalled();
  });

  it("does nothing on a failed or empty discovery", async () => {
    for (const cat of [null, catalog([TRIPS, CARS], { discovery_error: "x" }), catalog([]), catalog([TRIPS, CARS], { catalog_hash: null })]) {
      const { d, carry } = deps(cat, [OLD]);
      expect(await carryForwardConfirmedMapping("t1", d)).toBe("no_catalog");
      expect(carry).not.toHaveBeenCalled();
    }
  });

  it("never carries a Zavi-made confirmation (no founder)", async () => {
    const { d, carry } = deps(catalog([TRIPS, CARS]), [{ ...OLD, confirmed_by: null }]);
    expect(await carryForwardConfirmedMapping("t1", d)).toBe("no_prior");
    expect(carry).not.toHaveBeenCalled();
  });

  it("does nothing without an earlier confirmation", async () => {
    const { d } = deps(catalog([TRIPS, CARS]), []);
    expect(await carryForwardConfirmedMapping("t1", d)).toBe("no_prior");
  });

  it("reports a refusal from the database (stale hash, a race)", async () => {
    const { d } = deps(catalog([TRIPS, CARS]), [OLD], false);
    expect(await carryForwardConfirmedMapping("t1", d)).toBe("refused");
  });
});
