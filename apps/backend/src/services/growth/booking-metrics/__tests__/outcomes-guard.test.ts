import { describe, expect, it } from "vitest";
import { effectivePolicy, guardMongoAggregate, guardSql } from "@zavi/shared/db-guard";
import {
  buildMongoCompletedRevenue,
  buildMongoFirstCompletions,
  buildMongoUnplacedByDay,
  buildPgCompletedRevenue,
  buildPgFirstCompletions,
  buildPgUnplacedByDay,
  type OutcomeMap,
} from "../outcomes";
import { buildVerifiedPipeline } from "@/services/tools/operator-db/verified-utm";
import { MAP, TZ } from "./outcomes-fixture";

const col = (name: string, type: string) => ({ name, type, nullable: true });
const ROW = { auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] };

const PG_CATALOG = {
  tables: [
    {
      name: "orders",
      rowEstimate: 10,
      columns: ["id", "customer_id", "status", "created_at", "finished_at", "amount", "refund"].map((n) => col(n, "text")),
    },
  ],
};
const MONGO_MAP: OutcomeMap = {
  ...MAP,
  engine: "mongodb",
  booking_source: "orders",
  date_field: "createdAt",
  completed_at_field: "finishedAt",
  customer_ref_field: "customerId",
  revenue_field: "money.total",
  refund_field: "money.refunded",
};
const MONGO_CATALOG = {
  tables: [
    {
      name: "orders",
      rowEstimate: 10,
      columns: [col("customerId", "ObjectId"), col("status", "String"), col("createdAt", "Date"), col("finishedAt", "Date"), col("money", "Document"), col("money.total", "Double"), col("money.refunded", "Double")],
    },
    { name: "customers", rowEstimate: 10, columns: [col("_id", "ObjectId"), col("acq", "Document"), col("acq.utmCampaign", "String"), col("acq.utmSource", "String")] },
  ],
};
const W = { since: new Date("2026-10-01T07:00:00Z"), until: new Date("2026-10-15T07:00:00Z"), tz: TZ };

describe("finished-outcome queries pass the database guard", () => {
  const pgPolicy = effectivePolicy(ROW, PG_CATALOG, "postgres");
  it.each([
    ["first completions (days)", buildPgFirstCompletions(MAP).days],
    ["first completions (floor)", buildPgFirstCompletions(MAP).floor],
    ["completed revenue", buildPgCompletedRevenue(MAP)],
    ["unplaced by day", buildPgUnplacedByDay(MAP)],
  ])("Postgres: %s", (_label, sql) => {
    const g = guardSql(sql, { policy: pgPolicy, dialect: "postgres" });
    expect(g.ok, JSON.stringify(g)).toBe(true);
  });

  const mongoPolicy = effectivePolicy(ROW, MONGO_CATALOG, "mongodb");
  it.each([
    ["first completions", buildMongoFirstCompletions(MONGO_MAP, W)],
    ["completed revenue", buildMongoCompletedRevenue(MONGO_MAP, W)],
    ["unplaced by day", buildMongoUnplacedByDay(MONGO_MAP, TZ)],
    [
      "verified join",
      buildVerifiedPipeline(
        { ...MONGO_MAP, refund_basis: "booking_created_net" },
        { table: "customers", id_field: "_id" },
        { campaign: "acq.utmCampaign", source: "acq.utmSource" },
        W.since,
      ),
    ],
  ])("MongoDB: %s", (_label, pipeline) => {
    const g = guardMongoAggregate("orders", pipeline, { policy: mongoPolicy });
    expect(g.ok, JSON.stringify(g)).toBe(true);
  });

  it("a field name that is not a plain path never reaches a query", () => {
    expect(() => buildMongoFirstCompletions({ ...MONGO_MAP, customer_ref_field: "$where" }, W)).toThrow(/unsafe field/);
    expect(() => buildPgCompletedRevenue({ ...MAP, revenue_field: 'amount"; drop table x;--' })).toThrow(/bad SQL identifier/);
    expect(() => buildPgCompletedRevenue({ ...MAP, revenue_field: "price.final" })).toThrow(/bad SQL identifier/);
  });
});
