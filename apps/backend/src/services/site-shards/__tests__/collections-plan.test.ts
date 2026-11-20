import { describe, expect, it } from "vitest";
import { CollectionPlanRefused, planCollections, planIsEmpty } from "../collections-plan";
import type { CollectionDef } from "../contract";

const col = (name: string, over: Partial<CollectionDef> = {}): CollectionDef => ({
  name,
  kind: "records",
  rules: { list: ["anyone"], get: ["anyone"], create: ["admin"] },
  schema: { type: "object", properties: { title: { type: "string", maxLength: 80 } } },
  fields: {},
  indexes: {},
  ...over,
});

describe("planCollections (manifest diff against the shard's live rows)", () => {
  it("adds a declared collection the shard does not have", () => {
    const p = planCollections([], [col("bookings")]);
    expect(p.add.map((c) => c.name)).toEqual(["bookings"]);
    expect(p.change).toEqual([]);
    expect(p.archive).toEqual([]);
  });

  it("changes a collection whose rules / schema / fields differ, and ignores key order", () => {
    const cur = col("bookings");
    const reordered = col("bookings", { rules: { create: ["admin"], get: ["anyone"], list: ["anyone"] } });
    expect(planIsEmpty(planCollections([cur], [reordered]))).toBe(true);
    const tightened = col("bookings", { rules: { list: ["admin"], get: ["admin"], create: ["anyone"] } });
    const p = planCollections([cur], [tightened]);
    expect(p.change.map((c) => c.name)).toEqual(["bookings"]);
    expect(p.reindex).toEqual([]);
  });

  it("ARCHIVES (never drops) a collection the manifest no longer declares", () => {
    const p = planCollections([col("bookings"), col("reviews")], [col("bookings")]);
    expect(p.archive).toEqual(["reviews"]);
    expect(p.add).toEqual([]);
    expect(Object.keys(p).sort()).toEqual(["add", "archive", "change", "reindex", "unchanged"]);
  });

  it("an already archived collection stays put; re-declaring it revives it", () => {
    const archived = col("reviews", { archived: true });
    expect(planIsEmpty(planCollections([archived], []))).toBe(true);
    const p = planCollections([archived], [col("reviews")]);
    expect(p.change.map((c) => c.name)).toEqual(["reviews"]);
    expect(planCollections([col("reviews")], []).archive).toEqual(["reviews"]);
  });

  it("refuses records <-> files (kind is immutable)", () => {
    expect(() => planCollections([col("photos")], [col("photos", { kind: "files", schema: {} })])).toThrow(CollectionPlanRefused);
  });

  it("flags an index-slot change for the record check", () => {
    const p = planCollections([col("bookings")], [col("bookings", { indexes: { title: "s1" } })]);
    expect(p.reindex).toEqual(["bookings"]);
  });

  it("refuses a manifest that declares a name twice", () => {
    expect(() => planCollections([], [col("a"), col("a")])).toThrow(/twice/);
  });
});
