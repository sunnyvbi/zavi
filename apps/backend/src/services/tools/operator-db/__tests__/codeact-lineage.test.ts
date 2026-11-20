import { describe, it, expect } from "vitest";
import { fakeSession } from "@/services/data-gateway/__tests__/fake-session";
import { classifySqlLineage, runCodeActReads } from "../codeact-sql";
import { mongoReadTainted } from "../drivers/mongo";

const R = "‹redacted›";

async function read(sql: string, rows: Record<string, unknown>[], dialect: "postgres" | "mysql" = "postgres") {
  const { session } = fakeSession({ dialect, rows });
  const [r] = await runCodeActReads(session, [sql]);
  return r!;
}

describe("SQL reads that move a sensitive column are masked", () => {
  it("a plain sensitive column under an alias: that output only", async () => {
    const r = await read("SELECT full_name AS label, city FROM customers", [{ label: "Ada Lovelace", city: "Austin" }]);
    expect(r.rows).toEqual([{ label: R, city: "Austin" }]);
    expect(r.masked).toBe("columns");
  });

  it("DISTINCT ON does not hide a renamed column (review F1)", async () => {
    const r = await read(
      "SELECT DISTINCT ON (customer_id) full_name AS label, status FROM customers ORDER BY customer_id, updated_at DESC",
      [{ label: "Ada", status: "paid" }],
    );
    expect(r.rows).toEqual([{ label: R, status: "paid" }]);
    expect(r.masked).toBe("columns");
  });

  it("a bare alias too", async () => {
    const r = await read("SELECT c.full_name label FROM customers c", [{ label: "Ada" }]);
    expect(r.rows).toEqual([{ label: R }]);
  });

  it.each([
    ["a function over it", "SELECT upper(address) FROM customers", [{ upper: "1 MAIN ST" }]],
    ["a CTE", "WITH x AS (SELECT full_name AS n FROM customers) SELECT n FROM x", [{ n: "Ada" }]],
    ["a UNION", "SELECT full_name FROM a UNION SELECT city FROM b", [{ full_name: "Ada" }]],
    ["a UNION, sensitive branch second", "SELECT city FROM b UNION SELECT full_name FROM a", [{ city: "Ada" }]],
    ["a derived table", "SELECT x.n FROM (SELECT full_name AS n FROM customers) x", [{ n: "Ada" }]],
    ["a scalar subquery", "SELECT (SELECT full_name FROM c WHERE c.id = o.cid) AS who FROM o", [{ who: "Ada" }]],
    ["a whole-row value", "SELECT row_to_json(c) AS j FROM customers c", [{ j: "{\"x\":\"Ada\"}" }]],
    ["a whole row through t.* in a function", "SELECT concat_ws(' ', c.*) AS j FROM customers c", [{ j: "Ada Austin" }]],
    ["an alias list over a table", "SELECT a FROM customers t(id, a)", [{ a: "Ada" }]],
    ["a JSON key", "SELECT profile->>'full_name' AS who FROM users", [{ who: "Ada" }]],
    ["a JSON path function", "SELECT JSON_UNQUOTE(JSON_EXTRACT(profile, '$.email')) AS who FROM users", [{ who: "a@b.co" }]],
    ["a jsonpath query function", "SELECT jsonb_path_query_first(profile, '$.full_name') AS who FROM users", [{ who: "Ada" }]],
    ["a JSON path array", "SELECT profile #>> '{contact,full_name}' AS who FROM users", [{ who: "Ada" }]],
    ["a JSON key matched in WHERE", "SELECT value AS label FROM jsonb_each_text(profile) WHERE key = 'email'", [{ label: "a@b.co" }]],
    ["a JSON subscript", "SELECT profile['full_name'] AS who FROM users", [{ who: "Ada" }]],
    ["a JSON pivot through CASE inside a builder", "SELECT json_build_object('result', CASE key WHEN 'full_name' THEN value END) AS j FROM jsonb_each_text(profile)", [{ j: "{\"result\":\"Ada\"}" }]],
    ["a JSON path nested in a builder","SELECT json_build_object('who', profile->>'full_name') AS j FROM users", [{ j: "{\"who\":\"Ada\"}" }]],
    [
      "a LATERAL subquery after a join's ON",
      "SELECT x.label FROM accounts a JOIN plans p ON p.id = a.plan_id, LATERAL (SELECT email AS label FROM users u WHERE u.id = a.user_id) x",
      [{ label: "a@b.co" }],
    ],
    ["a scalar subquery in the select list", "SELECT city, (SELECT max(email) FROM subscribers s WHERE s.city = c.city) AS e FROM customers c", [{ city: "Austin", e: "x" }]],
    ["a date of birth formatted", "SELECT to_char(dob, 'YYYY-MM-DD') AS d FROM users", [{ d: "1990-01-02" }]],
    ["a CASE over a name", "SELECT CASE WHEN last_name LIKE 'A%' THEN last_name ELSE 'x' END AS k FROM users", [{ k: "Adams" }]],
  ])("%s: every string masked", async (_label, sql, rows) => {
    const r = await read(sql, rows as Record<string, unknown>[]);
    for (const row of r.rows) for (const v of Object.values(row)) expect(v).toBe(R);
    expect(r.masked).toBe("strings");
  });

  it("a tainted read keeps numbers, booleans and numeric strings, masks dates", async () => {
    const r = await read(
      "SELECT upper(full_name) AS who, sum(total) AS s, count(*) AS n, bool_or(vip) AS v, max(dob) AS d FROM users GROUP BY 1",
      [{ who: "ADA", s: "42.50", n: 3, v: true, d: new Date("1990-01-02") }],
      "mysql",
    );
    expect(r.rows).toEqual([{ who: R, s: "42.50", n: 3, v: true, d: R }]);
  });
});

