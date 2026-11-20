import { describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { MAX_ROWS_PER_READ } from "@zavi/shared/db-guard";
import { computeMongoRollup } from "../aggregate";
import type { MarketplaceIntelConfig } from "../contract";
import { MARKETPLACE_TOTAL_REGION, normalizeLocation } from "../regions";
import { openLiveMongoDb } from "./live-session";

vi.mock("@/services/data-gateway/audit", () => ({
  reserveAudit: vi.fn(async () => "live-log"),
  finalizeAudit: vi.fn(async () => undefined),
  writeRefusalAudit: vi.fn(async () => null),
}));

const MONGO = process.env.SD_LIVE_MONGO;
const DAY = 24 * 3600 * 1000;
const CITIES = ["Lagos", "Nairobi", "Lima", "Accra", "Kigali"];
const ORDERS = 12_000;
const LISTINGS = 6_000;

function isoMonday(d: Date): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() || 7) - 1));
  return x.toISOString().slice(0, 10);
}

describe.skipIf(!MONGO)("MongoDB larger than the row cap, through the guarded session", () => {
  it("reads every order, joins any id form, and counts distinct listings per location and week", async () => {
    const client = new MongoClient(MONGO!);
    await client.connect();
    try {
      const raw = client.db();
      await raw.collection("big_orders").deleteMany({});
      await raw.collection("big_listings").deleteMany({});
      const listings = Array.from({ length: LISTINGS }, (_, i) => ({ _id: new ObjectId(), city: CITIES[i % CITIES.length]! }));
      await raw.collection("big_listings").insertMany(listings);
      const now = Date.now();
      const orders = Array.from({ length: ORDERS }, (_, i) => {
        const listing = listings[(i * 7) % LISTINGS]!;
        const day = new Date(now - (1 + (i % 80)) * DAY);
        const at = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12));
        const ref = i % 50 === 0 ? undefined : i % 2 === 0 ? listing._id : listing._id.toHexString();
        return { at, ref, city: ref === undefined ? null : listing.city, listingKey: listing._id.toHexString() };
      });
      await raw.collection("big_orders").insertMany(
        orders.map((o) => (o.ref === undefined ? { created_at: o.at } : { created_at: o.at, item_ref: o.ref })),
      );

      const cfg: MarketplaceIntelConfig = {
        tenant_id: "00000000-0000-4000-8000-00000000b16e",
        dialect: "mongodb",
        location_source: "listing",
        supply_source: "listings",
        bookings: {
          table: "big_orders",
          created_at_field: "created_at",
          geo_field: null,
          listing_ref_field: "item_ref",
          seller_ref_field: null,
          buyer_ref_field: null,
          gmv_proxy_field: null,
        },
        listings: { table: "big_listings", id_field: "_id", geo_field: "city", listed_at_field: null },
        location_table: null,
        category: { source: "none_on_trips", note: "" },
        intent_events: { search: null, view: null, contact: null },
        provenance: { source: "self_serve_confirmed", validated: true },
      };
      expect(ORDERS).toBeGreaterThan(2 * MAX_ROWS_PER_READ);

      const live = await openLiveMongoDb(MONGO!);
      const { cells, supply } = await computeMongoRollup(live.db, cfg).finally(() => live.close());

      const want = new Map<string, { bookings: number; ids: Set<string> }>();
      for (const o of orders) {
        if (!o.city) continue;
        const key = `${normalizeLocation(o.city)}|${isoMonday(o.at)}`;
        const e = want.get(key) ?? { bookings: 0, ids: new Set<string>() };
        e.bookings += 1;
        e.ids.add(`${typeof o.ref === "string" ? "s" : "o"}:${o.listingKey}`);
        want.set(key, e);
      }
      const located = cells.filter((c) => c.geo_label !== MARKETPLACE_TOTAL_REGION && CITIES.some((x) => normalizeLocation(x) === normalizeLocation(c.geo_label)));
      expect(located.length).toBe(want.size);
      for (const c of located) {
        const w = want.get(`${normalizeLocation(c.geo_label)}|${c.week_start}`);
        expect(w, `${c.geo_label} ${c.week_start}`).toBeDefined();
        expect(c.bookings_n).toBe(w!.bookings);
        expect(c.active_supply_n).toBe(w!.ids.size);
      }
      const noLocation = cells.filter((c) => !located.includes(c) && c.geo_label !== MARKETPLACE_TOTAL_REGION);
      expect(noLocation.reduce((n, c) => n + c.bookings_n, 0)).toBe(orders.filter((o) => !o.city).length);
      expect(located.reduce((n, c) => n + c.bookings_n, 0) + noLocation.reduce((n, c) => n + c.bookings_n, 0)).toBe(ORDERS);
      const listingSupply = supply.filter((s) => s.geo_label !== MARKETPLACE_TOTAL_REGION).reduce((n, s) => n + s.total_listings, 0);
      expect(listingSupply).toBe(LISTINGS);
    } finally {
      await client.close();
    }
  }, 180_000);

  it("joins an id stored as an ObjectId, its string, or a number and its digits; nothing else", async () => {
    const client = new MongoClient(MONGO!);
    await client.connect();
    try {
      const raw = client.db();
      await raw.collection("ref_orders").deleteMany({});
      await raw.collection("ref_listings").deleteMany({});
      const oid = new ObjectId();
      await raw.collection<{ _id: unknown; city: string }>("ref_listings").insertMany([
        { _id: oid, city: "Lagos" },
        { _id: "abc", city: "Nairobi" },
        { _id: 42, city: "Lima" },
        { _id: "7", city: "Accra" },
        { _id: 1, city: "Kigali" },
      ]);
      const at = new Date(Date.now() - 3 * DAY);
      const refs: Array<[unknown, string | null]> = [
        [oid, "Lagos"],
        [oid.toHexString(), "Lagos"],
        ["abc", "Nairobi"],
        ["42", "Lima"],
        [7, "Accra"],
        ["042", null],
        [true, null],
        [null, null],
        [undefined, null],
        ["", null],
        [[oid], null],
      ];
      await raw.collection("ref_orders").insertMany(refs.map(([ref]) => (ref === undefined ? { at } : { at, ref })));
      const cfg: MarketplaceIntelConfig = {
        tenant_id: "00000000-0000-4000-8000-00000000ref1",
        dialect: "mongodb",
        location_source: "listing",
        supply_source: "none",
        bookings: { table: "ref_orders", created_at_field: "at", geo_field: null, listing_ref_field: "ref", seller_ref_field: null, buyer_ref_field: null, gmv_proxy_field: null },
        listings: { table: "ref_listings", id_field: "_id", geo_field: "city", listed_at_field: null },
        location_table: null,
        category: { source: "none_on_trips", note: "" },
        intent_events: { search: null, view: null, contact: null },
        provenance: { source: "self_serve_confirmed", validated: true },
      };
      const live = await openLiveMongoDb(MONGO!);
      const { cells } = await computeMongoRollup(live.db, cfg, { min_cell: 1 }).finally(() => live.close());
      const byCity = new Map<string, number>();
      for (const c of cells) {
        if (c.geo_label === MARKETPLACE_TOTAL_REGION) continue;
        const city = CITIES.find((x) => normalizeLocation(x) === normalizeLocation(c.geo_label)) ?? "(none)";
        byCity.set(city, (byCity.get(city) ?? 0) + c.bookings_n);
      }
      expect(Object.fromEntries(byCity)).toEqual({ Lagos: 2, Nairobi: 1, Lima: 1, Accra: 1, "(none)": 6 });
    } finally {
      await client.close();
    }
  }, 60_000);
});
