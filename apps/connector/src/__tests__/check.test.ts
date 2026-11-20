import { describe, it, expect } from "vitest";
import { EJSON } from "bson";
import { effectivePolicy, guardMongoAggregate, guardMongoFind, guardSql, MIN_GROUP_SIZE } from "@zavi/shared/db-guard";
import { checkRequest, TOTALS_ONLY_REFUSAL, type CheckContext } from "../check";
import { parseRulesText } from "../rules";
import type { Introspection } from "../db/types";

const pgIntro: Introspection = {
  dialect: "postgres",
  database: null,
  tables: [
    { name: "users", rowEstimate: 1200, columns: [{ name: "id", type: "integer", nullable: false }, { name: "email", type: "text", nullable: false }, { name: "plan", type: "text", nullable: true }, { name: "created_at", type: "timestamp without time zone", nullable: false }] },
    { name: "bookings", rowEstimate: 9000, columns: [{ name: "id", type: "integer", nullable: false }, { name: "user_id", type: "integer", nullable: false }, { name: "city", type: "text", nullable: true }, { name: "amount", type: "numeric", nullable: true }, { name: "created_at", type: "timestamp without time zone", nullable: false }] },
    { name: "secrets", rowEstimate: 3, columns: [{ name: "id", type: "integer", nullable: false }, { name: "value", type: "text", nullable: false }] },
  ],
  skippedUnsafeNames: 0,
  namesSeenTotal: 3,
  deadlineHit: false,
  listingTruncated: false,
};
const mongoIntro: Introspection = {
  ...pgIntro,
  dialect: "mongodb",
  database: "app",
  tables: [
    { name: "users", rowEstimate: 1200, columns: [{ name: "_id", type: "ObjectId", nullable: false }, { name: "email", type: "String", nullable: false }, { name: "plan", type: "String", nullable: true }, { name: "createdAt", type: "Date", nullable: false }] },
  ],
};

const rules = (yaml: string) => parseRulesText(yaml);
const ROWS = rules("allowed_tables: [users, bookings]\nblocked_columns: [users.email]\nwhat_can_leave: rows_without_blocked_columns\nmax_rows_per_query: 50\n");
const TOTALS = rules("allowed_tables: [users, bookings]\nblocked_columns: [users.email]\nwhat_can_leave: totals_and_counts_only\n");
const MROWS = rules("allowed_collections: [users]\nblocked_fields: [users.email]\nwhat_can_leave: rows_without_blocked_columns\n");
const MTOTALS = rules("allowed_collections: [users]\nblocked_fields: [users.email]\n");

const ctx = (r = ROWS, intro: Introspection = pgIntro): CheckContext => ({ rules: r, dialect: intro.dialect, database: intro.database, catalog: intro, maxStatementMs: 30_000 });
const sql = (text: string, max_rows = 100) => ({ op: "sql", text, max_rows });
const reasonOf = (c: ReturnType<typeof checkRequest>) => {
  expect(c.ok).toBe(false);
  return c.ok ? "" : c.reason;
};

describe("Totals and counts only: free-form reads are refused", () => {
  it.each([
    ["window over rows", sql("SELECT id, count(*) OVER() FROM users")],
    ["min of a personal field", sql("SELECT min(email) FROM users")],
    ["plain row read", sql("SELECT id, plan FROM users")],
  ])("%s", (_n, op) => {
    expect(reasonOf(checkRequest(op, ctx(TOTALS)))).toBe(TOTALS_ONLY_REFUSAL);
  });
  it("Mongo $$ROOT capture and a $facet raw branch are refused", () => {
    const c = ctx(MTOTALS, mongoIntro);
    expect(reasonOf(checkRequest({ op: "mongo", action: "aggregate", collection: "users", pipeline: [{ $group: { _id: "$_id", doc: { $first: "$$ROOT" } } }], max_rows: 10 }, c))).toBe(TOTALS_ONLY_REFUSAL);
    expect(reasonOf(checkRequest({ op: "mongo", action: "aggregate", collection: "users", pipeline: [{ $facet: { raw: [{ $limit: 5 }] } }], max_rows: 10 }, c))).toBe(TOTALS_ONLY_REFUSAL);
    expect(reasonOf(checkRequest({ op: "mongo", action: "find", collection: "users", max_rows: 10 }, c))).toBe(TOTALS_ONLY_REFUSAL);
  });
  it("summary min on email is refused; min/max are refused in totals mode", () => {
    expect(reasonOf(checkRequest({ op: "summary", request: { table: "users", measures: [{ fn: "min", field: "email" }] } }, ctx(TOTALS)))).toMatch(/min is not available|personal|hidden/);
    expect(reasonOf(checkRequest({ op: "summary", request: { table: "bookings", measures: [{ fn: "max", field: "amount" }] } }, ctx(TOTALS)))).toMatch(/not available with "Totals and counts only"/);
  });
  it("summary grouped by id is refused (identifier)", () => {
    expect(reasonOf(checkRequest({ op: "summary", request: { table: "bookings", measures: [{ fn: "count" }], group_by: [{ field: "user_id" }] } }, ctx(TOTALS)))).toMatch(/identifier/);
  });
  it("an allowed summary passes and is compiled with the 5-record floor", () => {
    const c = checkRequest({ op: "summary", request: { table: "bookings", measures: [{ fn: "count" }, { fn: "sum", field: "amount" }], group_by: [{ field: "city" }] } }, ctx(TOTALS));
    expect(c.ok).toBe(true);
    if (!c.ok || c.kind !== "summary" || c.compiled.kind !== "sql") throw new Error("expected sql summary");
    expect(c.compiled.text).toContain(`HAVING count(*) >= ${MIN_GROUP_SIZE}`);
    expect(c.compiled.text).toContain('ONLY "public"."bookings"');
  });
  it("describe is allowed in totals mode (structure only)", () => {
    expect(checkRequest({ op: "describe" }, ctx(TOTALS)).ok).toBe(true);
  });
});

