
import { describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { assembleIntel, computeMongoRollup } from "../aggregate";
import { computeSqlRollup } from "../aggregate-sql";
import { openLiveMongoDb, openLiveSession } from "./live-session";

vi.mock("@/services/data-gateway/audit", () => ({
  reserveAudit: vi.fn(async () => "live-log"),
  finalizeAudit: vi.fn(async () => undefined),
  writeRefusalAudit: vi.fn(async () => null),
}));
import type { MarketplaceIntelConfig } from "../contract";

async function rollupAt(
  dialect: "postgres" | "mysql",
  url: string,
  cfg: Parameters<typeof computeSqlRollup>[2],
  opts?: Parameters<typeof computeSqlRollup>[3],
): ReturnType<typeof computeSqlRollup> {
  const session = await openLiveSession(dialect, url);
  try {
    return await computeSqlRollup(dialect, session, cfg, opts);
  } finally {
    await session.close();
  }
}

const PG = process.env.SD_LIVE_PG;
const MYSQL = process.env.SD_LIVE_MYSQL;
const MONGO = process.env.SD_LIVE_MONGO;

async function guardedMongoRollup(cfg: MarketplaceIntelConfig, opts?: Parameters<typeof computeMongoRollup>[2]) {
  const live = await openLiveMongoDb(MONGO!);
  return computeMongoRollup(live.db, cfg, opts).finally(() => live.close());
}

const DAY = 24 * 3600 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

function baseConfig(over: Partial<MarketplaceIntelConfig>): MarketplaceIntelConfig {
  return {
    tenant_id: "00000000-0000-4000-8000-00000000abcd",
    dialect: "postgres",
    location_source: "order",
    supply_source: "none",
    bookings: {
      table: "orders",
      created_at_field: "created_at",
      geo_field: null,
      listing_ref_field: null,
      seller_ref_field: null,
      buyer_ref_field: null,
      gmv_proxy_field: null,
    },
    listings: null,
    location_table: null,
    category: { source: "none_on_trips", note: "" },
    intent_events: { search: null, view: null, contact: null },
    provenance: { source: "self_serve_confirmed", validated: true },
    ...over,
  };
}

const labelsOf = (intel: ReturnType<typeof assembleIntel>) =>
  Object.fromEntries(intel.regions.map((r) => [r.region_label, r.balance_label]));

describe.skipIf(!PG)("Postgres: used goods sold once, location on the listing, supply = listings created in the window", () => {
  it("labels the city that sold out and the one that did not, never files 'Mumbai, IN' under Indiana", async () => {
    const { Client } = await import("pg");
    const db = new Client({ connectionString: PG });
    await db.connect();
    try {
      await db.query(`DROP TABLE IF EXISTS sale_orders; DROP TABLE IF EXISTS items;`);
      await db.query(`CREATE TABLE items (id int PRIMARY KEY, city text, listed_on timestamptz)`);
      await db.query(`CREATE TABLE sale_orders (id serial PRIMARY KEY, item_ref text, sold_on timestamptz)`);
      const sold: Record<string, number> = { Lagos: 36, Nairobi: 20, Accra: 18, Kampala: 4 };
      let id = 1;
      for (const [city, n] of Object.entries(sold)) {
        const first = id;
        for (let i = 0; i < 40; i++) {
          await db.query(`INSERT INTO items VALUES ($1, $2, $3)`, [id++, city, ago(30)]);
        }
        for (let i = 0; i < n; i++) {
          await db.query(`INSERT INTO sale_orders (item_ref, sold_on) VALUES ($1, $2)`, [String(first + i), ago(5)]);
        }
      }
      await db.query(`INSERT INTO items VALUES ($1, 'Lagos', $2)`, [id++, ago(400)]);
      await db.query(`INSERT INTO items VALUES ($1, 'Mumbai, IN', $2)`, [id, ago(10)]);
      await db.query(`INSERT INTO sale_orders (item_ref, sold_on) VALUES ($1, $2)`, [String(id), ago(3)]);

      const cfg = baseConfig({
        dialect: "postgres",
        location_source: "listing",
        supply_source: "listings",
        bookings: { ...baseConfig({}).bookings, table: "sale_orders", created_at_field: "sold_on", listing_ref_field: "item_ref" },
        listings: { table: "items", id_field: "id", geo_field: "city", listed_at_field: "listed_on" },
      });
      const { cells, supply } = await rollupAt("postgres", PG!, cfg);
      const intel = assembleIntel(cells, supply, { tenant_id: cfg.tenant_id, min_cell: 1 });

      expect(labelsOf(intel)).toMatchObject({
        Lagos: "demand_heavy",
        Nairobi: "balanced",
        Accra: "balanced",
        Kampala: "supply_heavy",
      });
      expect(intel.regions.find((r) => r.region_label === "Lagos")?.completed_listings).toBe(40);
      const mumbai = intel.regions.find((r) => r.region_label === "Mumbai, IN");
      expect(mumbai).toMatchObject({ state: null, bookings_n: 1 });
      expect(intel.grouped_by).toBe("location");
    } finally {
      await db.end();
    }
  }, 60_000);
});

describe.skipIf(!PG)("Postgres: hundreds of free-text locations across many weeks", () => {
  it("stays under the row cap: the busiest locations keep their rows, the rest arrive as Other locations", async () => {
    const { Client } = await import("pg");
    const db = new Client({ connectionString: PG });
    await db.connect();
    try {
      await db.query(`DROP TABLE IF EXISTS town_orders`);
      await db.query(`CREATE TABLE town_orders (id serial PRIMARY KEY, town text, created timestamptz)`);
      await db.query(
        `INSERT INTO town_orders (town, created)
         SELECT 'Town ' || t, now() - (w * interval '7 days') - interval '1 day'
         FROM generate_series(1, 400) t, generate_series(0, 12) w`,
      );
      const cfg = baseConfig({
        dialect: "postgres",
        location_source: "order",
        supply_source: "none",
        bookings: { ...baseConfig({}).bookings, table: "town_orders", created_at_field: "created", geo_field: "town" },
      });
      const { cells } = await rollupAt("postgres", PG!, cfg);
      const intel = assembleIntel(cells, [], { tenant_id: cfg.tenant_id, min_cell: 1, window_weeks: 13 });
      expect(intel.total.bookings_n).toBe(400 * 13);
      expect(intel.regions.filter((r) => r.region_key !== "__other__")).toHaveLength(50);
      expect(intel.regions.find((r) => r.region_key === "__other__")?.bookings_n).toBe(350 * 13);
    } finally {
      await db.end();
    }
  }, 60_000);
});

describe.skipIf(!PG)("Postgres: customer tables are not always clean", () => {
  it("a listing id that appears twice (a snapshot row) does not count an order twice", async () => {
    const { Client } = await import("pg");
    const db = new Client({ connectionString: PG });
    await db.connect();
    try {
      await db.query(`DROP TABLE IF EXISTS dup_orders; DROP TABLE IF EXISTS dup_listings;`);
      await db.query(`CREATE TABLE dup_listings (id int, city text)`);
      await db.query(`CREATE TABLE dup_orders (id serial, listing_id int, at timestamptz)`);
      await db.query(`INSERT INTO dup_listings VALUES (1, 'Cork'), (1, 'Cork'), (2, 'Galway')`);
      await db.query(`INSERT INTO dup_orders (listing_id, at) VALUES (1, $1), (2, $1)`, [ago(2)]);
      const cfg = baseConfig({
        dialect: "postgres",
        location_source: "listing",
        supply_source: "none",
        bookings: { ...baseConfig({}).bookings, table: "dup_orders", created_at_field: "at", listing_ref_field: "listing_id" },
        listings: { table: "dup_listings", id_field: "id", geo_field: "city", listed_at_field: null },
      });
      const { cells } = await rollupAt("postgres", PG!, cfg);
      const intel = assembleIntel(cells, [], { tenant_id: cfg.tenant_id, min_cell: 1 });
      expect(intel.total.bookings_n).toBe(2);
      expect(intel.regions.find((r) => r.region_label === "Cork")?.bookings_n).toBe(1);
    } finally {
      await db.end();
    }
  }, 60_000);

  it("past the location cap, a town is folded on both reads or on neither", async () => {
    const { Client } = await import("pg");
    const db = new Client({ connectionString: PG });
    await db.connect();
    try {
      await db.query(`DROP TABLE IF EXISTS cap_orders; DROP TABLE IF EXISTS cap_listings;`);
      await db.query(`CREATE TABLE cap_listings (id serial, town text)`);
      await db.query(`CREATE TABLE cap_orders (id serial, town text, at timestamptz)`);
      await db.query(`INSERT INTO cap_orders (town, at) SELECT 'Town ' || t, now() - interval '2 days' FROM generate_series(1, 320) t, generate_series(1, 3)`);
      await db.query(`INSERT INTO cap_listings (town) SELECT 'Town ' || t FROM generate_series(1, 320) t`);
      await db.query(`INSERT INTO cap_orders (town, at) VALUES ('Bigstock', now() - interval '2 days')`);
      await db.query(`INSERT INTO cap_listings (town) SELECT 'Bigstock' FROM generate_series(1, 900)`);
      const cfg = baseConfig({
        dialect: "postgres",
        location_source: "order",
        supply_source: "listings",
        bookings: { ...baseConfig({}).bookings, table: "cap_orders", created_at_field: "at", geo_field: "town" },
        listings: { table: "cap_listings", id_field: "id", geo_field: "town", listed_at_field: null },
      });
      const { cells, supply } = await rollupAt("postgres", PG!, cfg);
      const demandTowns = new Set(cells.map((c) => c.geo_label));
      const supplyTowns = new Set(supply.map((s) => s.geo_label));
      expect(demandTowns.has("Bigstock")).toBe(true);
      expect(supplyTowns.has("Bigstock")).toBe(true);
      const intel = assembleIntel(cells, supply, { tenant_id: cfg.tenant_id, min_cell: 1 });
      expect(intel.regions.find((r) => r.region_label === "Bigstock")).toMatchObject({ bookings_n: 1, completed_listings: 900 });
      expect(intel.total.bookings_n).toBe(961);
    } finally {
      await db.end();
    }
  }, 60_000);
});

describe.skipIf(!MYSQL)("MySQL: local home services, location on the customer, supply = providers with jobs", () => {
  it("counts each provider once per suburb and labels the suburb whose providers are swamped", async () => {
    const mysql = await import("mysql2/promise");
    const db = await mysql.createConnection(MYSQL!);
    try {
      await db.query(`DROP TABLE IF EXISTS jobs`);
      await db.query(`DROP TABLE IF EXISTS accounts`);
      await db.query(`CREATE TABLE accounts (id VARCHAR(20) PRIMARY KEY, suburb VARCHAR(80))`);
      await db.query(`CREATE TABLE jobs (id INT AUTO_INCREMENT PRIMARY KEY, customer_id VARCHAR(20), provider_id VARCHAR(20), booked_at DATETIME)`);
      const plan: Record<string, number> = { Manchester: 60, Leeds: 20, Bristol: 22, Sheffield: 18 };
      const when = ago(4).toISOString().slice(0, 19).replace("T", " ");
      for (const [suburb, jobs] of Object.entries(plan)) {
        await db.query(`INSERT INTO accounts VALUES (?, ?)`, [`c-${suburb}`, suburb]);
        for (let i = 0; i < jobs; i++) {
          await db.query(`INSERT INTO jobs (customer_id, provider_id, booked_at) VALUES (?, ?, ?)`, [
            `c-${suburb}`,
            `p-${suburb}-${i % 5}`,
            when,
          ]);
        }
      }
      await db.query(`INSERT INTO jobs (customer_id, provider_id, booked_at) VALUES ('c-Leeds', 'p-Manchester-0', ?)`, [when]);
      await db.query(`INSERT INTO jobs (customer_id, provider_id, booked_at) VALUES ('c-ghost', 'p-x', ?)`, [when]);

      const cfg = baseConfig({
        dialect: "mysql",
        location_source: "user",
        supply_source: "sellers_on_orders",
        bookings: {
          ...baseConfig({}).bookings,
          table: "jobs",
          created_at_field: "booked_at",
          buyer_ref_field: "customer_id",
          seller_ref_field: "provider_id",
        },
        location_table: { table: "accounts", id_field: "id", geo_field: "suburb" },
      });
      const { cells, supply } = await rollupAt("mysql", MYSQL!, cfg);
      const intel = assembleIntel(cells, supply, { tenant_id: cfg.tenant_id, min_cell: 1 });

      const by = Object.fromEntries(intel.regions.map((r) => [r.region_label, r]));
      expect(by.Manchester).toMatchObject({ bookings_n: 60, completed_listings: 5, balance_label: "demand_heavy" });
      expect(by.Leeds).toMatchObject({ bookings_n: 21, completed_listings: 6 });
      expect(by["No location"]).toMatchObject({ bookings_n: 1, balance_label: "not_compared" });
    } finally {
      await db.end();
    }
  }, 60_000);
});

describe.skipIf(!MONGO)("MongoDB: B2B wholesale and a location through a listing lookup", () => {
  it("wholesale: location on the order, no supply measure, spellings merge, 'Hamburg, DE' is not Delaware", async () => {
    const client = new MongoClient(MONGO!);
    await client.connect();
    try {
      const db = client.db();
      await db.collection("purchase_orders").deleteMany({});
      const docs = [
        ...Array.from({ length: 12 }, () => ({ placed_at: ago(6), region: "Bavaria" })),
        ...Array.from({ length: 3 }, () => ({ placed_at: ago(6), region: "bavaria " })),
        ...Array.from({ length: 7 }, () => ({ placed_at: ago(6), region: "Hamburg, DE" })),
        ...Array.from({ length: 5 }, () => ({ placed_at: ago(6), region: "Berlin, DE" })),
        { placed_at: ago(300), region: "Berlin, DE" },
      ];
      await db.collection("purchase_orders").insertMany(docs);
      const cfg = baseConfig({
        dialect: "mongodb",
        location_source: "order",
        supply_source: "none",
        bookings: { ...baseConfig({}).bookings, table: "purchase_orders", created_at_field: "placed_at", geo_field: "region" },
      });
      const { cells, supply } = await guardedMongoRollup(cfg);
      const intel = assembleIntel(cells, supply, { tenant_id: cfg.tenant_id, min_cell: 1 });
      const by = Object.fromEntries(intel.regions.map((r) => [r.region_label, r]));
      expect(by.Bavaria).toMatchObject({ bookings_n: 15, balance_label: "supply_unknown" });
      expect(by["Hamburg, DE"]).toMatchObject({ state: null, bookings_n: 7 });
      expect(by["Berlin, DE"]?.bookings_n).toBe(5);
      expect(supply).toEqual([]);
    } finally {
      await client.close();
    }
  }, 60_000);

  it("location through the listing: ObjectId listing ids join string references on orders", async () => {
    const client = new MongoClient(MONGO!);
    await client.connect();
    try {
      const db = client.db();
      await db.collection("stalls").deleteMany({});
      await db.collection("stall_orders").deleteMany({});
      const cities: Record<string, number> = { Lisbon: 30, Porto: 10, Braga: 9, Faro: 2 };
      for (const [city, n] of Object.entries(cities)) {
        const ids = Array.from({ length: 10 }, () => new ObjectId());
        await db.collection("stalls").insertMany(ids.map((_id) => ({ _id, market: city, opened: ago(40) })));
        await db
          .collection("stall_orders")
          .insertMany(Array.from({ length: n }, (_, i) => ({ stall: ids[i % 10].toHexString(), at: ago(2) })));
      }
      const cfg = baseConfig({
        dialect: "mongodb",
        location_source: "listing",
        supply_source: "listings",
        bookings: { ...baseConfig({}).bookings, table: "stall_orders", created_at_field: "at", listing_ref_field: "stall" },
        listings: { table: "stalls", id_field: "_id", geo_field: "market", listed_at_field: null },
      });
      const { cells, supply } = await guardedMongoRollup(cfg);
      const intel = assembleIntel(cells, supply, { tenant_id: cfg.tenant_id, min_cell: 1 });
      const by = Object.fromEntries(intel.regions.map((r) => [r.region_label, r]));
      expect(by.Lisbon).toMatchObject({ bookings_n: 30, completed_listings: 10, balance_label: "demand_heavy" });
      expect(by.Faro).toMatchObject({ bookings_n: 2, completed_listings: 10, balance_label: "supply_heavy" });
      expect(by["No location"]).toBeUndefined();
    } finally {
      await client.close();
    }
  }, 60_000);
});
