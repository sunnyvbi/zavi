import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  dialect: "mongodb" as string | null,
  catalog: null as null | Record<string, unknown>,
  confirmed: null as null | { confirmed_map: Record<string, unknown> },
  latest: null as null | { confirmed_map: Record<string, unknown> },
}));

vi.mock("@/services/tools/operator-db/catalog", () => ({
  getDeclaredDialect: async () => mocks.dialect,
  getCatalog: async () => mocks.catalog,
}));
vi.mock("@/services/tools/operator-db/mapping", async (orig) => {
  const real = await orig<typeof import("@/services/tools/operator-db/mapping")>();
  return {
    ...real,
    getConfirmedMapping: async () => mocks.confirmed,
    getLatestConfirmedMapping: async () => mocks.latest,
  };
});

import {
  buildSelfServeConfig,
  getSupplyDemandSetup,
  isSafeMongoName,
  mergeSupplyDemandAnswers,
  isOptionalField,
  resolveMarketplaceConfig,
  supplyDemandRoles,
} from "../self-serve";

const T = "22222222-2222-2222-2222-222222222222";
const COMPLETE = {
  supply_demand: { confirmed: true, version: 2, location_source: "order", supply_source: "listings" },
  bookings: { table: "orders", created_at_field: "createdAt", geo_field: "city" },
  listings: { table: "items", id_field: "_id", geo_field: "address.city" },
};
const GOODS = {
  supply_demand: { confirmed: true, version: 2, location_source: "listing", supply_source: "listings" },
  bookings: { table: "orders", created_at_field: "sold_at", listing_ref_field: "item_id" },
  listings: { table: "items", id_field: "id", geo_field: "city", listed_at_field: "created_at" },
};
const SERVICES = {
  supply_demand: { confirmed: true, version: 2, location_source: "user", supply_source: "sellers_on_orders" },
  bookings: { table: "jobs", created_at_field: "booked_at", buyer_ref_field: "customer_id", seller_ref_field: "provider_id" },
  supply_demand_location: { table: "accounts", id_field: "id", geo_field: "suburb" },
};
const WHOLESALE = {
  supply_demand: { confirmed: true, version: 2, location_source: "none", supply_source: "none" },
  bookings: { table: "purchase_orders", created_at_field: "placed_at" },
};
const CATALOG = {
  dialect: "mongodb",
  catalog_hash: "h1",
  discovery_error: null,
  catalog: { tables: [{ name: "orders", columns: [{ name: "createdAt" }] }] },
  hints: {
    bookings: { table: "orders", created_at_field: "createdAt", geo_field: "city" },
    listings: { table: "items", id_field: "_id" },
  },
};

beforeEach(() => {
  mocks.dialect = "mongodb";
  mocks.catalog = CATALOG;
  mocks.confirmed = null;
  mocks.latest = null;
});

describe("isSafeMongoName", () => {
  it("rejects operator-shaped and empty names", () => {
    expect(isSafeMongoName("$where")).toBe(false);
    expect(isSafeMongoName("a\0b")).toBe(false);
    expect(isSafeMongoName("")).toBe(false);
    expect(isSafeMongoName({ $gt: 1 })).toBe(false);
    expect(isSafeMongoName("address.state")).toBe(true);
  });
});

describe("supplyDemandRoles", () => {
  it("asks only what each pair of answers needs", () => {
    expect(supplyDemandRoles({ location_source: "order", supply_source: "listings" })).toEqual({
      bookings: ["created_at_field", "geo_field", "listing_ref_field"],
      listings: ["id_field", "geo_field", "listed_at_field"],
    });
    expect(supplyDemandRoles({ location_source: "listing", supply_source: "none" })).toEqual({
      bookings: ["created_at_field", "listing_ref_field"],
      listings: ["id_field", "geo_field"],
    });
    expect(supplyDemandRoles({ location_source: "user", supply_source: "sellers_on_orders" })).toEqual({
      bookings: ["created_at_field", "buyer_ref_field", "seller_ref_field"],
      supply_demand_location: ["id_field", "geo_field"],
    });
    expect(supplyDemandRoles({ location_source: "none", supply_source: "listings" })).toEqual({
      bookings: ["created_at_field", "listing_ref_field"],
      listings: ["id_field", "listed_at_field"],
    });
  });
});

