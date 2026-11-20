import { describe, it, expect, vi } from "vitest";
import { heuristicHints, refineHintsWithHaiku } from "../hints";
import type { OperatorDbCatalog } from "../../types";

const catalog: OperatorDbCatalog = {
  tables: [
    { name: "app_users", columns: [{ name: "id", type: "uuid", nullable: false }, { name: "status", type: "text", nullable: true }], rowEstimate: 1000 },
    { name: "vehicles", columns: [{ name: "id", type: "int", nullable: false }, { name: "owner_id", type: "int", nullable: false }], rowEstimate: 50 },
    { name: "trips", columns: [
      { name: "id", type: "int", nullable: false },
      { name: "pickup_city", type: "text", nullable: true },
      { name: "vehicle_class", type: "text", nullable: true },
      { name: "created_at", type: "timestamptz", nullable: false },
      { name: "vehicle_id", type: "int", nullable: false },
      { name: "total_cents", type: "int", nullable: true },
    ], rowEstimate: 4000 },
    { name: "payments", columns: [{ name: "id", type: "int", nullable: false }], rowEstimate: 4000 },
    { name: "audit_log", columns: [{ name: "id", type: "int", nullable: false }], rowEstimate: 99999 },
  ],
};

describe("heuristicHints", () => {
  it("maps loose names to roles with confidence", () => {
    const h = heuristicHints(catalog);
    expect(h.users?.table).toBe("app_users");
    expect(h.users?.id_field).toBe("id");
    expect(h.listings?.table).toBe("vehicles");
    expect(h.transactions?.table).toBe("payments");
    expect(h.bookings?.table).toBe("trips");
    expect(h.bookings?.geo_field).toBe("pickup_city");
    expect(h.bookings?.category_field).toBe("vehicle_class");
    expect(h.bookings?.created_at_field).toBe("created_at");
    expect(h.bookings?.listing_ref_field).toBe("vehicle_id");
    expect(h.bookings?.gmv_proxy_field).toBe("total_cents");
    expect(h._confidence?.users).toBeGreaterThan(0);
  });

  it("picks the real createdAt over an incidental photo-timestamp field (weekly_bookings false-zero regression)", () => {
    const h = heuristicHints({
      tables: [
        {
          name: "trips",
          columns: [
            { name: "_id", type: "objectId", nullable: false },
            { name: "carArea", type: "string", nullable: true },
            { name: "additionalPhotoTimestamps", type: "array", nullable: true },
            { name: "updatedAt", type: "date", nullable: true },
            { name: "createdAt", type: "date", nullable: false },
          ],
          rowEstimate: 4000,
        },
      ],
    });
    expect(h.bookings?.table).toBe("trips");
    expect(h.bookings?.created_at_field).toBe("createdAt");
  });

  it("returns no created_at_field when only non-creation date fields exist (honest gap, not a wrong field)", () => {
    const h = heuristicHints({
      tables: [
        {
          name: "trips",
          columns: [
            { name: "_id", type: "objectId", nullable: false },
            { name: "additionalPhotoTimestamps", type: "array", nullable: true },
            { name: "updatedAt", type: "date", nullable: true },
          ],
          rowEstimate: 10,
        },
      ],
    });
    expect(h.bookings?.table).toBe("trips");
    expect(h.bookings?.created_at_field).toBeUndefined();
  });

  it("omits roles with no matching table", () => {
    const h = heuristicHints({ tables: [{ name: "widgets", columns: [{ name: "id", type: "int", nullable: false }], rowEstimate: 1 }] });
    expect(h.users).toBeUndefined();
    expect(h.bookings).toBeUndefined();
  });

  it("never throws on empty catalog", () => {
    expect(() => heuristicHints({ tables: [] })).not.toThrow();
  });
});

describe("refineHintsWithHaiku — non-blocking", () => {
  it("returns heuristic unchanged when budgetMs<=0 (no network)", async () => {
    const h = heuristicHints(catalog);
    const r = await refineHintsWithHaiku(catalog, h, 0);
    expect(r).toBe(h);
  });

  it("returns heuristic when the Anthropic call throws (never propagates)", async () => {
    vi.resetModules();
    vi.doMock("@/services/anthropic", () => ({
      getAnthropic: () => ({
        messages: { create: () => { throw new Error("anthropic down"); } },
      }),
    }));
    const { refineHintsWithHaiku: refine, heuristicHints: heur } = await import("../hints");
    const h = heur(catalog);
    const r = await refine(catalog, h, 5000);
    expect(r.users?.table).toBe("app_users");
    vi.doUnmock("@/services/anthropic");
    vi.resetModules();
  });
});

describe("listings geo_field hint (Supply & Demand per-state supply)", () => {
  const col = (name: string) => ({ name, type: "string", nullable: true });
  it("guesses a nested address.state and a flat state column", () => {
    const nested = heuristicHints({
      tables: [{ name: "carlistings", rowEstimate: 1, columns: [col("_id"), col("address.state"), col("listingStatus")] }],
    });
    expect(nested.listings?.geo_field).toBe("address.state");
    const flat = heuristicHints({
      tables: [{ name: "listings", rowEstimate: 1, columns: [col("id"), col("state")] }],
    });
    expect(flat.listings?.geo_field).toBe("state");
  });

  it("leaves it undefined when nothing location-like exists (never a guess)", () => {
    const h = heuristicHints({
      tables: [{ name: "products", rowEstimate: 1, columns: [col("id"), col("title")] }],
    });
    expect(h.listings?.geo_field).toBeUndefined();
  });
});
