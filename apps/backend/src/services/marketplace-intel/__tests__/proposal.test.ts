import { describe, expect, it } from "vitest";
import { proposeFromSchema, unbackedRefs, type ProposalSchema } from "../proposal";

const LABELS = { bookings: "Orders", listings: "Listings", customers: "Customers" };

const col = (name: string, type = "text") => ({ name, type });

const FREIGHT: ProposalSchema = {
  tables: [
    {
      name: "loads",
      columns: [col("id", "uuid"), col("posted_at", "timestamptz"), col("origin_city"), col("carrier_id", "uuid"), col("shipper_id", "uuid"), col("rate_usd", "numeric")],
      rowEstimate: 1200,
    },
    { name: "trucks", columns: [col("id", "uuid"), col("base_state"), col("listed_on", "timestamptz")], rowEstimate: 300 },
    { name: "shippers", columns: [col("id", "uuid"), col("hq_region")], rowEstimate: 80 },
  ] as never,
};

describe("proposeFromSchema", () => {
  it("finds the orders table by shape when its name matches no word (a freight board calls them loads)", () => {
    const p = proposeFromSchema(FREIGHT, {}, LABELS);
    expect(p.bookings).toMatchObject({ table: "loads", created_at_field: "posted_at", geo_field: "origin_city" });
    expect(p.listings).toBeUndefined();
    expect(p.customers).toBeUndefined();
  });

  it("guesses every role when the names are ordinary", () => {
    const shop: ProposalSchema = {
      tables: [
        { name: "orders", columns: [col("id", "uuid"), col("placed_at", "timestamptz"), col("product_id", "uuid"), col("customer_id", "uuid")], rowEstimate: 900 },
        { name: "products", columns: [col("id", "uuid"), col("city"), col("created_at", "timestamptz")], rowEstimate: 400 },
        { name: "customers", columns: [col("id", "uuid"), col("region")], rowEstimate: 200 },
      ] as never,
    };
    const p = proposeFromSchema(shop, {}, LABELS);
    expect(p.bookings).toMatchObject({ table: "orders", created_at_field: "placed_at", listing_ref_field: "product_id", buyer_ref_field: "customer_id" });
    expect(p.listings).toMatchObject({ table: "products", geo_field: "city" });
    expect(p.customers).toMatchObject({ table: "customers", geo_field: "region" });
  });

  it("never proposes a column the table does not have, and fills the gap from the schema", () => {
    const p = proposeFromSchema(
      FREIGHT,
      { bookings: { table: "loads", created_at_field: "created_at", geo_field: "city" } as never },
      LABELS,
    );
    expect(p.bookings?.created_at_field).toBe("posted_at");
    expect(p.bookings?.geo_field).toBe("origin_city");
  });

  it("never proposes a table the catalog does not have", () => {
    const p = proposeFromSchema(FREIGHT, { listings: { table: "gone_table", id_field: "id" } as never }, LABELS);
    expect(p.listings?.table).not.toBe("gone_table");
    expect(["trucks", undefined]).toContain(p.listings?.table);
  });

  it("offers only what can be confirmed, even when discovery stopped early", () => {
    const p = proposeFromSchema(
      FREIGHT,
      { bookings: { table: "not_indexed_yet", created_at_field: "whenever" } as never },
      LABELS,
      { complete: false },
    );
    expect(p.bookings?.table).toBe("loads");
  });

  it("prefers the big table over a small one with a textbook date column (SQL)", () => {
    const sql: ProposalSchema = {
      tables: [
        { name: "deals", columns: [col("id", "uuid"), col("signed_at", "timestamptz"), col("city"), col("buyer_id", "uuid")], rowEstimate: 500000 },
        { name: "webhook_deliveries", columns: [col("id", "uuid"), col("url"), col("created_at", "timestamptz")], rowEstimate: 40 },
      ] as never,
    };
    const p = proposeFromSchema(sql, {}, LABELS);
    expect(p.bookings).toMatchObject({ table: "deals", created_at_field: "signed_at", geo_field: "city" });
  });

  it("finds the orders table on an engine that reports no row counts (MongoDB)", () => {
    const mongo: ProposalSchema = {
      tables: [
        { name: "audit_events", columns: [col("_id", "objectId"), col("at", "date")], rowEstimate: null },
        {
          name: "gigs",
          columns: [col("_id", "objectId"), col("booked_at", "date"), col("town"), col("worker_id", "objectId")],
          rowEstimate: null,
        },
      ] as never,
    };
    const p = proposeFromSchema(mongo, {}, LABELS);
    expect(p.bookings).toMatchObject({ table: "gigs", created_at_field: "booked_at", geo_field: "town" });
  });

  it("a column nothing points at is not promoted by its type alone", () => {
    const schema: ProposalSchema = {
      tables: [{ name: "orders", columns: [col("id", "uuid"), col("note"), col("sku")], rowEstimate: 10 }] as never,
    };
    const p = proposeFromSchema(schema, {}, LABELS);
    expect(p.bookings?.geo_field).toBeUndefined();
  });

  it("does not read an id column as a date, or a timestamp as a location", () => {
    const schema: ProposalSchema = {
      tables: [
        {
          name: "bookings",
          columns: [col("order_id", "uuid"), col("order_date", "timestamptz"), col("region_updated_at", "timestamptz")],
          rowEstimate: 10,
        },
      ] as never,
    };
    const p = proposeFromSchema(schema, {}, LABELS);
    expect(p.bookings?.created_at_field).toBe("order_date");
    expect(p.bookings?.geo_field).toBeUndefined();
  });

  it("two roles never land on the same table by guesswork", () => {
    const schema: ProposalSchema = {
      tables: [
        { name: "orders", columns: [col("id", "uuid"), col("created_at", "timestamptz")], rowEstimate: 5 },
        { name: "order_items", columns: [col("id", "uuid"), col("city")], rowEstimate: 5 },
      ] as never,
    };
    const p = proposeFromSchema(schema, {}, LABELS);
    expect(p.bookings?.table).toBe("orders");
    expect(p.listings?.table).toBe("order_items");
  });

  it("uses the only date column when no name matches", () => {
    const schema: ProposalSchema = {
      tables: [{ name: "purchases", columns: [col("id", "uuid"), col("ts", "timestamptz"), col("town")], rowEstimate: 5 }] as never,
    };
    const p = proposeFromSchema(schema, {}, LABELS);
    expect(p.bookings).toMatchObject({ created_at_field: "ts", geo_field: "town" });
  });
});