describe("isOptionalField", () => {
  it("the listing id on the order is required only when the location comes from the listing", () => {
    expect(isOptionalField({ location_source: "listing", supply_source: "listings" }, "listing_ref_field")).toBe(false);
    expect(isOptionalField({ location_source: "order", supply_source: "listings" }, "listing_ref_field")).toBe(true);
    expect(isOptionalField({ location_source: "order", supply_source: "listings" }, "geo_field")).toBe(false);
    expect(isOptionalField({ location_source: "user", supply_source: "listings" }, "listed_at_field")).toBe(true);
  });
});

describe("buildSelfServeConfig", () => {
  it("keeps a confirmed listing id on the order for the booked-listings count (first-version setups had it)", () => {
    const withRef = { ...COMPLETE, supply_demand: { confirmed: true }, bookings: { ...COMPLETE.bookings, listing_ref_field: "itemId" } };
    expect(buildSelfServeConfig(T, withRef as never)?.bookings.listing_ref_field).toBe("itemId");
  });

  it("location on the order, every listing as supply", () => {
    const cfg = buildSelfServeConfig(T, COMPLETE as never);
    expect(cfg).toMatchObject({ location_source: "order", supply_source: "listings" });
    expect(cfg?.bookings.geo_field).toBe("city");
    expect(cfg?.listings).toEqual({ table: "items", id_field: "_id", geo_field: "address.city", listed_at_field: null });
    expect(cfg?.location_table).toBeNull();
    expect(cfg?.provenance.source).toBe("self_serve_confirmed");
  });

  it("used goods: location through the listing, supply = listings created in the window", () => {
    const cfg = buildSelfServeConfig(T, GOODS as never);
    expect(cfg?.bookings).toMatchObject({ listing_ref_field: "item_id", geo_field: null, buyer_ref_field: null });
    expect(cfg?.listings).toMatchObject({ table: "items", id_field: "id", geo_field: "city", listed_at_field: "created_at" });
  });

  it("local services: location through the customer, supply = providers on orders, no listings table", () => {
    const cfg = buildSelfServeConfig(T, SERVICES as never);
    expect(cfg?.listings).toBeNull();
    expect(cfg?.location_table).toEqual({ table: "accounts", id_field: "id", geo_field: "suburb" });
    expect(cfg?.bookings).toMatchObject({ buyer_ref_field: "customer_id", seller_ref_field: "provider_id" });
  });

  it("no location and no supply measure is still a valid setup", () => {
    const cfg = buildSelfServeConfig(T, WHOLESALE as never);
    expect(cfg).toMatchObject({ location_source: "none", supply_source: "none", listings: null, location_table: null });
  });

  it("ignores fields the answers do not use, so a stale column never drives a query", () => {
    const withExtras = { ...SERVICES, bookings: { ...SERVICES.bookings, geo_field: "old_city", listing_ref_field: "old_ref" }, listings: { table: "old_items", id_field: "id" } };
    const cfg = buildSelfServeConfig(T, withExtras as never);
    expect(cfg?.bookings.geo_field).toBeNull();
    expect(cfg?.bookings.listing_ref_field).toBeNull();
    expect(cfg?.listings).toBeNull();
  });

  it("is null when a required answer is missing", () => {
    expect(buildSelfServeConfig(T, { ...GOODS, listings: { table: "items", id_field: "id" } } as never)).toBeNull();
    expect(buildSelfServeConfig(T, { ...SERVICES, supply_demand_location: undefined } as never)).toBeNull();
    expect(buildSelfServeConfig(T, { ...SERVICES, bookings: { table: "jobs", created_at_field: "booked_at" } } as never)).toBeNull();
  });

  it("a growth-diagnosis confirmation WITHOUT the Supply & Demand opt-in is never a setup (no silent DB reads)", () => {
    const { supply_demand: _optIn, ...noMarker } = COMPLETE;
    expect(buildSelfServeConfig(T, noMarker as never)).toBeNull();
  });

  it("a marker with unknown choices is not a setup", () => {
    expect(buildSelfServeConfig(T, { ...COMPLETE, supply_demand: { confirmed: true, version: 2, location_source: "planet", supply_source: "listings" } } as never)).toBeNull();
  });

  it("a first-version marker (no choices) still means location on orders, listings as supply", () => {
    const cfg = buildSelfServeConfig(T, { ...COMPLETE, supply_demand: { confirmed: true } } as never);
    expect(cfg).toMatchObject({ location_source: "order", supply_source: "listings" });
  });
});