describe("Rows mode", () => {
  it("a blocked column is refused", () => {
    expect(reasonOf(checkRequest(sql("SELECT email FROM users"), ctx()))).toMatch(/email/);
  });
  it("a table not in allowed tables is refused", () => {
    expect(reasonOf(checkRequest(sql("SELECT value FROM secrets"), ctx()))).toMatch(/secrets/);
  });
  it("pg_read_file and other non-allowlisted functions are refused", () => {
    expect(reasonOf(checkRequest(sql("SELECT pg_read_file('/etc/passwd')"), ctx()))).toBeTruthy();
    expect(reasonOf(checkRequest(sql("SELECT id FROM users WHERE pg_sleep(10) IS NULL"), ctx()))).toBeTruthy();
  });
  it("writes and multiple statements are refused", () => {
    expect(reasonOf(checkRequest(sql("DELETE FROM users"), ctx()))).toBeTruthy();
    expect(reasonOf(checkRequest(sql("SELECT 1; DROP TABLE users"), ctx()))).toBeTruthy();
    expect(reasonOf(checkRequest(sql("WITH x AS (DELETE FROM users RETURNING id) SELECT * FROM x"), ctx()))).toBeTruthy();
  });
  it("an allowed read passes, rewritten to visible columns, rows capped at the rules' max", () => {
    const c = checkRequest(sql("SELECT * FROM users", 500), ctx());
    expect(c.ok).toBe(true);
    if (!c.ok || c.kind !== "sql") throw new Error("expected sql");
    expect(c.text).not.toMatch(/"email"/);
    expect(c.maxRows).toBe(50);
    expect(c.hidden).toEqual(["email"]);
  });
  it("statement timeout: Zavi may lower it, never raise it past the connector's cap", () => {
    const c = checkRequest({ op: "sql", text: "SELECT id FROM users", max_rows: 5, statement_timeout_ms: 120_000 }, { ...ctx(), maxStatementMs: 10_000 });
    expect(c.ok && c.kind === "sql" && c.timeoutMs).toBe(10_000);
  });
  it("Mongo: blocked field in a filter is refused; projections with expressions are refused", () => {
    const c = ctx(MROWS, mongoIntro);
    expect(reasonOf(checkRequest({ op: "mongo", action: "find", collection: "users", filter: { email: "a@b.c" }, max_rows: 5 }, c))).toMatch(/email/);
    expect(reasonOf(checkRequest({ op: "mongo", action: "find", collection: "users", options: { projection: { x: { $function: { body: "1", args: [], lang: "js" } } } }, max_rows: 5 }, c))).toMatch(/0 or 1/);
    expect(reasonOf(checkRequest({ op: "mongo", action: "find", collection: "others", max_rows: 5 }, c))).toMatch(/others/);
  });
  it("Mongo EJSON values are deserialized before the guard (dates stay dates)", () => {
    const filter = EJSON.serialize({ createdAt: { $gte: new Date("2026-01-01T00:00:00Z") } }, { relaxed: true });
    const c = checkRequest({ op: "mongo", action: "find", collection: "users", filter, max_rows: 5 }, ctx(MROWS, mongoIntro));
    expect(c.ok).toBe(true);
    if (!c.ok || c.kind !== "mongo") throw new Error("expected mongo");
    expect((c.filter.createdAt as { $gte: unknown }).$gte).toBeInstanceOf(Date);
  });
});

