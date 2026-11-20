import { describe, it, expect } from "vitest";
import { heuristicHints } from "../hints";
import type { OperatorDbCatalog } from "../../types";

function cat(tables: { name: string; cols: string[] }[]): OperatorDbCatalog {
  return {
    tables: tables.map((t) => ({
      name: t.name,
      columns: t.cols.map((c) => ({ name: c, type: "text", nullable: true })),
      rowEstimate: 100,
    })),
  };
}

describe("heuristicHints — cancellations entity", () => {
  it("maps a dedicated cancellations table with reason + status", () => {
    const h = heuristicHints(
      cat([
        { name: "cancellations", cols: ["id", "booking_id", "cancel_reason", "status", "cancelled_at"] },
        { name: "bookings", cols: ["id", "city", "created_at"] },
      ]),
    );
    expect(h.cancellations?.table).toBe("cancellations");
    expect(h.cancellations?.reason_field).toBe("cancel_reason");
    expect(h.cancellations?.status_field).toBe("status");
    expect(h.cancellations?.created_at_field).toBe("cancelled_at");
    expect(h._confidence?.cancellations).toBeGreaterThanOrEqual(0.5);
  });

  it("reuses the bookings table when cancellation lives there as status+reason", () => {
    const h = heuristicHints(
      cat([
        { name: "trips", cols: ["id", "city", "created_at", "trip_status", "cancellation_reason"] },
      ]),
    );
    expect(h.cancellations?.table).toBe("trips");
    expect(h.cancellations?.reason_field).toBe("cancellation_reason");
    expect(h.cancellations?.status_field).toBe("trip_status");
    expect(h._confidence?.cancellations).toBeLessThan(0.5);
  });

  it("omits cancellations when no cancel/status/reason signal exists", () => {
    const h = heuristicHints(
      cat([
        { name: "orders", cols: ["id", "city", "created_at", "amount"] },
      ]),
    );
    expect(h.cancellations).toBeUndefined();
    expect(h.bookings?.table).toBe("orders");
  });
});
