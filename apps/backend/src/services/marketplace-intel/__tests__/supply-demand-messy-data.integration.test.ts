
import { describe, expect, it, vi } from "vitest";
import { MongoClient } from "mongodb";
import { computeMongoRollup } from "../aggregate";
import { computeSqlRollup } from "../aggregate-sql";
import { openLiveMongoDb, openLiveSession } from "./live-session";

vi.mock("@/services/data-gateway/audit", () => ({
  reserveAudit: vi.fn(async () => "live-log"),
  finalizeAudit: vi.fn(async () => undefined),
  writeRefusalAudit: vi.fn(async () => null),
}));
import type { MarketplaceIntelConfig } from "../contract";
import { classifyRollupError } from "../../../../workers/functions/marketplace-rollup";

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

const cfg = (dialect: MarketplaceIntelConfig["dialect"], table: string): MarketplaceIntelConfig => ({
  tenant_id: "00000000-0000-4000-8000-0000000000dd",
  dialect,
  location_source: "order",
  supply_source: "none",
  bookings: { table, created_at_field: "d", geo_field: "place", listing_ref_field: null, seller_ref_field: null, buyer_ref_field: null, gmv_proxy_field: null },
  listings: null,
  location_table: null,
  category: { source: "none_on_trips", note: "" },
  intent_events: { search: null, view: null, contact: null },
  provenance: { source: "self_serve_confirmed", validated: true },
});

const recent = new Date(Date.now() - 5 * 86400000);
const iso = recent.toISOString();
const pad = (n: number) => String(n).padStart(2, "0");
const compact = `${recent.getUTCFullYear()}${pad(recent.getUTCMonth() + 1)}${pad(recent.getUTCDate())}${pad(recent.getUTCHours())}${pad(recent.getUTCMinutes())}${pad(recent.getUTCSeconds())}`;
const bookings = (cells: { bookings_n: number }[]) => cells.reduce((a, c) => a + c.bookings_n, 0);

async function expectCountedOrDateError(run: () => Promise<{ cells: { bookings_n: number }[] }>, readable: boolean) {
  if (readable) {
    expect(bookings((await run()).cells)).toBe(10);
    return;
  }
  const err = await run().then(() => null, (e: unknown) => e);
  expect(err).not.toBeNull();
  expect(classifyRollupError(err)).toBe("bad_date_field");
}

describe.skipIf(!PG)("Postgres date storage", () => {
  const cases: Array<[string, string, unknown, boolean]> = [
    ["timestamptz", "timestamptz", recent, true],
    ["text_iso", "text", iso, true],
    ["text_date_only", "text", iso.slice(0, 10), true],
    ["date_type", "date", iso.slice(0, 10), true],
    ["unix_seconds", "bigint", Math.floor(recent.getTime() / 1000), true],
    ["unix_millis", "bigint", recent.getTime(), true],
    ["unix_seconds_text", "text", String(Math.floor(recent.getTime() / 1000)), true],
    ["compact_digits", "bigint", compact, false],
    ["unreadable_text", "text", "not a date", false],
  ];
  for (const [name, type, value, readable] of cases) {
    it(name, async () => {
      const { Client } = await import("pg");
      const db = new Client({ connectionString: PG });
      await db.connect();
      await db.query(`DROP TABLE IF EXISTS dates_${name}`);
      await db.query(`CREATE TABLE dates_${name} (place text, d ${type})`);
      for (let i = 0; i < 10; i++) await db.query(`INSERT INTO dates_${name} VALUES ('Lima', $1)`, [value]);
      await db.end();
      await expectCountedOrDateError(() => rollupAt("postgres", PG!, cfg("postgres", `dates_${name}`)), readable);
    }, 60_000);
  }
});

describe.skipIf(!MYSQL)("MySQL date storage", () => {
  const sqlDate = iso.slice(0, 19).replace("T", " ");
  const cases: Array<[string, string, unknown, boolean]> = [
    ["datetime", "DATETIME", sqlDate, true],
    ["varchar_iso", "VARCHAR(40)", iso, true],
    ["varchar_sql", "VARCHAR(40)", sqlDate, true],
    ["date_type", "DATE", iso.slice(0, 10), true],
    ["unix_seconds", "BIGINT", Math.floor(recent.getTime() / 1000), true],
    ["unix_millis", "BIGINT", recent.getTime(), true],
    ["latin1_location", "DATETIME", sqlDate, true],
    ["compact_digits", "BIGINT", compact, true],
    ["unreadable_text", "VARCHAR(40)", "not a date", false],
  ];
  for (const [name, type, value, readable] of cases) {
    it(name, async () => {
      const mysql = await import("mysql2/promise");
      const db = await mysql.createConnection(MYSQL!);
      await db.query(`DROP TABLE IF EXISTS dates_${name}`);
      await db.query(`CREATE TABLE dates_${name} (place VARCHAR(40)${name === "latin1_location" ? " CHARACTER SET latin1" : ""}, d ${type})`);
      for (let i = 0; i < 10; i++) await db.query(`INSERT INTO dates_${name} VALUES ('Lima', ?)`, [value]);
      await db.end();
      await expectCountedOrDateError(() => rollupAt("mysql", MYSQL!, cfg("mysql", `dates_${name}`)), readable);
    }, 60_000);
  }
});