describe("resolveMarketplaceConfig", () => {
  it("no tenant has a hand-written config: without a confirmed mapping there is no setup", async () => {
    mocks.confirmed = null;
    expect(await resolveMarketplaceConfig("73db45ff-457e-4541-bc8f-bdb625390204")).toBeNull();
  });

  it("derives from a confirmed mapping on a MongoDB catalog", async () => {
    mocks.confirmed = { confirmed_map: COMPLETE };
    expect((await resolveMarketplaceConfig(T))?.bookings.table).toBe("orders");
  });

  it("derives a Postgres/MySQL setup with the catalog's dialect", async () => {
    mocks.confirmed = { confirmed_map: SERVICES };
    for (const dialect of ["postgres", "mysql"]) {
      mocks.catalog = { ...CATALOG, dialect };
      expect((await resolveMarketplaceConfig(T))?.dialect).toBe(dialect);
    }
  });

  it("is null for unsupported engines, failed discovery, or no confirmation", async () => {
    mocks.confirmed = { confirmed_map: COMPLETE };
    mocks.catalog = { ...CATALOG, dialect: "dynamodb" };
    expect(await resolveMarketplaceConfig(T)).toBeNull();
    mocks.catalog = { ...CATALOG, discovery_error: "boom" };
    expect(await resolveMarketplaceConfig(T)).toBeNull();
    mocks.catalog = CATALOG;
    mocks.confirmed = null;
    expect(await resolveMarketplaceConfig(T)).toBeNull();
  });
});

