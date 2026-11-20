import { describe, it, expect } from "vitest";
import { SummaryRequest, compileSummary, checkSummary, suppressSmallGroups, effectivePolicy, MIN_GROUP_SIZE, type CatalogLike } from "@zavi/shared/db-guard";

type Compiled = ReturnType<typeof compileSummary>;
function sqlOf(r: Compiled): { text: string; params: (string | number | boolean)[] } {
  if ("ok" in r || r.kind !== "sql") throw new Error(`expected compiled SQL, got ${JSON.stringify(r)}`);
  return r;
}
function mongoOf(r: Compiled): { collection: string; pipeline: Record<string, unknown>[] } {
  if ("ok" in r || r.kind !== "mongo") throw new Error(`expected a compiled pipeline, got ${JSON.stringify(r)}`);
  return r;
}

const catalog: CatalogLike = {
  tables: [
    {
      name: "users",
      columns: [
        { name: "id", type: "integer" },
        { name: "email", type: "text" },
        { name: "city", type: "text" },
        { name: "created_at", type: "timestamp with time zone" },
        { name: "credits", type: "numeric" },
      ],
    },
  ],
};
const mongoCatalog: CatalogLike = {
  tables: [{ name: "users", columns: [{ name: "_id", type: "objectId" }, { name: "email", type: "string" }, { name: "city", type: "string" }, { name: "createdAt", type: "date" }, { name: "credits", type: "double" }] }],
};
const base = { auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] };
const pgPolicy = effectivePolicy(base, catalog, "postgres");
const myPolicy = effectivePolicy(base, catalog, "mysql");
const moPolicy = effectivePolicy(base, mongoCatalog, "mongodb");
const req = (r: unknown) => SummaryRequest.parse(r);