describe("what the cloud already guarded passes the connector's guard", () => {
  const cloud = effectivePolicy({ auto_hide: true, hidden_fields: [], unhidden_fields: [], disabled_tables: [] }, { tables: pgIntro.tables }, "postgres");
  it.each(["SELECT id, plan FROM users", "SELECT u.plan, count(*) FROM users u JOIN bookings b ON b.user_id = u.id GROUP BY u.plan", "SELECT * FROM bookings"])("SQL: %s", (q) => {
    const g = guardSql(q, { policy: cloud, dialect: "postgres" });
    expect(g.ok).toBe(true);
    expect(checkRequest(sql((g as { sql: string }).sql), ctx()).ok).toBe(true);
  });
  it("Mongo find and aggregate (with the cloud's $unset stage)", () => {
    const mcloud = effectivePolicy({ auto_hide: true, hidden_fields: [], unhidden_fields: [], disabled_tables: [] }, { tables: mongoIntro.tables }, "mongodb");
    const f = guardMongoFind("users", { plan: "pro" }, { limit: 5 }, { policy: mcloud });
    const a = guardMongoAggregate("users", [{ $match: { plan: "pro" } }, { $group: { _id: "$plan", n: { $sum: 1 } } }], { policy: mcloud });
    expect(f.ok && a.ok).toBe(true);
    const c = ctx(MROWS, mongoIntro);
    expect(checkRequest({ op: "mongo", action: "find", collection: "users", filter: (f as { filter: object }).filter, options: (f as { options: object }).options, max_rows: 5 }, c).ok).toBe(true);
    expect(checkRequest({ op: "mongo", action: "aggregate", collection: "users", pipeline: (a as { pipeline: object[] }).pipeline, max_rows: 5 }, c).ok).toBe(true);
  });

  it("an aggregate may ask to spill to disk; nothing else in its options passes", () => {
    const mcloud = effectivePolicy({ auto_hide: true, hidden_fields: [], unhidden_fields: [], disabled_tables: [] }, { tables: mongoIntro.tables }, "mongodb");
    const a = guardMongoAggregate("users", [{ $group: { _id: "$plan", n: { $sum: 1 } } }], { policy: mcloud });
    const c = ctx(MROWS, mongoIntro);
    const pipeline = (a as { pipeline: object[] }).pipeline;
    const spill = checkRequest({ op: "mongo", action: "aggregate", collection: "users", pipeline, options: { allowDiskUse: true, maxTimeMS: 1000 }, max_rows: 5 }, c);
    expect(spill.ok && (spill as { options: object }).options).toEqual({ allowDiskUse: true });
    const plain = checkRequest({ op: "mongo", action: "aggregate", collection: "users", pipeline, options: { allowDiskUse: "yes", bypassDocumentValidation: true }, max_rows: 5 }, c);
    expect(plain.ok && (plain as { options: object }).options).toEqual({});
  });
});

describe("fail closed", () => {
  it("no rules file: nothing allowed", () => {
    expect(reasonOf(checkRequest(sql("SELECT id FROM users"), ctx(parseRulesMissing())))).toMatch(/No tables are allowed/);
  });
  it("invalid rules (unknown key, e.g. a typo) refuse everything", () => {
    const bad = rules("allowed_tables: [users]\nblocked_colums: [users.email]\nwhat_can_leave: rows_without_blocked_columns\n");
    expect(bad.status).toBe("invalid");
    expect(reasonOf(checkRequest(sql("SELECT id FROM users"), ctx(bad)))).toMatch(/rules\.yaml/);
  });
  it("a malformed op is refused, never run", () => {
    expect(reasonOf(checkRequest({ op: "sql", text: "SELECT 1", max_rows: 99999 }, ctx()))).toMatch(/does not understand/);
    expect(reasonOf(checkRequest({ op: "exec", cmd: "rm -rf /" }, ctx()))).toMatch(/does not understand/);
  });
  it("no database added: failed, not run", () => {
    const c = checkRequest(sql("SELECT id FROM users"), { ...ctx(), dialect: null, catalog: null });
    expect(!c.ok && c.status).toBe("failed");
  });
});

function parseRulesMissing() {
  return { status: "missing" as const, rules: { allowed: [], blocked: [], what_can_leave: "totals_and_counts_only" as const, max_rows: 200 }, error: null, text: null };
}

describe("refusals read as the connector's rules", () => {
  it("a blocked column and a non-allowed table name the connector, not Zavi's settings", () => {
    expect(reasonOf(checkRequest(sql("SELECT email FROM users"), ctx()))).toMatch(/blocked by this connector's rules/);
    expect(reasonOf(checkRequest(sql("SELECT value FROM secrets"), ctx()))).toMatch(/this connector allows/);
  });
});
