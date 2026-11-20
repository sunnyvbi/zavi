import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/llm/call-model", () => ({
  callModel: async () => ({ text: JSON.stringify({ listings: { table: "listings", id_field: "id" } }) }),
}));

import { heuristicHints, refineHintsWithHaiku } from "../hints";

describe("Haiku refine keeps the listing state field", () => {
  it("re-derives geo_field on the listings table the refine picked (live Postgres + Mongo regression)", async () => {
    const col = (name: string) => ({ name, type: "text", nullable: true });
    const cat = {
      tables: [
        { name: "listings", rowEstimate: 1, columns: [col("id"), col("title"), col("state")] },
        { name: "bookings", rowEstimate: 1, columns: [col("id"), col("createdAt"), col("listing_id")] },
      ],
    };
    const refined = await refineHintsWithHaiku(cat, heuristicHints(cat), 5000, "t");
    expect(refined.listings).toEqual({ table: "listings", id_field: "id", geo_field: "state" });
  });
});
