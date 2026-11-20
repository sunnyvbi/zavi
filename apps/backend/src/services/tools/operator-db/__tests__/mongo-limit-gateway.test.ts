import { describe, it, expect } from "vitest";
import { effectivePolicy, guardMongoAggregate } from "@zavi/shared/db-guard";
import { buildAggregatePipeline } from "../drivers/mongo";
const policy = effectivePolicy({ auto_hide: false, hidden_fields: ["trips.secret"], unhidden_fields: [], disabled_tables: [] }, { tables: [{ name: "trips", columns: [{ name: "status" }, { name: "secret" }] }] }, "mongodb");
describe("driver pipeline through the actual downstream policy guard", () => {
  it.each([1, 40, 60])("accepts a valid %i-row query at the default driver cap", (n) => {
    const result = guardMongoAggregate("trips", buildAggregatePipeline([{ $limit: n }], 5000, undefined), { policy });
    expect(result.ok).toBe(true);
  });
  it("keeps hidden-field and user-supplied over-cap queries forbidden", () => {
    expect(guardMongoAggregate("trips", buildAggregatePipeline([{ $project: { secret: 1 } }], 5000, undefined), { policy }).ok).toBe(false);
    expect(guardMongoAggregate("trips", [{ $limit: 5001 }], { policy }).ok).toBe(false);
  });
});
