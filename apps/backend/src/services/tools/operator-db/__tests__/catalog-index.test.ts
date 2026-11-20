
import { describe, it, expect } from "vitest";
import { renderCatalogDigest, renderCatalogIndex } from "../catalog";
import type { OperatorDbCatalog } from "../types";

const cat = (
  tables: Array<{ name: string; cols: string[]; rowEstimate?: number | null }>,
): OperatorDbCatalog =>
  ({
    tables: tables.map((t) => ({
      name: t.name,
      columns: t.cols.map((c) => ({ name: c, type: "String", nullable: false })),
      rowEstimate: t.rowEstimate ?? null,
    })),
  }) as unknown as OperatorDbCatalog;

const WIDE = cat([
  { name: "users", cols: Array.from({ length: 60 }, (_, i) => `user_field_${i}`) },
  { name: "trips", cols: Array.from({ length: 60 }, (_, i) => `trip_field_${i}`) },
  { name: "supportchats", cols: ["_id", "userId", "question", "answer", "createdAt"] },
]);

describe("renderCatalogIndex", () => {
  it("lists every table by name", () => {
    expect(renderCatalogIndex(WIDE).map((c) => c.name)).toEqual([
      "users",
      "trips",
      "supportchats",
    ]);
  });

  it("is dramatically smaller than the full digest", () => {
    const index = JSON.stringify(renderCatalogIndex(WIDE));
    const digest = renderCatalogDigest(WIDE);
    expect(index.length).toBeLessThan(digest.length / 5);
  });

  it("omits rows when discovery did not populate a row estimate", () => {
    expect(renderCatalogIndex(WIDE)[0]).toEqual({ name: "users" });
    expect(renderCatalogIndex(WIDE)[0]).not.toHaveProperty("rows");
  });

  it("includes rows when discovery DID populate one", () => {
    const withRows = cat([{ name: "trips", cols: ["_id"], rowEstimate: 19422 }]);
    expect(renderCatalogIndex(withRows)[0]).toEqual({ name: "trips", rows: 19422 });
  });

  it("returns an empty list for an undiscovered catalog", () => {
    expect(renderCatalogIndex({ tables: [] } as unknown as OperatorDbCatalog)).toEqual([]);
  });
});

describe("renderCatalogDigest with `only`", () => {
  it("returns columns for the named table and no others", () => {
    const out = renderCatalogDigest(WIDE, { only: ["supportchats"] });
    expect(out).toContain("supportchats");
    expect(out).toContain("question");
    expect(out).not.toContain("user_field_0");
    expect(out).not.toContain("trip_field_0");
  });

  it("expands several named tables at once", () => {
    const out = renderCatalogDigest(WIDE, { only: ["supportchats", "trips"] });
    expect(out).toContain("supportchats");
    expect(out).toContain("trip_field_0");
    expect(out).not.toContain("user_field_0");
  });

  it("is unchanged when `only` is omitted (back-compat)", () => {
    expect(renderCatalogDigest(WIDE, {})).toBe(renderCatalogDigest(WIDE));
  });

  it("says so plainly when nothing matches, rather than returning empty", () => {
    expect(renderCatalogDigest(WIDE, { only: ["nope"] })).toBe("(no matching tables)");
  });

  it("keeps the undiscovered-schema message", () => {
    expect(renderCatalogDigest({ tables: [] } as unknown as OperatorDbCatalog)).toBe(
      "(operator DB schema not yet discovered)",
    );
  });
});
