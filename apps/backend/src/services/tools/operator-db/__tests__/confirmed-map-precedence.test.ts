
import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyConfirmedMap } from "../mapping";
import type { SchemaMap } from "../types";

function hintDerivedMap(): SchemaMap {
  return {
    users: { table: "users", id_field: "_id" },
    listings: { table: "carlistings", id_field: "_id" },
    transactions: { table: "giftcardtransactions", id_field: "id" },
    bookings: {
      table: "trips",
      id_field: "id",
      geo_field: "carArea",
      category_field: "",
      created_at_field: "additionalPhotoTimestamps",
      gmv_proxy_field: "additionalDepositAmount",
    },
  };
}

describe("applyConfirmedMap — the human's answer wins", () => {
  it("overrides the wrong created_at_field with the confirmed one (the incident)", () => {
    const out = applyConfirmedMap(hintDerivedMap(), {
      bookings: {
        table: "trips",
        label: "Bookings",
        created_at_field: "createdAt",
        listing_ref_field: "carId",
      },
    });
    expect(out.bookings?.created_at_field).toBe("createdAt");
    expect(out.bookings?.listing_ref_field).toBe("carId");
  });

  it("is ADDITIVE — fields the operator did not confirm keep the hint value", () => {
    const out = applyConfirmedMap(hintDerivedMap(), {
      bookings: { table: "trips", label: "Bookings", created_at_field: "createdAt" },
    });
    expect(out.bookings?.geo_field).toBe("carArea");
    expect(out.bookings?.gmv_proxy_field).toBe("additionalDepositAmount");
    expect(out.users).toEqual({ table: "users", id_field: "_id" });
    expect(out.listings).toEqual({ table: "carlistings", id_field: "_id" });
  });

  it("no confirmation → returns the base map unchanged", () => {
    const base = hintDerivedMap();
    expect(applyConfirmedMap(base, null)).toBe(base);
    expect(applyConfirmedMap(base, undefined)).toBe(base);
    expect(applyConfirmedMap(base, {})).toBe(base);
  });

  it("a partial confirmation can never blank a required field", () => {
    const out = applyConfirmedMap(hintDerivedMap(), {
      users: { table: "", label: "Users" },
      bookings: { table: "  ", label: "Bookings", created_at_field: "createdAt" },
    });
    expect(out.users.table).toBe("users");
    expect(out.bookings?.table).toBe("trips");
    expect(out.bookings?.created_at_field).toBe("createdAt");
  });

  it("can introduce a role the hints never inferred, with safe defaults", () => {
    const base: SchemaMap = { users: { table: "users", id_field: "_id" } };
    const out = applyConfirmedMap(base, {
      bookings: { table: "orders", label: "Bookings", created_at_field: "placed_at" },
    });
    expect(out.bookings?.table).toBe("orders");
    expect(out.bookings?.created_at_field).toBe("placed_at");
    expect(out.bookings?.geo_field).toBe("");
    expect(out.bookings?.category_field).toBe("");
  });

  it("does not mutate the input map", () => {
    const base = hintDerivedMap();
    applyConfirmedMap(base, {
      bookings: { table: "trips", label: "B", created_at_field: "createdAt" },
    });
    expect(base.bookings?.created_at_field).toBe("additionalPhotoTimestamps");
  });
});

const CATALOG_HASH = "hash-current";

const getConfirmedMappingMock = vi.fn();

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: () => ({
      select: () => ({
        maybeSingle: async () => ({
          data: { type: "mongodb", mode: "direct", connection_secret_key: "operator_db.connection_string" },
          error: null,
        }),
      }),
    }),
  }),
}));

vi.mock("../catalog", async () => {
  const actual = await vi.importActual<typeof import("../catalog")>("../catalog");
  return {
    ...actual,
    getCatalog: vi.fn(async () => ({
      dialect: "mongodb",
      catalog: { tables: [{ name: "trips", columns: [] }] },
      hints: {
        users: { table: "users", id_field: "_id" },
        bookings: { table: "trips", created_at_field: "additionalPhotoTimestamps" },
      },
      catalog_hash: CATALOG_HASH,
      discovery_error: null,
      updated_at: "2026-06-15T05:43:21Z",
    })),
  };
});

vi.mock("../mapping", async () => {
  const actual = await vi.importActual<typeof import("../mapping")>("../mapping");
  return { ...actual, getConfirmedMapping: (...a: unknown[]) => getConfirmedMappingMock(...a) };
});

vi.mock("@/services/secrets/vault", () => ({
  getSecret: async () => "mongodb://user:pw@host/db",
}));

describe("loadDbAccess (data gateway) — chokepoint honors the confirmed map", () => {
  beforeEach(() => {
    getConfirmedMappingMock.mockReset();
  });

  it("serves the confirmed created_at_field, not the hint's array column", async () => {
    getConfirmedMappingMock.mockResolvedValue({
      catalog_hash: CATALOG_HASH,
      confirmed_at: "2026-07-04T22:22:37Z",
      confirmed_map: {
        bookings: { table: "trips", label: "Bookings", created_at_field: "createdAt" },
      },
    });
    const { loadDbAccess } = await import("@/services/data-gateway/resolve");
    const out = await loadDbAccess("tenant-incident");

    expect(out.config.schema_map.bookings?.created_at_field).toBe("createdAt");
    expect(getConfirmedMappingMock).toHaveBeenCalledWith("tenant-incident", CATALOG_HASH);
  });

  it("no confirmation → hint-derived map, exactly as before", async () => {
    getConfirmedMappingMock.mockResolvedValue(null);
    const { loadDbAccess } = await import("@/services/data-gateway/resolve");
    const out = await loadDbAccess("tenant-unconfirmed");

    expect(out.config.schema_map.bookings?.created_at_field).toBe(
      "additionalPhotoTimestamps",
    );
  });

  it("a confirmation for a DIFFERENT catalog_hash is never applied", async () => {
    getConfirmedMappingMock.mockImplementation(async (_t: string, hash: string) =>
      hash === "hash-stale"
        ? { catalog_hash: hash, confirmed_at: "x", confirmed_map: { bookings: { table: "t", label: "B", created_at_field: "createdAt" } } }
        : null,
    );
    const { loadDbAccess } = await import("@/services/data-gateway/resolve");
    const out = await loadDbAccess("tenant-stale");

    expect(out.config.schema_map.bookings?.created_at_field).toBe(
      "additionalPhotoTimestamps",
    );
  });
});
