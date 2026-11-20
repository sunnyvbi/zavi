
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { computeMongoRollup, regionKeyOf } from "../aggregate";
import { computeSqlRollup } from "../aggregate-sql";
import { openLiveMongoDb, openLiveSession } from "./live-session";

vi.mock("@/services/data-gateway/audit", () => ({
  reserveAudit: vi.fn(async () => "live-log"),
  finalizeAudit: vi.fn(async () => undefined),
  writeRefusalAudit: vi.fn(async () => null),
}));
import type { GeoWeekCell, LocationSource, MarketplaceIntelConfig, SupplySnapshot, SupplySource } from "../contract";
import { MARKETPLACE_TOTAL_REGION, NO_LOCATION_REGION, normalizeLocation } from "../regions";

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

const DAY = 24 * 3600 * 1000;
const WINDOW_WEEKS = 13;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260917);
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const PLACES = ["Lagos", "Nairobi", "Berlin, DE", "São Paulo", "Austin, TX", "lagos ", ""];
const daysAgo = (d: number) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - d, 12));
};
const safeDays = () => {
  let d = Math.floor(rand() * 160);
  while (d >= 89 && d <= 93) d = Math.floor(rand() * 160);
  return d;
};

type Listing = { n: number; oid: ObjectId; city: string | null; listed: Date };
type Customer = { id: string; city: string | null };
type Order = { n: number; at: Date; city: string | null; listing: number; customer: string; seller: string };

const listings: Listing[] = Array.from({ length: 40 }, (_, i) => ({
  n: i + 1,
  oid: new ObjectId(),
  city: i === 7 ? null : PLACES[i % 6],
  listed: daysAgo(safeDays()),
}));
const customers: Customer[] = Array.from({ length: 30 }, (_, i) => ({
  id: `cust-${i + 1}`,
  city: i === 3 ? null : PLACES[(i * 5) % 7],
}));
const orders: Order[] = Array.from({ length: 400 }, (_, i) => ({
  n: i + 1,
  at: daysAgo(safeDays()),
  city: pick(PLACES),
  listing: 1 + Math.floor(rand() * 40),
  customer: `cust-${1 + Math.floor(rand() * 30)}`,
  seller: `seller-${1 + Math.floor(rand() * 8)}`,
}));
orders.push({ n: 401, at: daysAgo(3), city: "Lagos", listing: 999, customer: "cust-missing", seller: "seller-1" });