describe("a discovery hint that names the wrong role", () => {
  const FREIGHT_MONGO: ProposalSchema = {
    tables: [
      {
        name: "loads",
        columns: [col("_id", "objectId"), col("carrier_id", "objectId"), col("destination"), col("origin"), col("posted_at", "date"), col("rate_usd", "double")],
        rowEstimate: null,
      },
      { name: "trucks", columns: [col("_id", "objectId"), col("base_state"), col("carrier_id", "objectId"), col("plate")], rowEstimate: null },
      { name: "carriers", columns: [col("_id", "objectId"), col("hq"), col("name")], rowEstimate: null },
    ] as never,
  };

  it("the table's own name wins: the orders collection is not filed as Listings", () => {
    const p = proposeFromSchema(FREIGHT_MONGO, { listings: { table: "loads", id_field: "_id" } as never }, LABELS);
    expect(p.bookings).toMatchObject({ table: "loads", created_at_field: "posted_at", geo_field: "origin" });
    expect(p.listings).toBeUndefined();
  });

  it("a FOUNDER's own answer is not second-guessed by the table's name", () => {
    const p = proposeFromSchema(
      FREIGHT_MONGO,
      { listings: { table: "loads", id_field: "_id" } as never },
      LABELS,
      { confirmed: new Set(["listings"]) },
    );
    expect(p.listings).toMatchObject({ table: "loads" });
    expect(p.bookings?.table).not.toBe("loads");
  });

  it("the orders collection is not offered as Listings even when Orders is hinted elsewhere", () => {
    const p = proposeFromSchema(
      FREIGHT_MONGO,
      { bookings: { table: "trucks" } as never, listings: { table: "loads", id_field: "_id" } as never },
      LABELS,
    );
    expect(p.bookings?.table).toBe("trucks");
    expect(p.listings).toBeUndefined();
  });

  it("a guess for an earlier role never takes a table a later role was confirmed on", () => {
    const shop: ProposalSchema = {
      tables: [
        { name: "orders", columns: [col("id", "uuid"), col("placed_at", "timestamptz"), col("city")], rowEstimate: 900 },
        { name: "products", columns: [col("id", "uuid"), col("region"), col("created_at", "timestamptz")], rowEstimate: 400 },
      ] as never,
    };
    const p = proposeFromSchema(
      shop,
      { bookings: { table: "orders" } as never, listings: { table: "orders", id_field: "id" } as never },
      LABELS,
      { confirmed: new Set(["listings", "listings.table", "listings.id_field"]) },
    );
    expect(p.listings?.table).toBe("orders");
    expect(p.bookings?.table).not.toBe("orders");
  });

  it("a half-crossed pair: the crossed hint still loses its table", () => {
    const shop: ProposalSchema = {
      tables: [
        { name: "orders", columns: [col("id", "uuid"), col("placed_at", "timestamptz"), col("city")], rowEstimate: 900 },
        { name: "sales", columns: [col("id", "uuid"), col("sold_at", "timestamptz"), col("town")], rowEstimate: 700 },
        { name: "products", columns: [col("id", "uuid"), col("region"), col("created_at", "timestamptz")], rowEstimate: 400 },
      ] as never,
    };
    const p = proposeFromSchema(
      shop,
      { bookings: { table: "sales" } as never, listings: { table: "orders" } as never },
      LABELS,
    );
    expect(p.listings?.table).not.toBe("orders");
  });

  it("two swapped hints both lose: each table goes to the role its name names", () => {
    const shop: ProposalSchema = {
      tables: [
        { name: "orders", columns: [col("id", "uuid"), col("placed_at", "timestamptz"), col("city")], rowEstimate: 900 },
        { name: "products", columns: [col("id", "uuid"), col("region"), col("created_at", "timestamptz")], rowEstimate: 400 },
      ] as never,
    };
    const p = proposeFromSchema(
      shop,
      { bookings: { table: "products" } as never, listings: { table: "orders" } as never },
      LABELS,
    );
    expect(p.bookings?.table).toBe("orders");
    expect(p.listings?.table).toBe("products");
  });

  it("two roles never share one table", () => {
    const shop: ProposalSchema = {
      tables: [
        { name: "orders", columns: [col("id", "uuid"), col("placed_at", "timestamptz"), col("city")], rowEstimate: 900 },
        { name: "products", columns: [col("id", "uuid"), col("region"), col("created_at", "timestamptz")], rowEstimate: 400 },
      ] as never,
    };
    const p = proposeFromSchema(
      shop,
      { bookings: { table: "orders" } as never, listings: { table: "orders" } as never },
      LABELS,
    );
    expect(p.bookings?.table).toBe("orders");
    expect(p.listings?.table).not.toBe("orders");
  });

  it("a hinted column that cannot hold a location is replaced, not offered", () => {
    const nested: ProposalSchema = {
      tables: [
        {
          name: "loads",
          columns: [col("_id", "objectId"), col("posted_at", "date"), col("origin", "Document"), col("origin_city", "String")],
          rowEstimate: null,
        },
      ] as never,
    };
    const p = proposeFromSchema(nested, { bookings: { table: "loads", geo_field: "origin" } as never }, LABELS);
    expect(p.bookings?.geo_field).toBe("origin_city");
  });

  it("a confirmed table does not exempt a column the founder never answered", () => {
    const nested: ProposalSchema = {
      tables: [
        {
          name: "trips",
          columns: [col("_id", "objectId"), col("createdAt", "Date"), col("location", "Document"), col("city", "String")],
          rowEstimate: null,
        },
      ] as never,
    };
    const p = proposeFromSchema(
      nested,
      { bookings: { table: "trips", created_at_field: "createdAt", geo_field: "location" } as never },
      LABELS,
      { confirmed: new Set(["bookings", "bookings.table", "bookings.created_at_field"]) },
    );
    expect(p.bookings?.table).toBe("trips");
    expect(p.bookings?.geo_field).toBe("city");
  });

  it("a compound location name still matches after the camelCase split", () => {
    const uk: ProposalSchema = {
      tables: [
        {
          name: "orders",
          columns: [col("_id", "String"), col("createdAt", "Date"), col("postCode", "String")],
          rowEstimate: 500,
        },
      ] as never,
    };
    expect(proposeFromSchema(uk, {}, LABELS).bookings?.geo_field).toBe("postCode");
  });

  it("a hint the name does not contradict is still honoured", () => {
    const p = proposeFromSchema(FREIGHT_MONGO, { listings: { table: "trucks", id_field: "_id" } as never }, LABELS);
    expect(p.listings).toMatchObject({ table: "trucks", geo_field: "base_state" });
    expect(p.bookings?.table).toBe("loads");
  });
});