describe("SQL reads that do not move a sensitive column keep their text", () => {
  it.each([
    [
      "CASE buckets, to_char months and counts",
      "SELECT city, CASE WHEN total > 100 THEN 'big' ELSE 'small' END AS bucket, to_char(created_at,'YYYY-MM') AS month, count(*) FROM orders GROUP BY 1,2,3",
      { city: "Austin", bucket: "big", month: "2026-09", count: 4 },
    ],
    ["a CTE over safe columns", "WITH x AS (SELECT city, status FROM orders) SELECT city, status, count(*) AS n FROM x GROUP BY 1, 2", { city: "Austin", status: "paid", n: 2 }],
    ["a UNION of safe columns", "SELECT city FROM a UNION SELECT city FROM b", { city: "Austin" }],
    ["COUNT(email)", "SELECT city, count(email) AS with_email, count(DISTINCT u.email) AS d FROM users u GROUP BY city", { city: "Austin", with_email: 3, d: 2 }],
    ["email IS NULL", "SELECT city, email IS NULL AS no_email FROM users", { city: "Austin", no_email: true }],
    ["a filter and grouping on a sensitive column", "SELECT city, count(*) AS n FROM users WHERE email LIKE '%@gmail.com' GROUP BY city ORDER BY city", { city: "Austin", n: 1 }],
    ["a join on a sensitive column", "SELECT o.status FROM orders o JOIN users u ON u.email = o.email", { status: "paid" }],
    ["a date spine with an alias list", "SELECT d.day, count(o.id) AS n FROM generate_series(now() - interval '7 days', now(), interval '1 day') AS d(day) LEFT JOIN orders o ON o.created_at::date = d.day::date GROUP BY 1", { day: "2026-10-01", n: 2 }],
    ["select star", "SELECT * FROM orders", { status: "paid", city: "Austin" }],
    ["a subquery inside a filter (review F2)", "SELECT city, count(*) AS n FROM customers WHERE email IN (SELECT email FROM subscribers) GROUP BY city", { city: "Austin", n: 2 }],
    ["EXISTS over a sensitive column", "SELECT city FROM customers c WHERE EXISTS (SELECT full_name FROM leads l WHERE l.email = c.email)", { city: "Austin" }],
    [
      "JSON built with labels named like personal data (review F3)",
      "SELECT json_build_object('email_count', count(*), 'bucket', CASE WHEN total > 100 THEN 'big' ELSE 'small' END) AS j FROM orders",
      { j: { email_count: 3, bucket: "big" } },
    ],
    ["a scalar subquery compared in WHERE", "SELECT city FROM customers WHERE email = (SELECT email FROM subscribers LIMIT 1)", { city: "Austin" }],
    ["NOT EXISTS over a sensitive column", "SELECT city FROM customers c WHERE NOT EXISTS (SELECT 1 FROM leads l WHERE l.email = c.email)", { city: "Austin" }],
    ["a JSON path to a safe key","SELECT profile->>'city' AS c FROM users", { c: "Austin" }],
  ])("%s", async (_label, sql, row) => {
    const r = await read(sql, [row as Record<string, unknown>]);
    expect(r.rows).toEqual([row]);
    expect(r.masked).toBeUndefined();
  });

  it("an unreadable statement for the lineage scanner masks rather than refuses (classifier only)", () => {
    expect(classifySqlLineage("SELECT 'a\\b' AS x", "postgres")).toMatchObject({ mode: "all" });
  });

  it("trustedSql (Zavi-built SQL) skips lineage masking", async () => {
    const { session } = fakeSession({ dialect: "postgres", rows: [{ geo: "1 Main St" }] });
    const [r] = await runCodeActReads(session, ["SELECT upper(address) AS geo FROM listings"], { trustedSql: true });
    expect(r!.rows).toEqual([{ geo: "1 Main St" }]);
  });
});

