import { describe, expect, it } from "vitest";
import { mongoDriver } from "../mongo";

describe("MongoDB geo-category shortcuts", () => {
  const d = mongoDriver() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  it.each(["query_bookings_by_geo_category", "query_active_supply_by_geo_category", "query_funnel_by_geo_category"])("%s always refuses", async (name) => {
    await expect(d[name]!({}, {})).rejects.toMatchObject({ code: "operator_db_aggregate_not_yet_implemented" });
  });
});