describe.skipIf(!MONGO)("MongoDB date storage", () => {
  const cases: Array<[string, unknown, boolean]> = [
    ["bson_date", recent, true],
    ["iso_string", iso, true],
    ["unix_millis", recent.getTime(), true],
    ["unix_seconds", Math.floor(recent.getTime() / 1000), true],
    ["unix_seconds_string", String(Math.floor(recent.getTime() / 1000)), true],
    ["unreadable_string", "not a date", false],
  ];
  for (const [name, value, readable] of cases) {
    it(name, async () => {
      const client = new MongoClient(MONGO!);
      await client.connect();
      try {
        const db = client.db();
        await db.collection(`dates_${name}`).deleteMany({});
        await db.collection(`dates_${name}`).insertMany(Array.from({ length: 10 }, () => ({ place: "Lima", d: value })));
        await expectCountedOrDateError(
          () => guardedMongoRollup(cfg("mongodb", `dates_${name}`)),
          readable,
        );
      } finally {
        await client.close();
      }
    }, 60_000);
  }
});

const PLACES = [
  "O'Brien's Corner",
  'Back\\slash "quoted"',
  "x'); DROP TABLE orders; --",
  "$where",
  "{ $gt: '' }",
  "São Paulo",
  "Zürich ",
  "Zürich",
  "東京",
  "",
];
const perPlace = 6;
const totalOrders = PLACES.length * perPlace;

function expectEveryOrderPlaced(cells: Array<{ geo_label: string | null; bookings_n: number }>) {
  expect(bookings(cells)).toBe(totalOrders);
  expect(cells.filter((c) => c.geo_label === "__other__")).toEqual([]);
  expect(cells.find((c) => c.geo_label === "Zürich")?.bookings_n).toBe(perPlace * 2);
  expect(cells.find((c) => c.geo_label === "__no_location__")?.bookings_n).toBe(perPlace);
}

describe.skipIf(!PG)("Postgres location values", () => {
  it("every order lands in its own region", async () => {
    const { Client } = await import("pg");
    const db = new Client({ connectionString: PG });
    await db.connect();
    await db.query("DROP TABLE IF EXISTS places_odd");
    await db.query("CREATE TABLE places_odd (place text, d timestamptz)");
    for (const p of PLACES) for (let i = 0; i < perPlace; i++) await db.query("INSERT INTO places_odd VALUES ($1, $2)", [p, recent]);
    await db.end();
    const { cells } = await rollupAt("postgres", PG!, cfg("postgres", "places_odd"), { min_cell: 1 });
    expectEveryOrderPlaced(cells);
  }, 60_000);
});

describe.skipIf(!MYSQL)("MySQL location values", () => {
  for (const charset of ["utf8mb4", "latin1"]) {
    it(`every order lands in its own region (${charset} column)`, async () => {
      const mysql = await import("mysql2/promise");
      const db = await mysql.createConnection(MYSQL!);
      const table = `places_odd_${charset}`;
      const places = charset === "latin1" ? PLACES.filter((p) => p !== "東京") : PLACES;
      await db.query(`DROP TABLE IF EXISTS ${table}`);
      await db.query(`CREATE TABLE ${table} (place VARCHAR(80) CHARACTER SET ${charset}, d DATETIME)`);
      for (const p of places) for (let i = 0; i < perPlace; i++) await db.query(`INSERT INTO ${table} VALUES (?, ?)`, [p, recent]);
      await db.end();
      const { cells } = await rollupAt("mysql", MYSQL!, cfg("mysql", table), { min_cell: 1 });
      expect(bookings(cells)).toBe(places.length * perPlace);
      expect(cells.filter((c) => c.geo_label === "__other__")).toEqual([]);
      expect(cells.find((c) => c.geo_label === "Zürich")?.bookings_n).toBe(perPlace * 2);
    }, 60_000);
  }
});

describe.skipIf(!MONGO)("MongoDB location values", () => {
  it("every order lands in its own region, including values that look like operators and numbers", async () => {
    const client = new MongoClient(MONGO!);
    await client.connect();
    try {
      const db = client.db();
      const docs = [...PLACES, 94107].flatMap((place) => Array.from({ length: perPlace }, () => ({ place, d: recent })));
      await db.collection("places_odd").deleteMany({});
      await db.collection("places_odd").insertMany(docs);
      const { cells } = await guardedMongoRollup(cfg("mongodb", "places_odd"), { min_cell: 1 });
      expect(bookings(cells)).toBe(totalOrders + perPlace);
      expect(cells.filter((c) => c.geo_label === "__other__")).toEqual([]);
      expect(cells.find((c) => c.geo_label === "$where")?.bookings_n).toBe(perPlace);
      expect(cells.find((c) => c.geo_label === "94107")?.bookings_n).toBe(perPlace);
    } finally {
      await client.close();
    }
  }, 60_000);
});