describe("camelCase schemas (JS/Mongo style)", () => {
  const CAMEL: ProposalSchema = {
    tables: [
      {
        name: "trips",
        columns: [
          col("_id", "String"),
          col("createdAt", "Date"),
          col("pickUpLocation", "String"),
          col("carId", "String"),
          col("pendingPaymentFromUser", "Number"),
          col("forcedHostProtectionPlan", "Null|String"),
          col("carOwnerId", "String"),
          col("userId", "String"),
        ],
        rowEstimate: 5000,
      },
      { name: "carlistings", columns: [col("_id", "String"), col("state"), col("createdAt", "Date")], rowEstimate: 900 },
      { name: "users", columns: [col("_id", "String"), col("country")], rowEstimate: 400 },
    ] as never,
  };

  it("picks the id-shaped reference over a flag that merely contains the role word", () => {
    const p = proposeFromSchema(CAMEL, {}, LABELS);
    expect(p.bookings).toMatchObject({
      table: "trips",
      created_at_field: "createdAt",
      geo_field: "pickUpLocation",
      buyer_ref_field: "userId",
      seller_ref_field: "carOwnerId",
    });
    expect(JSON.stringify(p)).not.toContain("forcedHostProtectionPlan");
    expect(JSON.stringify(p)).not.toContain("pendingPaymentFromUser");
    expect(p.bookings?.listing_ref_field).toBeUndefined();
    const hinted = proposeFromSchema(CAMEL, { bookings: { table: "trips", listing_ref_field: "carId" } as never }, LABELS);
    expect(hinted.bookings).toMatchObject({ listing_ref_field: "carId", seller_ref_field: "carOwnerId" });
  });

  it("never offers a flag as a reference, however its name reads", () => {
    const flags: ProposalSchema = {
      tables: [
        {
          name: "trips",
          columns: [col("_id", "String"), col("createdAt", "Date"), col("carArea"), col("isTeslaVehicle", "Boolean")],
          rowEstimate: 100,
        },
      ] as never,
    };
    const p = proposeFromSchema(flags, {}, LABELS);
    expect(p.bookings?.listing_ref_field).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("isTeslaVehicle");
  });

  it("splits camelCase into words, so a whole-word match is possible at all", () => {
    const p = proposeFromSchema(
      { tables: [{ name: "bookingRecords", columns: [col("bookedAt", "Date"), col("cityName"), col("guestId", "String")], rowEstimate: 10 }] as never },
      {},
      LABELS,
    );
    expect(p.bookings).toMatchObject({ table: "bookingRecords", created_at_field: "bookedAt", geo_field: "cityName", buyer_ref_field: "guestId" });
  });
});

describe("an empty or missing catalog", () => {
  it("proposes nothing and rejects nothing, instead of throwing", () => {
    expect(() => proposeFromSchema(undefined, {}, LABELS)).not.toThrow();
    expect(proposeFromSchema({ tables: [] } as never, {}, LABELS)).toEqual({});
    expect(unbackedRefs(undefined, { bookings: { table: "anything", geo_field: "x" } } as never)).toEqual([]);
  });
});

describe("unbackedRefs", () => {
  it("names every table and column the catalog no longer backs", () => {
    const bad = unbackedRefs(FREIGHT, {
      bookings: { table: "loads", created_at_field: "posted_at", geo_field: "city" },
      listings: { table: "gone", id_field: "id" },
    } as never);
    expect(bad).toContain("bookings.geo_field");
    expect(bad).toContain("listings.table");
    expect(bad).not.toContain("bookings.created_at_field");
  });
});
