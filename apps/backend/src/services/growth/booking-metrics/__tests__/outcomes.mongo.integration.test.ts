import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MongoClient } from "mongodb";

vi.mock("@/services/data-gateway/audit", () => ({
  reserveAudit: vi.fn(async () => "live-log"),
  finalizeAudit: vi.fn(async () => undefined),
  writeRefusalAudit: vi.fn(async () => null),
}));

import { effectivePolicy } from "@zavi/shared/db-guard";
import { openMongoSession } from "@/services/data-gateway/direct/mongo";
import { loggedSession } from "@/services/data-gateway/logged-session";
import { introspectMongo } from "@/services/data-gateway/discovery/mongo";
import { normalizeRawCatalog } from "@/services/tools/operator-db/discovery";
import type { DbAccess } from "@/services/data-gateway/resolve";
import type { ReadSession } from "@/services/data-gateway/session";
import { addDays, localDayStartUtc } from "@/services/analytics/metric-time";
import { readCompletedRevenue, readFirstCompletions, readSourceWatermark, readUnplacedByDay, unplacedThrough, type OutcomeMap } from "../outcomes";
import { EXPECT, MAP, ORDERS, TZ } from "./outcomes-fixture";
import { buildVerifiedPipeline, catalogUtmCampaignPaths, utmProbePaths } from "@/services/tools/operator-db/verified-utm";

const URL = process.env.OUTCOMES_LIVE_MONGO;
const W = { since: localDayStartUtc("2026-10-01", TZ), until: localDayStartUtc(addDays("2026-10-14", 1), TZ), tz: TZ };
const MONGO_MAP: OutcomeMap = {
  ...MAP,
  engine: "mongodb",
  date_field: "createdAt",
  completed_at_field: "finishedAt",
  customer_ref_field: "customerId",
  revenue_field: "money.total",
  refund_field: "money.refunded",
};

let session: ReadSession;

