
import { describe, expect, it } from "vitest";
import { heuristicHints } from "../hints";
import type { OperatorDbCatalog } from "../../types";

const catalog = (...names: string[]): OperatorDbCatalog => ({
  tables: names.map((name) => ({
    name,
    rowEstimate: 100,
    columns: [
      { name: "id", type: "bigint", nullable: false },
      { name: "created_at", type: "timestamptz", nullable: false },
    ],
  })),
});

describe("heuristicHints — non-marketplace schemas", () => {
  it("resolves an e-commerce `customers` table as the people table", () => {
    const h = heuristicHints(catalog("customers", "orders", "order_items"));
    expect(h.users?.table).toBe("customers");
  });

  it("resolves `subscribers`", () => {
    expect(heuristicHints(catalog("subscribers", "campaigns")).users?.table).toBe("subscribers");
  });

  it("resolves `clients`", () => {
    expect(heuristicHints(catalog("clients", "engagements")).users?.table).toBe("clients");
  });

  it("prefers `users` when a schema carries both, whichever order the catalog lists them", () => {
    expect(heuristicHints(catalog("users", "customers")).users?.table).toBe("users");
    expect(heuristicHints(catalog("customers", "users")).users?.table).toBe("users");
    expect(heuristicHints(catalog("customers", "accounts", "clients")).users?.table).toBe("accounts");
  });

  it("leaves the marketplace mapping exactly as it was", () => {
    const h = heuristicHints(catalog("users", "listings", "bookings", "payments"));
    expect(h.users?.table).toBe("users");
    expect(h.listings?.table).toBe("listings");
    expect(h.bookings?.table).toBe("bookings");
    expect(h.transactions?.table).toBe("payments");
  });
});