describe("Mongo lineage", () => {
  it.each([
    ["$project rename", [{ $project: { label: "$full_name" } }]],
    ["$concat", [{ $project: { label: { $concat: ["$first_name", " ", "$city"] } } }]],
    ["$group by a sensitive field", [{ $group: { _id: "$email", n: { $sum: 1 } } }]],
    ["$objectToArray", [{ $project: { kv: { $objectToArray: "$$ROOT" } } }]],
    ["a $map variable path", [{ $project: { x: { $map: { input: "$items", as: "i", in: "$$i.phone" } } } }]],
  ])("%s taints", (_l, pipeline) => {
    expect(mongoReadTainted(pipeline)).toBe(true);
  });

  it.each([
    ["as-is output", [{ $project: { email: 1, full_name: "$full_name", city: 1 } }]],
    ["a filter on a sensitive field", [{ $match: { email: { $exists: true }, full_name: /^A/ } }, { $group: { _id: "$city", n: { $sum: 1 } } }]],
    ["a safe rename", [{ $project: { where: "$city", n: "$count" } }]],
  ])("%s does not taint", (_l, pipeline) => {
    expect(mongoReadTainted(pipeline)).toBe(false);
  });

  it("the driver masks every string of a tainted aggregate, numbers survive", async () => {
    const { mongoDriver } = await import("../drivers/mongo");
    const { attachSession } = await import("../session-attach");
    const fake = fakeSession({ dialect: "mongodb", docs: [{ label: "Ada Lovelace", n: 3, total: "42.50" }] });
    const cfg = attachSession({ users: { table: "users", id_field: "_id" } } as never, fake.session);
    const res = await mongoDriver().aggregate!("users", [{ $project: { label: "$full_name", n: 1, total: 1 } }], {}, cfg, new Set(["users"]));
    expect(res.data!.rows).toEqual([{ label: R, n: 3, total: "42.50" }]);
    expect(res.data!.masked).toBe("strings");
  });

  it("an untainted aggregate keeps its labels", async () => {
    const { mongoDriver } = await import("../drivers/mongo");
    const { attachSession } = await import("../session-attach");
    const fake = fakeSession({ dialect: "mongodb", docs: [{ _id: "Austin", n: 3 }] });
    const cfg = attachSession({ users: { table: "users", id_field: "_id" } } as never, fake.session);
    const res = await mongoDriver().aggregate!("users", [{ $group: { _id: "$city", n: { $sum: 1 } } }], {}, cfg, new Set(["users"]));
    expect(res.data!.rows).toEqual([{ _id: "Austin", n: 3 }]);
    expect(res.data!.masked).toBeUndefined();
  });
});