describe("summary must-catch", () => {
  it("min on a non-numeric, non-date field (users.email) is refused", () => {
    const r = compileSummary(req({ table: "users", measures: [{ fn: "min", field: "email" }] }), "postgres", pgPolicy);
    expect(r).toMatchObject({ ok: false });
  });
  it("group by a sensitive field is refused even when not hidden", () => {
    const r = compileSummary(req({ table: "users", measures: [{ fn: "count" }], group_by: [{ field: "email" }] }), "postgres", pgPolicy);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/personal data/) });
  });
  it("hidden field anywhere is refused", () => {
    const p = effectivePolicy({ ...base, hidden_fields: ["users.city"] }, catalog, "postgres");
    const r = checkSummary(req({ table: "users", measures: [{ fn: "count" }], filters: [{ field: "city", op: "eq", value: "LA" }] }), p);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/hidden/) });
  });
  it("group by an identifier is refused; the >= 5 floor is in every compiled query", () => {
    expect(compileSummary(req({ table: "users", measures: [{ fn: "count" }], group_by: [{ field: "id" }] }), "postgres", pgPolicy)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/identifier/),
    });
    const r = compileSummary(req({ table: "users", measures: [{ fn: "count" }], group_by: [{ field: "city" }] }), "postgres", pgPolicy);
    expect(sqlOf(r).text).toContain(`HAVING count(*) >= ${MIN_GROUP_SIZE}`);
    const m = compileSummary(req({ table: "users", measures: [{ fn: "count" }], group_by: [{ field: "city" }] }), "mongodb", moPolicy);
    expect(mongoOf(m).pipeline).toContainEqual({ $match: { __n: { $gte: 5 } } });
  });
  it("differencing pair: a filter on an identifier is refused", () => {
    const r = compileSummary(
      req({ table: "users", measures: [{ fn: "sum", field: "credits" }], filters: [{ field: "city", op: "eq", value: "LA" }, { field: "id", op: "eq", value: 123 }] }),
      "postgres",
      pgPolicy,
    );
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/identifier/) });
    expect(compileSummary(req({ table: "users", measures: [{ fn: "count" }], filters: [{ field: "_id", op: "eq", value: "x" }] }), "mongodb", moPolicy)).toMatchObject({ ok: false });
  });
  it("negations are not expressible (!=, NOT NULL)", () => {
    expect(SummaryRequest.safeParse({ table: "users", measures: [{ fn: "count" }], filters: [{ field: "city", op: "neq", value: "LA" }] }).success).toBe(false);
    expect(SummaryRequest.safeParse({ table: "users", measures: [{ fn: "count" }], filters: [{ field: "city", op: "not_null" }] }).success).toBe(false);
    expect(SummaryRequest.safeParse({ table: "users", measures: [{ fn: "count" }], filters: [{ field: "city", op: "in", value: Array.from({ length: 21 }, (_, i) => String(i)) }] }).success).toBe(false);
  });
  it("min/max refused in totals-only mode, allowed in cloud", () => {
    const q = req({ table: "users", measures: [{ fn: "max", field: "credits" }], group_by: [{ field: "city" }] });
    expect(compileSummary(q, "postgres", pgPolicy, "totals_only")).toMatchObject({ ok: false, reason: expect.stringMatching(/Totals and counts only/) });
    expect(compileSummary(q, "postgres", pgPolicy, "cloud")).toMatchObject({ kind: "sql" });
  });
  it("ranges only on numeric/date; dates in whole days; dates must be bucketed", () => {
    expect(compileSummary(req({ table: "users", measures: [{ fn: "count" }], filters: [{ field: "city", op: "gt", value: "M" }] }), "postgres", pgPolicy)).toMatchObject({ ok: false });
    expect(compileSummary(req({ table: "users", measures: [{ fn: "count" }], filters: [{ field: "created_at", op: "gte", value: "yesterday" }] }), "postgres", pgPolicy)).toMatchObject({ ok: false });
    expect(compileSummary(req({ table: "users", measures: [{ fn: "count" }], group_by: [{ field: "created_at" }] }), "postgres", pgPolicy)).toMatchObject({ ok: false });
    const r = compileSummary(req({ table: "users", measures: [{ fn: "count" }], filters: [{ field: "created_at", op: "gte", value: "2026-10-01T13:45:00Z" }] }), "postgres", pgPolicy);
    expect(sqlOf(r).params).toEqual(["2026-10-01"]);
  });
  it("sensitive measure targets and free-text filters are refused", () => {
    const cat: CatalogLike = { tables: [{ name: "users", columns: [{ name: "phone", type: "bigint" }, { name: "notes", type: "text" }, { name: "city", type: "text" }] }] };
    const p = effectivePolicy(base, cat, "postgres");
    expect(compileSummary(req({ table: "users", measures: [{ fn: "sum", field: "phone" }] }), "postgres", p)).toMatchObject({ ok: false });
    expect(compileSummary(req({ table: "users", measures: [{ fn: "count" }], filters: [{ field: "notes", op: "eq", value: "x" }] }), "postgres", p)).toMatchObject({ ok: false });
  });
  it("disabled table and case-variant table names are refused", () => {
    const p = effectivePolicy({ ...base, disabled_tables: ["users"] }, catalog, "postgres");
    expect(compileSummary(req({ table: "users", measures: [{ fn: "count" }] }), "postgres", p)).toMatchObject({ ok: false });
    expect(compileSummary(req({ table: "Users", measures: [{ fn: "count" }] }), "mongodb", moPolicy)).toMatchObject({ ok: false });
  });
  it("counts records (count(*) / $sum: 1), not distinct values; order is fixed by __n", () => {
    const r = compileSummary(req({ table: "users", measures: [{ fn: "avg", field: "credits" }], group_by: [{ field: "city" }] }), "postgres", pgPolicy);
    const text = sqlOf(r).text;
    expect(text).toContain('count(*) AS "__n"');
    expect(text).toContain('ORDER BY "__n" DESC');
    expect(text).not.toMatch(/count\(DISTINCT/i);
    const m = compileSummary(req({ table: "users", measures: [{ fn: "count" }], group_by: [{ field: "city" }] }), "mongodb", moPolicy);
    expect(mongoOf(m).pipeline[0]).toMatchObject({ $group: { __n: { $sum: 1 } } });
  });
  it("suppressSmallGroups drops rows under 5 (incl. the single ungrouped row) with their sums/avgs", () => {
    expect(suppressSmallGroups([{ city: "LA", __n: 4, sum_credits: 100 }, { city: "SF", __n: "7", sum_credits: 9 }, { city: "NY" }])).toEqual([
      { city: "SF", __n: "7", sum_credits: 9 },
    ]);
    expect(suppressSmallGroups([{ __n: 3, avg_credits: 12 }])).toEqual([]);
  });
  it("normal 'bookings by city last 7 days' passes", () => {
    const cat: CatalogLike = { tables: [{ name: "bookings", columns: [{ name: "id", type: "uuid" }, { name: "city", type: "text" }, { name: "created_at", type: "timestamptz" }, { name: "total", type: "numeric" }] }] };
    const p = effectivePolicy(base, cat, "postgres");
    const r = compileSummary(
      req({ table: "bookings", measures: [{ fn: "count" }, { fn: "sum", field: "total" }], group_by: [{ field: "city" }], filters: [{ field: "created_at", op: "gte", value: "2026-10-04" }] }),
      "postgres",
      p,
      "totals_only",
    );
    expect(r).toMatchObject({ kind: "sql", params: ["2026-10-04"] });
  });
  it("unknown table and unknown field are refused", () => {
    expect(compileSummary(req({ table: "sessions", measures: [{ fn: "count" }] }), "postgres", pgPolicy)).toMatchObject({ ok: false });
    expect(compileSummary(req({ table: "users", measures: [{ fn: "sum", field: "nope" }] }), "postgres", pgPolicy)).toMatchObject({ ok: false });
  });
  it("extra keys and non-expressible shapes are rejected by the schema", () => {
    expect(SummaryRequest.safeParse({ table: "users", measures: [{ fn: "count" }], sql: "SELECT 1" }).success).toBe(false);
    expect(SummaryRequest.safeParse({ table: "users", measures: [{ fn: "first", field: "email" }] }).success).toBe(false);
    expect(SummaryRequest.safeParse({ table: "users", measures: [{ fn: "count", field: "$$ROOT" }] }).success).toBe(false);
    expect(SummaryRequest.safeParse({ table: "users", measures: [{ fn: "sum", field: "$$ROOT.email" }] }).success).toBe(false);
    expect(SummaryRequest.safeParse({ table: "users", measures: [{ fn: "count" }], group_by: [{ field: "city", over: "x" }] }).success).toBe(false);
  });
  it("bucket only on date fields; sum only on numeric", () => {
    expect(compileSummary(req({ table: "users", measures: [{ fn: "count" }], group_by: [{ field: "city", bucket: "week" }] }), "postgres", pgPolicy)).toMatchObject({ ok: false });
    expect(compileSummary(req({ table: "users", measures: [{ fn: "sum", field: "city" }] }), "postgres", pgPolicy)).toMatchObject({ ok: false });
  });
});