describe("getSupplyDemandSetup", () => {
  it("walks the states: no db → unsupported → discovering → failed", async () => {
    mocks.dialect = null;
    expect((await getSupplyDemandSetup(T)).state).toBe("no_db");
    mocks.dialect = "dynamodb";
    expect(await getSupplyDemandSetup(T)).toEqual({ state: "unsupported_db", db_type: "dynamodb" });
    mocks.dialect = "mongodb";
    mocks.catalog = null;
    expect((await getSupplyDemandSetup(T)).state).toBe("discovering");
    mocks.catalog = { ...CATALOG, discovery_error: "x" };
    expect((await getSupplyDemandSetup(T)).state).toBe("discovery_failed");
  });

  it("a refused listings table still asks the Listings question", async () => {
    mocks.catalog = {
      ...CATALOG,
      catalog_hash: "h3",
      catalog: {
        tables: [
          { name: "engagements", columns: [{ name: "createdAt" }, { name: "city" }] },
          { name: "jobs", columns: [{ name: "_id" }, { name: "town" }, { name: "posted_at" }] },
        ],
      },
      hints: {
        bookings: { table: "engagements", created_at_field: "createdAt", geo_field: "city" },
        listings: { table: "jobs", id_field: "_id" },
      },
    };
    const setup = await getSupplyDemandSetup(T);
    const form = setup as Extract<typeof setup, { state: "needs_confirm" }>;
    expect(form.choices.supply_source).toBe("listings");
    expect(Object.keys(form.roles)).toContain("listings");
    expect(form.proposed.listings?.table).not.toBe("jobs");
  });

  it("a refused listings table does not cost a zero-input supply answer", async () => {
    mocks.catalog = {
      ...CATALOG,
      catalog_hash: "h4",
      catalog: {
        tables: [
          { name: "bookings", columns: [{ name: "createdAt" }, { name: "city" }, { name: "host_id" }] },
          { name: "rentals", columns: [{ name: "_id" }, { name: "town" }, { name: "posted_at" }] },
        ],
      },
      hints: {
        bookings: { table: "bookings", created_at_field: "createdAt", geo_field: "city", seller_ref_field: "host_id" },
        listings: { table: "rentals", id_field: "_id" },
      },
    };
    const setup = await getSupplyDemandSetup(T);
    const form = setup as Extract<typeof setup, { state: "needs_confirm" }>;
    expect(form.choices.supply_source).toBe("sellers_on_orders");
    expect(form.proposed.bookings?.seller_ref_field).toBe("host_id");
  });

  it("a reconnect that mints a new catalog hash still offers the founder's own answers", async () => {
    mocks.catalog = {
      ...CATALOG,
      catalog_hash: "h2",
      catalog: {
        tables: [
          { name: "orders", columns: [{ name: "createdAt" }, { name: "city" }, { name: "buyer" }] },
          { name: "people", columns: [{ name: "_id" }, { name: "town" }] },
        ],
      },
    };
    mocks.latest = {
      confirmed_map: {
        supply_demand: { confirmed: true, version: 2, location_source: "user", supply_source: "none" },
        bookings: { table: "orders", created_at_field: "createdAt", buyer_ref_field: "buyer" },
        supply_demand_location: { table: "people", id_field: "_id", geo_field: "town" },
      },
    };
    const setup = await getSupplyDemandSetup(T);
    expect(setup).toMatchObject({
      state: "needs_confirm",
      catalog_hash: "h2",
      choices: { location_source: "user", supply_source: "none" },
    });
    const form = setup as Extract<typeof setup, { state: "needs_confirm" }>;
    expect(form.proposed.bookings).toMatchObject({ table: "orders", buyer_ref_field: "buyer" });
    expect(form.proposed.supply_demand_location).toMatchObject({ table: "people", geo_field: "town" });
  });

  it("answers that no longer fit the database are not offered back", async () => {
    mocks.catalog = { ...CATALOG, catalog_hash: "h2" };
    mocks.latest = {
      confirmed_map: {
        supply_demand: { confirmed: true, version: 2, location_source: "user", supply_source: "none" },
        bookings: { table: "orders", created_at_field: "createdAt", buyer_ref_field: "buyer" },
        supply_demand_location: { table: "people_gone", id_field: "_id", geo_field: "town" },
      },
    };
    const setup = await getSupplyDemandSetup(T);
    const form = setup as Extract<typeof setup, { state: "needs_confirm" }>;
    expect(form.choices.location_source).not.toBe("user");
    expect(form.proposed.supply_demand_location?.table).not.toBe("people_gone");
  });

  it("the empty catalog written on (re)connect reads as discovering, not an empty form", async () => {
    mocks.catalog = { ...CATALOG, catalog: {}, hints: {} };
    expect((await getSupplyDemandSetup(T)).state).toBe("discovering");
  });

  it("needs_confirm proposes only what this database actually has", async () => {
    const s = await getSupplyDemandSetup(T);
    expect(s.state).toBe("needs_confirm");
    if (s.state !== "needs_confirm") return;
    expect(s.catalog_hash).toBe("h1");
    expect(Object.keys(s.proposed)).toEqual(["bookings"]);
    expect(s.proposed.bookings?.created_at_field).toBe("createdAt");
    expect(s.proposed.bookings?.geo_field).toBeUndefined();
    expect(s.choices).toEqual({ location_source: "none", supply_source: "none" });
    expect(s.roles).toEqual(supplyDemandRoles(s.choices));
    expect(s.schema.tables[0]).toEqual({ name: "orders", columns: ["createdAt"] });
  });

  it("guesses the tables and columns from the schema when the hints are empty", async () => {
    mocks.catalog = {
      ...CATALOG,
      hints: {},
      catalog: {
        tables: [
          {
            name: "reservations",
            columns: [
              { name: "id", type: "uuid" },
              { name: "booked_at", type: "timestamptz" },
              { name: "room_id", type: "uuid" },
              { name: "guest_id", type: "uuid" },
              { name: "host_id", type: "uuid" },
            ],
          },
          {
            name: "rooms",
            columns: [
              { name: "id", type: "uuid" },
              { name: "town", type: "text" },
              { name: "published_at", type: "timestamptz" },
            ],
          },
          { name: "guests", columns: [{ name: "id", type: "uuid" }, { name: "district", type: "text" }] },
        ],
      },
    };
    const s = await getSupplyDemandSetup(T);
    if (s.state !== "needs_confirm") throw new Error(s.state);
    expect(s.proposed.bookings).toMatchObject({
      table: "reservations",
      created_at_field: "booked_at",
      listing_ref_field: "room_id",
      buyer_ref_field: "guest_id",
      seller_ref_field: "host_id",
    });
    expect(s.proposed.listings).toMatchObject({ table: "rooms", geo_field: "town", listed_at_field: "published_at" });
    expect(s.proposed.supply_demand_location).toMatchObject({ table: "guests", geo_field: "district" });
    expect(s.choices).toEqual({ location_source: "listing", supply_source: "listings" });
  });

  it("with no location or listings in the guesses, the choices say so", async () => {
    mocks.catalog = { ...CATALOG, hints: { bookings: { table: "purchase_orders", created_at_field: "placed_at" } } };
    const s = await getSupplyDemandSetup(T);
    if (s.state !== "needs_confirm") throw new Error(s.state);
    expect(s.choices).toEqual({ location_source: "none", supply_source: "none" });
  });

  it("a prior confirmation's values and choices beat the guesses in the form", async () => {
    mocks.confirmed = {
      confirmed_map: {
        supply_demand: { confirmed: true, version: 2, location_source: "user", supply_source: "sellers_on_orders" },
        bookings: { table: "jobs", created_at_field: "booked_at" },
      },
    };
    const s = await getSupplyDemandSetup(T);
    if (s.state !== "needs_confirm") throw new Error(s.state);
    expect(s.proposed.bookings?.table).toBe("orders");
    expect(s.choices).toEqual({ location_source: "none", supply_source: "none" });
  });

  it("offers only what can be confirmed, even when discovery stopped early", async () => {
    mocks.catalog = {
      ...CATALOG,
      coverage: { tables_total: 400, tables_indexed: 50, skipped_unsafe_names: 0, deadline_hit: true, listing_truncated: false },
    };
    mocks.confirmed = {
      confirmed_map: {
        supply_demand: { confirmed: true, version: 2, location_source: "order", supply_source: "none" },
        bookings: { table: "jobs", created_at_field: "booked_at", geo_field: "town" },
      },
    };
    const s = await getSupplyDemandSetup(T, { formEvenIfConfirmed: true });
    if (s.state !== "needs_confirm") throw new Error(s.state);
    expect(s.proposed.bookings?.table).toBe("orders");
  });

  it("complete confirmation → waiting_first_run", async () => {
    mocks.confirmed = { confirmed_map: GOODS };
    expect((await getSupplyDemandSetup(T)).state).toBe("waiting_first_run");
  });
});