describe.skipIf(!URL)("finished outcomes on MongoDB (live)", () => {
  beforeAll(async () => {
    const client = new MongoClient(URL!);
    await client.connect();
    const db = client.db();
    await db.dropDatabase();
    await db.collection("orders").insertMany(
      ORDERS.map((o) => ({
        _id: o.id as unknown as never,
        customerId: o.customer,
        status: o.status,
        createdAt: o.created ? new Date(o.created) : null,
        finishedAt: o.finished ? (o.id === "b1" ? o.finished : new Date(o.finished)) : null,
        money: { total: o.amount, refunded: o.refund },
      })),
    );
    await db.collection("orders_bad").insertMany([
      { customerId: "X", status: "completed", createdAt: new Date("2026-10-05T18:00:00Z"), finishedAt: new Date("2026-10-06T18:00:00Z"), money: { total: "n/a", refunded: 0 } },
      { customerId: "Y", status: "completed", createdAt: new Date("2026-10-05T18:00:00Z"), finishedAt: new Date("2026-10-06T19:00:00Z"), money: { total: 10, refunded: 0 } },
    ]);
    await db.collection("customers").insertMany([
      { _id: "A" as unknown as never, acq: { utmCampaign: "spring", utmSource: "fb" } },
      { _id: "B" as unknown as never, acq: { utmCampaign: "spring", utmSource: "ig" } },
      { _id: "C" as unknown as never, acq: {} },
      { _id: "D" as unknown as never, acq: { utmCampaign: "brand", utmSource: "google" } },
      { _id: "E" as unknown as never, acq: { utmCampaign: "spring", utmSource: "fb" } },
    ]);
    await client.close();
    const catalog = normalizeRawCatalog(await introspectMongo(URL!));
    const access = {
      tenant_id: "live",
      mode: "direct",
      dialect: "mongodb",
      database: null,
      policy: effectivePolicy({ auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] }, catalog, "mongodb"),
    } as unknown as DbAccess;
    session = loggedSession(await openMongoSession(URL!), access, {
      tenant_id: "live",
      caller: { kind: "agent", agent_slug: "live", run_id: null, tool_name: "live" },
    });
  }, 60_000);
  afterAll(async () => {
    await session?.close();
  });

  it("first finished order per customer over the whole history, counted on its finish day", async () => {
    const fc = await readFirstCompletions(session, MONGO_MAP, W);
    expect(fc.days).toEqual(EXPECT.firstDays);
    expect(fc.first_seen_floor).toBe(EXPECT.floor);
  });

  it("revenue by finish day from the confirmed (nested) fields", async () => {
    const rv = await readCompletedRevenue(session, MONGO_MAP, W);
    expect(rv.days).toEqual(EXPECT.revenueDays);
  });

  it("unplaced finished orders by created day", async () => {
    const days = await readUnplacedByDay(session, MONGO_MAP, TZ);
    const u = unplacedThrough(days, "2026-10-14");
    expect(u.u_cac).toBe(EXPECT.unplacedCac);
    expect(u.pos).toBe(80);
    expect(unplacedThrough(days, "2026-10-01").u_cac).toBe(0);
  });

  it("a revenue value that is not a number is counted as unreadable", async () => {
    const rv = await readCompletedRevenue(session, { ...MONGO_MAP, booking_source: "orders_bad" }, W);
    expect(rv.days).toEqual([{ date: "2026-10-06", gross: 10, refund: 0, orders: 1, unreadable: 1 }]);
  });

  it("verified join: finished statuses only, revenue from the confirmed fields, one row per (campaign, source)", async () => {
    const pipeline = buildVerifiedPipeline(
      { ...MONGO_MAP, refund_basis: "booking_created_net" },
      { table: "customers", id_field: "_id" },
      { campaign: "acq.utmCampaign", source: "acq.utmSource" },
      new Date("2026-10-01T07:00:00Z"),
    );
    const [facet] = (await session.mongo().aggregate("orders", pipeline as Record<string, unknown>[], { allowDiskUse: true })) as Array<{
      totals: Array<{ total_verified: number; matched_verified: number; unreadable: number }>;
      byCampaign: Array<{ _id: { c: string; s: string }; verified_bookings: number; net_gmv: number }>;
    }>;
    expect(facet.totals[0]).toEqual({ _id: null, total_verified: 5, matched_verified: 3, unreadable: 0 });
    const rows = facet.byCampaign.map((r) => [r._id.c, r._id.s, r.verified_bookings, r.net_gmv]).sort();
    expect(rows).toEqual([
      ["brand", "google", 1, 150],
      ["spring", "fb", 1, 200],
      ["spring", "ig", 1, 250],
    ]);
  });
  it("counts finished rows and moves when a status turns finished", async () => {
    const w1 = await readSourceWatermark(session, MONGO_MAP);
    expect(w1.split("|")[0]).toBe("7");
    const client = new MongoClient(URL!);
    await client.connect();
    await client.db().collection("orders").updateOne({ _id: "e1" as unknown as never }, { $set: { status: "completed" } });
    const w2 = await readSourceWatermark(session, MONGO_MAP);
    await client.db().collection("orders").updateOne({ _id: "e1" as unknown as never }, { $set: { status: "in_progress" } });
    await client.close();
    expect(w2.split("|")[0]).toBe("8");
  });
});

describe("UTM tag field discovery (pure)", () => {
  it("prefers a catalogued last-touch campaign tag, then the shortest", () => {
    expect(catalogUtmCampaignPaths([{ name: "first.utm_campaign" }, { name: "lastTouch.utmCampaign" }, { name: "utm_campaign" }])).toEqual([
      "lastTouch.utmCampaign",
      "utm_campaign",
      "first.utm_campaign",
    ]);
  });
  it("probes under acquisition-like object columns when the catalog is shallow", () => {
    expect(utmProbePaths([{ name: "acquisition", type: "Document" }, { name: "name", type: "String" }]).map((p) => p.campaign)).toEqual([
      "acquisition.utmCampaign",
      "acquisition.utm_campaign",
    ]);
  });
});