describe("summary compile", () => {
  it("Postgres bucket, parameterized filters, limit", () => {
    const r = compileSummary(
      req({
        table: "users",
        measures: [{ fn: "count" }, { fn: "sum", field: "credits" }],
        group_by: [{ field: "created_at", bucket: "week" }],
        filters: [{ field: "city", op: "in", value: ["LA", "SF"] }, { field: "credits", op: "gt", value: 0 }],
        limit: 20,
      }),
      "postgres",
      pgPolicy,
    );
    expect(r).toEqual({
      kind: "sql",
      text:
        `SELECT date_trunc('week', "created_at") AS "created_at_week", count(*) AS "__n", count(*) AS "count", sum("credits") AS "sum_credits" ` +
        `FROM ONLY "public"."users" WHERE "city" IN ($1, $2) AND "credits" > $3 GROUP BY date_trunc('week', "created_at") ` +
        `HAVING count(*) >= 5 ORDER BY "__n" DESC LIMIT 20`,
      params: ["LA", "SF", 0],
    });
  });
  it("MySQL bucket expression and ? params", () => {
    const r = compileSummary(
      req({ table: "users", measures: [{ fn: "count" }], group_by: [{ field: "created_at", bucket: "month" }], filters: [{ field: "city", op: "eq", value: "LA" }] }),
      "mysql",
      myPolicy,
    );
    expect(sqlOf(r).text).toBe(
      "SELECT DATE_FORMAT(`created_at`, '%Y-%m-01') AS `created_at_month`, count(*) AS `__n`, count(*) AS `count` FROM `users` WHERE `city` = ? GROUP BY DATE_FORMAT(`created_at`, '%Y-%m-01') HAVING count(*) >= 5 ORDER BY `__n` DESC LIMIT 100",
    );
    expect(sqlOf(r).params).toEqual(["LA"]);
  });
  it("MySQL summary is qualified with the connected database when known", () => {
    const r = compileSummary(req({ table: "users", measures: [{ fn: "count" }], group_by: [{ field: "city" }] }), "mysql", myPolicy, "cloud", { mysqlDatabase: "shop" });
    expect(sqlOf(r).text).toContain("FROM `shop`.`users`");
  });
  it("Mongo $dateTrunc pipeline", () => {
    const r = compileSummary(
      req({ table: "users", measures: [{ fn: "avg", field: "credits" }], group_by: [{ field: "createdAt", bucket: "day" }], filters: [{ field: "city", op: "in", value: ["LA"] }], limit: 10 }),
      "mongodb",
      moPolicy,
    );
    expect(r).toEqual({
      kind: "mongo",
      collection: "users",
      pipeline: [
        { $match: { $and: [{ city: { $in: ["LA"] } }] } },
        { $group: { _id: { createdAt_day: { $dateTrunc: { date: "$createdAt", unit: "day" } } }, __n: { $sum: 1 }, avg_credits: { $avg: "$credits" } } },
        { $match: { __n: { $gte: 5 } } },
        { $sort: { __n: -1 } },
        { $limit: 10 },
      ],
    });
  });
});