function answersOf(map: { supply_demand: { location_source: string; supply_source: string } } & Record<string, unknown>) {
  const { supply_demand, ...roles } = map;
  return { ...roles, location_source: supply_demand.location_source, supply_source: supply_demand.supply_source };
}

describe("mergeSupplyDemandAnswers", () => {
  it("keeps roles and fields growth diagnosis confirmed, and writes only enums in the marker", () => {
    const existing = {
      cancellations: { table: "orders", reason_field: "cancelReason" },
      users: { table: "accounts", id_field: "id" },
      bookings: { table: "jobs", gmv_proxy_field: "total" },
    };
    const r = mergeSupplyDemandAnswers(existing as never, answersOf(SERVICES) as never);
    if ("error" in r) throw new Error(r.error);
    expect(r.map.cancellations).toEqual(existing.cancellations);
    expect(r.map.users).toEqual(existing.users);
    expect(r.map.bookings.gmv_proxy_field).toBe("total");
    expect(r.map.bookings.seller_ref_field).toBe("provider_id");
    expect(r.map.supply_demand_location).toMatchObject({ table: "accounts", id_field: "id", geo_field: "suburb" });
    expect((r.map as Record<string, unknown>).supply_demand).toEqual({
      confirmed: true,
      version: 2,
      location_source: "user",
      supply_source: "sellers_on_orders",
    });
  });

  it("the optional listing date may be left empty", () => {
    const r = mergeSupplyDemandAnswers(null, { ...answersOf(GOODS), listings: { table: "items", id_field: "id", geo_field: "city", listed_at_field: "" } } as never);
    if ("error" in r) throw new Error(r.error);
    expect(r.map.listings.listed_at_field).toBeUndefined();
  });

  it("answers from the page before the questions existed mean location on orders, listings as supply", () => {
    const legacy = {
      bookings: { table: "orders", created_at_field: "createdAt", geo_field: "city" },
      listings: { table: "items", id_field: "_id", geo_field: "city" },
    };
    const r = mergeSupplyDemandAnswers(null, legacy as never);
    if ("error" in r) throw new Error(r.error);
    expect((r.map as Record<string, unknown>).supply_demand).toMatchObject({ location_source: "order", supply_source: "listings" });
  });

  it("drops columns confirmed on a table the founder switched away from", () => {
    const existing = { bookings: { table: "trips", gmv_proxy_field: "amount" } };
    const r = mergeSupplyDemandAnswers(existing as never, COMPLETE as never);
    if ("error" in r) throw new Error(r.error);
    expect(r.map.bookings.gmv_proxy_field).toBeUndefined();
  });

  it("rejects missing required answers, unknown choices and operator-shaped names — and says WHICH answer", () => {
    expect(
      mergeSupplyDemandAnswers(null, { ...answersOf(GOODS), bookings: { table: "orders", created_at_field: "sold_at" } } as never),
    ).toEqual({ error: "invalid_answers", field: "bookings.listing_ref_field", reason: "missing" });
    expect(
      mergeSupplyDemandAnswers(null, { ...answersOf(SERVICES), bookings: { ...SERVICES.bookings, buyer_ref_field: "$where" } } as never),
    ).toEqual({ error: "invalid_answers", field: "bookings.buyer_ref_field", reason: "unsafe_name" });
    expect(
      mergeSupplyDemandAnswers(null, { ...COMPLETE, location_source: "planet", supply_source: "listings" } as never),
    ).toEqual({ error: "invalid_answers", field: "location_source", reason: "not_allowed" });
    expect(mergeSupplyDemandAnswers(null, { location_source: "order" } as never)).toEqual({
      error: "invalid_answers",
      field: "supply_source",
      reason: "not_allowed",
    });
    expect(mergeSupplyDemandAnswers(null, {} as never)).toMatchObject({ error: "invalid_answers", reason: "missing" });
  });

  it("the form says which answers it accepts and what each one asks for", async () => {
    const s = await getSupplyDemandSetup(T);
    if (s.state !== "needs_confirm") throw new Error(s.state);
    expect(s.options.location_source).toEqual(["order", "listing", "user", "none"]);
    expect(s.options.supply_source).toEqual(["listings", "sellers_on_orders", "none"]);
    expect(Object.keys(s.options.roles_by_pair)).toHaveLength(12);
    const user = s.options.roles_by_pair["user|sellers_on_orders"];
    expect(user?.bookings).toEqual(expect.arrayContaining(["buyer_ref_field", "seller_ref_field"]));
    expect(user?.supply_demand_location).toContain("geo_field");
    for (const location_source of ["order", "listing", "user", "none"] as const) {
      for (const supply_source of ["listings", "sellers_on_orders", "none"] as const) {
        expect(s.options.roles_by_pair[`${location_source}|${supply_source}`]).toEqual(
          supplyDemandRoles({ location_source, supply_source }),
        );
      }
    }
  });
});