function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-${Math.ceil(((t.getTime() - yearStart.getTime()) / DAY + 1) / 7)}`;
}
const windowStart = daysAgo(WINDOW_WEEKS * 7).getTime() - 12 * 3600 * 1000;
const keyOf = (raw: string | null | undefined) => normalizeLocation(raw ?? "") || NO_LOCATION_REGION;

type Combo = { location: LocationSource; supply: SupplySource; listedAt: boolean };
type Expected = { bookings: Map<string, number>; active: Map<string, number>; supply: Map<string, number> };

function expected(c: Combo): Expected {
  const inWindow = orders.filter((o) => o.at.getTime() >= windowStart && o.at.getTime() <= Date.now());
  const listingByN = new Map(listings.map((l) => [l.n, l]));
  const customerById = new Map(customers.map((u) => [u.id, u]));
  const placeOf = (o: Order) => {
    switch (c.location) {
      case "order":
        return keyOf(o.city);
      case "listing":
        return keyOf(listingByN.get(o.listing)?.city);
      case "user":
        return keyOf(customerById.get(o.customer)?.city);
      default:
        return keyOf("All locations");
    }
  };
  const bookings = new Map<string, number>();
  const activeSets = new Map<string, Set<string>>();
  const sellerSets = new Map<string, Set<string>>();
  const activeOf = (o: Order) =>
    c.supply === "sellers_on_orders" ? o.seller : c.location === "listing" || c.supply === "listings" ? String(o.listing) : null;
  for (const o of inWindow) {
    const k = placeOf(o);
    bookings.set(k, (bookings.get(k) ?? 0) + 1);
    const a = activeOf(o);
    if (a !== null) {
      const wk = `${k}|${isoWeekKey(o.at)}`;
      if (!activeSets.has(wk)) activeSets.set(wk, new Set());
      activeSets.get(wk)!.add(a);
    }
    if (!sellerSets.has(k)) sellerSets.set(k, new Set());
    sellerSets.get(k)!.add(o.seller);
  }
  const active = new Map<string, number>();
  for (const [wk, set] of activeSets) {
    const k = wk.split("|")[0];
    active.set(k, (active.get(k) ?? 0) + set.size);
  }
  const allWeeks = new Map<string, Set<unknown>>();
  const allSellers = new Set<unknown>();
  for (const o of inWindow) {
    const a = activeOf(o);
    if (a !== null) {
      const wk = isoWeekKey(o.at);
      if (!allWeeks.has(wk)) allWeeks.set(wk, new Set());
      allWeeks.get(wk)!.add(a);
    }
    allSellers.add(o.seller);
  }
  let marketplaceActive = 0;
  for (const set of allWeeks.values()) marketplaceActive += set.size;
  if (marketplaceActive > 0) active.set(MARKETPLACE_TOTAL_REGION, marketplaceActive);
  const supply = new Map<string, number>();
  if (c.supply === "sellers_on_orders") {
    for (const [k, set] of sellerSets) supply.set(k, set.size);
    supply.set(MARKETPLACE_TOTAL_REGION, allSellers.size);
  } else if (c.supply === "listings") {
    let marketplaceListings = 0;
    for (const l of listings) {
      if (c.listedAt && (l.listed.getTime() < windowStart || l.listed.getTime() > Date.now())) continue;
      const k = c.location === "none" ? keyOf("All locations") : keyOf(l.city);
      supply.set(k, (supply.get(k) ?? 0) + 1);
      marketplaceListings += 1;
    }
    supply.set(MARKETPLACE_TOTAL_REGION, marketplaceListings);
  }
  return { bookings, active, supply };
}

function actual(cells: GeoWeekCell[], snaps: SupplySnapshot[]): Expected {
  const bookings = new Map<string, number>();
  const active = new Map<string, number>();
  for (const cell of cells) {
    const k = regionKeyOf(cell);
    bookings.set(k, (bookings.get(k) ?? 0) + cell.bookings_n);
    active.set(k, (active.get(k) ?? 0) + cell.active_supply_n);
  }
  const supply = new Map<string, number>();
  for (const s of snaps) supply.set(regionKeyOf(s), (supply.get(regionKeyOf(s)) ?? 0) + s.completed_listings);
  return { bookings, active, supply };
}

const sorted = (m: Map<string, number>) => Object.fromEntries([...m.entries()].filter(([, v]) => v !== 0).sort());

function same(name: string, what: string, got: Map<string, number>, want: Map<string, number>) {
  const g = JSON.stringify(sorted(got));
  const w = JSON.stringify(sorted(want));
  if (g !== w) console.log(`MISMATCH ${name} ${what}\n  got  ${g}\n  want ${w}`);
  expect(g).toBe(w);
}

const COMBOS: Combo[] = [];
for (const location of ["order", "listing", "user", "none"] as LocationSource[]) {
  COMBOS.push({ location, supply: "listings", listedAt: false });
  COMBOS.push({ location, supply: "listings", listedAt: true });
  COMBOS.push({ location, supply: "sellers_on_orders", listedAt: false });
  COMBOS.push({ location, supply: "none", listedAt: false });
}

function configFor(dialect: MarketplaceIntelConfig["dialect"], c: Combo): MarketplaceIntelConfig {
  const mongo = dialect === "mongodb";
  const needsListings = c.location === "listing" || c.supply === "listings";
  return {
    tenant_id: "00000000-0000-4000-8000-0000000000aa",
    dialect,
    location_source: c.location,
    supply_source: c.supply,
    bookings: {
      table: "m_orders",
      created_at_field: "placed_at",
      geo_field: c.location === "order" ? "ship_city" : null,
      listing_ref_field: needsListings ? "listing_ref" : null,
      seller_ref_field: c.supply === "sellers_on_orders" ? "seller_ref" : null,
      buyer_ref_field: c.location === "user" ? "customer_ref" : null,
      gmv_proxy_field: null,
    },
    listings: needsListings
      ? {
          table: "m_listings",
          id_field: mongo ? "_id" : "id",
          geo_field: c.location === "none" ? null : "city",
          listed_at_field: c.supply === "listings" && c.listedAt ? "listed_at" : null,
        }
      : null,
    location_table: c.location === "user" ? { table: "m_customers", id_field: mongo ? "_id" : "id", geo_field: "city" } : null,
    category: { source: "none_on_trips", note: "" },
    intent_events: { search: null, view: null, contact: null },
    provenance: { source: "self_serve_confirmed", validated: true },
  };
}

const label = (c: Combo) => `location=${c.location} supply=${c.supply}${c.listedAt ? " (listed in window)" : ""}`;

const sqlDate = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

describe.skipIf(!PG)("matrix: Postgres", () => {
  beforeAll(async () => {
    const { Client } = await import("pg");
    const db = new Client({ connectionString: PG });
    await db.connect();
    await db.query(`DROP TABLE IF EXISTS m_orders; DROP TABLE IF EXISTS m_listings; DROP TABLE IF EXISTS m_customers;`);
    await db.query(`CREATE TABLE m_listings (id int, city text, listed_at timestamptz)`);
    await db.query(`CREATE TABLE m_customers (id text, city text)`);
    await db.query(`CREATE TABLE m_orders (id int, placed_at timestamptz, ship_city text, listing_ref text, customer_ref text, seller_ref text)`);
    for (const l of listings) await db.query(`INSERT INTO m_listings VALUES ($1,$2,$3)`, [l.n, l.city, l.listed]);
    for (const u of customers) await db.query(`INSERT INTO m_customers VALUES ($1,$2)`, [u.id, u.city]);
    for (const o of orders)
      await db.query(`INSERT INTO m_orders VALUES ($1,$2,$3,$4,$5,$6)`, [o.n, o.at, o.city, String(o.listing), o.customer, o.seller]);
    await db.end();
  }, 120_000);

  for (const c of COMBOS) {
    it(label(c), async () => {
      const { cells, supply } = await rollupAt("postgres", PG!, configFor("postgres", c));
      const got = actual(cells, supply);
      const want = expected(c);
      same(label(c), "bookings", got.bookings, want.bookings);
      same(label(c), "active", got.active, want.active);
      same(label(c), "supply", got.supply, want.supply);
    });
  }
});

describe.skipIf(!MYSQL)("matrix: MySQL", () => {
  beforeAll(async () => {
    const mysql = await import("mysql2/promise");
    const db = await mysql.createConnection(MYSQL!);
    await db.query(`DROP TABLE IF EXISTS m_orders`);
    await db.query(`DROP TABLE IF EXISTS m_listings`);
    await db.query(`DROP TABLE IF EXISTS m_customers`);
    await db.query(`CREATE TABLE m_listings (id INT, city VARCHAR(80), listed_at DATETIME) CHARACTER SET utf8mb4`);
    await db.query(`CREATE TABLE m_customers (id VARCHAR(40), city VARCHAR(80)) CHARACTER SET utf8mb4`);
    await db.query(
      `CREATE TABLE m_orders (id INT, placed_at DATETIME, ship_city VARCHAR(80), listing_ref VARCHAR(40), customer_ref VARCHAR(40), seller_ref VARCHAR(40)) CHARACTER SET utf8mb4`,
    );
    for (const l of listings) await db.query(`INSERT INTO m_listings VALUES (?,?,?)`, [l.n, l.city, sqlDate(l.listed)]);
    for (const u of customers) await db.query(`INSERT INTO m_customers VALUES (?,?)`, [u.id, u.city]);
    for (const o of orders)
      await db.query(`INSERT INTO m_orders VALUES (?,?,?,?,?,?)`, [o.n, sqlDate(o.at), o.city, String(o.listing), o.customer, o.seller]);
    await db.end();
  }, 120_000);

  for (const c of COMBOS) {
    it(label(c), async () => {
      const { cells, supply } = await rollupAt("mysql", MYSQL!, configFor("mysql", c));
      const got = actual(cells, supply);
      const want = expected(c);
      same(label(c), "bookings", got.bookings, want.bookings);
      same(label(c), "active", got.active, want.active);
      same(label(c), "supply", got.supply, want.supply);
    });
  }
});

describe.skipIf(!MONGO)("matrix: MongoDB", () => {
  let client: MongoClient;
  beforeAll(async () => {
    client = new MongoClient(MONGO!);
    await client.connect();
    const db = client.db();
    for (const name of ["m_orders", "m_listings", "m_customers"]) await db.collection(name).deleteMany({});
    await db.collection("m_listings").insertMany(listings.map((l) => ({ _id: l.oid, city: l.city, listed_at: l.listed })));
    await db.collection("m_customers").insertMany(customers.map((u) => ({ _id: u.id, city: u.city })) as never);
    const oidOf = new Map(listings.map((l) => [l.n, l.oid.toHexString()]));
    await db.collection("m_orders").insertMany(
      orders.map((o) => ({
        placed_at: o.at,
        ship_city: o.city,
        listing_ref: oidOf.get(o.listing) ?? `missing-${o.listing}`,
        customer_ref: o.customer,
        seller_ref: o.seller,
      })),
    );
  }, 120_000);

  for (const c of COMBOS) {
    it(label(c), async () => {
      const cfg = configFor("mongodb", c);
      const live = await openLiveMongoDb(MONGO!);
      const { cells, supply } = await computeMongoRollup(live.db, cfg).finally(() => live.close());
      const got = actual(cells, supply);
      const want = expected(c);
      same(label(c), "bookings", got.bookings, want.bookings);
      same(label(c), "active", got.active, want.active);
      same(label(c), "supply", got.supply, want.supply);
    });
  }
});
