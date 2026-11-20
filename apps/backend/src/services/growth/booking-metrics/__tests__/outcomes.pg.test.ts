import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDayStartUtc, addDays } from "@/services/analytics/metric-time";
import {
  readCompletedRevenue,
  readFirstCompletions,
  readSourceWatermark,
  readUnplacedByDay,
  unplacedThrough,
  type OutcomeMap,
} from "../outcomes";
import { EXPECT, MAP, ORDERS, TZ } from "./outcomes-fixture";
import { openPglite, pgSession, type Pg } from "./pglite";
import { effectivePolicy, guardSql } from "@zavi/shared/db-guard";
import type { ReadSession } from "@/services/data-gateway/session";

function guardedSession(pg: Pg): ReadSession {
  const inner = pgSession(pg);
  const columns = ["id", "customer_id", "status", "created_at", "finished_at", "amount", "refund"].map((name) => ({ name, type: "text", nullable: true }));
  const policy = effectivePolicy(
    { auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] },
    { tables: [{ name: "orders", columns }, { name: "orders_c", columns }] },
    "postgres",
  );
  return {
    ...inner,
    async query(text: string, params?: unknown[]) {
      const g = guardSql(text, { policy, dialect: "postgres" });
      if (!g.ok) throw new Error(`guard refused: ${g.reason}`);
      return inner.query(g.sql, params);
    },
  };
}

let db: Pg | null = null;
const W = { since: localDayStartUtc("2026-10-01", TZ), until: localDayStartUtc(addDays("2026-10-14", 1), TZ), tz: TZ };

beforeAll(async () => {
  db = await openPglite();
  if (!db) return;
  await db.exec(`create table orders (
    id text primary key, customer_id text, status text,
    created_at timestamptz, finished_at timestamptz, amount numeric, refund numeric)`);
  for (const o of ORDERS) {
    await db.query("insert into orders values ($1,$2,$3,$4,$5,$6,$7)", [o.id, o.customer, o.status, o.created, o.finished, o.amount, o.refund]);
  }
}, 60_000);
afterAll(async () => {
  await db?.close();
});

describe.skipIf(!process.env.CI && !process.env.PGLITE_DIR)("finished outcomes on Postgres", () => {
  it("a customer who finished before the window is not new in it; booked week 1, finished week 2 counts in week 2", async () => {
    const fc = await readFirstCompletions(guardedSession(db!), MAP, W);
    expect(fc.days).toEqual(EXPECT.firstDays);
    expect(fc.first_seen_floor).toBe(EXPECT.floor);
  });

  it("revenue is grouped by finish day from the configured fields, refunds as their own part", async () => {
    const rv = await readCompletedRevenue(guardedSession(db!), MAP, W);
    expect(rv.days).toEqual(EXPECT.revenueDays);
  });

  it("finished orders with no finish date are counted as unplaced on their created day", async () => {
    const days = await readUnplacedByDay(guardedSession(db!), MAP, TZ);
    expect(unplacedThrough(days, "2026-10-14").u_cac).toBe(EXPECT.unplacedCac);
    expect(unplacedThrough(days, "2026-10-14").u_roas).toBe(1);
    expect(unplacedThrough(days, "2026-10-14").pos).toBe(80);
    expect(unplacedThrough(days, "2026-10-01").u_cac).toBe(0);
  });

  it("cents are scaled once, and a missing revenue value is unreadable, never zero", async () => {
    await db!.exec("create table orders_c as select * from orders");
    await db!.exec("update orders_c set amount = amount * 100, refund = refund * 100");
    await db!.exec("update orders_c set amount = null where id = 'd1'");
    const map: OutcomeMap = { ...MAP, booking_source: "orders_c", amount_unit: "cents" };
    const rv = await readCompletedRevenue(guardedSession(db!), map, W);
    expect(rv.days.find((d) => d.date === "2026-10-04")).toEqual({ date: "2026-10-04", gross: 300, refund: 50, orders: 1, unreadable: 0 });
    expect(rv.days.find((d) => d.date === "2026-10-10")).toEqual({ date: "2026-10-10", gross: 0, refund: 0, orders: 0, unreadable: 1 });
  });

  it("the data watermark moves when a finish date is corrected", async () => {
    const before = await readSourceWatermark(guardedSession(db!), MAP);
    await db!.exec("update orders set finished_at = finished_at + interval '1 hour' where id = 'b1'");
    const after = await readSourceWatermark(guardedSession(db!), MAP);
    expect(before.split("|")[0]).toBe("7");
    expect(after).not.toBe(before);
    await db!.exec("update orders set finished_at = finished_at - interval '1 hour' where id = 'b1'");
    expect(await readSourceWatermark(guardedSession(db!), MAP)).toBe(before);
  });
});
