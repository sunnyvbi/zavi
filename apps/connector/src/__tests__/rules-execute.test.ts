import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { MAX_RESULT_BYTES, parseConnectorResult, ConnectorRulesSummary } from "@zavi/shared/db-guard";
import { RulesFile, rulesHash, rulesSummary, parseRulesText } from "../rules";
import { checkRequest } from "../check";
import { execute, describeResult, toCell } from "../execute";
import type { Driver, Introspection, MongoRunner } from "../db/types";

const intro: Introspection = {
  dialect: "postgres",
  database: null,
  tables: [
    { name: "users", rowEstimate: 5, columns: [{ name: "id", type: "integer", nullable: false }, { name: "email", type: "text", nullable: false }, { name: "plan", type: "text", nullable: true }] },
    { name: "notes", rowEstimate: 5, columns: [{ name: "id", type: "integer", nullable: false }, { name: "body", type: "text", nullable: true }] },
    { name: "hidden_tbl", rowEstimate: 9, columns: [{ name: "id", type: "integer", nullable: false }] },
  ],
  skippedUnsafeNames: 0,
  namesSeenTotal: 3,
  deadlineHit: false,
  listingTruncated: false,
};

function fakeDriver(over: Partial<Driver> = {}): Driver {
  return {
    dialect: "postgres",
    database: null,
    test: vi.fn(async () => undefined),
    introspect: vi.fn(async () => intro),
    sql: vi.fn(async () => ({ columns: [], rows: [], truncated: false })),
    mongo: () => {
      throw new Error("no mongo");
    },
    transport: () => "verified_tls",
    close: vi.fn(async () => undefined),
    ...over,
  };
}
const ROWS = parseRulesText("allowed_tables: [users, notes]\nblocked_columns: [users.email]\nwhat_can_leave: rows_without_blocked_columns\nmax_rows_per_query: 1000\n");
const ctx = { rules: ROWS, dialect: "postgres" as const, database: null, catalog: intro, maxStatementMs: 30_000 };

describe("rules file", () => {
  it("defaults refuse: no file means nothing allowed, totals only", () => {
    const f = new RulesFile(mkdtempSync(join(tmpdir(), "zc-rules-")));
    const s = f.current();
    expect(s.status).toBe("missing");
    expect(s.rules.allowed).toEqual([]);
    expect(s.rules.what_can_leave).toBe("totals_and_counts_only");
  });
  it("save round-trips, is 0600, and notifies listeners (the heartbeat goes out with the new hash)", () => {
    const dir = mkdtempSync(join(tmpdir(), "zc-rules-"));
    const f = new RulesFile(dir);
    const changed = vi.fn();
    f.onChange(changed);
    const saved = f.save({ allowed: ["users"], blocked: ["users.email"], what_can_leave: "rows_without_blocked_columns", max_rows: 120 }, { database: "app", unit: "table" });
    expect(saved.status).toBe("ok");
    expect(saved.rules).toEqual({ allowed: ["users"], blocked: ["users.email"], what_can_leave: "rows_without_blocked_columns", max_rows: 120 });
    expect(new RulesFile(dir).current().rules).toEqual(saved.rules);
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it("a hand edit takes effect on the next read; an invalid edit refuses everything", () => {
    const dir = mkdtempSync(join(tmpdir(), "zc-rules-"));
    const f = new RulesFile(dir);
    writeFileSync(f.path, "allowed_tables: [users]\n");
    expect(f.current().rules.allowed).toEqual(["users"]);
    writeFileSync(f.path, "allowed_tables: [users]\nmax_rows_per_query: 99999\n");
    expect(f.current().status).toBe("invalid");
    writeFileSync(f.path, "allowed_tables: [users\n");
    expect(f.current().status).toBe("invalid");
    expect(f.current().rules.allowed).toEqual([]);
  });
  it("summary matches the protocol schema; the hash ignores order and changes with content", () => {
    const a = parseRulesText("allowed_tables: [b, a]\nblocked_columns: [a.x]\n");
    const b = parseRulesText("allowed_tables: [a, b]\nblocked_columns: [a.x]\n");
    expect(ConnectorRulesSummary.safeParse(rulesSummary(a)).success).toBe(true);
    expect(rulesHash(rulesSummary(a))).toBe(rulesHash(rulesSummary(b)));
    expect(rulesHash(rulesSummary(a))).toMatch(/^[0-9a-f]{64}$/);
    const c = parseRulesText("allowed_tables: [a, b]\nblocked_columns: [a.x, a.y]\n");
    expect(rulesHash(rulesSummary(c))).not.toBe(rulesHash(rulesSummary(a)));
  });
  it("allowed_columns is in the summary and the hash; editing only allowed_columns changes the hash", () => {
    const base = "allowed_tables: [a]\nblocked_columns: [a.x]\n";
    const none = parseRulesText(base);
    const one = parseRulesText(`${base}allowed_columns: [a.who]\n`);
    const two = parseRulesText(`${base}allowed_columns: [a.who, a.shape]\n`);
    const twoSwapped = parseRulesText(`${base}allowed_columns: [a.shape, a.who]\n`);
    expect(rulesSummary(none)).not.toHaveProperty("allowed_columns");
    expect(rulesSummary(two).allowed_columns).toEqual(["a.shape", "a.who"]);
    expect(ConnectorRulesSummary.safeParse(rulesSummary(two)).success).toBe(true);
    const h = (r: ReturnType<typeof parseRulesText>) => rulesHash(rulesSummary(r));
    expect(h(one)).not.toBe(h(none));
    expect(h(two)).not.toBe(h(one));
    expect(h(two)).toBe(h(twoSwapped));
    expect(h(parseRulesText(`${base}allowed_columns: []\n`))).toBe(h(none));
  });
});

describe("executing a checked read", () => {
  it("strips hidden / sensitive keys inside a JSON column before the row leaves (plain keys stay)", async () => {
    const driver = fakeDriver({
      sql: vi.fn(async () => ({
        columns: ["id", "body"],
        rows: [
          { id: 1, body: { plan: "pro", email: "j@x.com", profile: { phone: "555" } } },
          { id: 2, body: '{"plan":"free","email":"k@x.com"}' },
        ],
        truncated: false,
      })),
    });
    const c = checkRequest({ op: "sql", text: "SELECT id, body FROM notes", max_rows: 10 }, ctx);
    if (!c.ok) throw new Error(c.reason);
    const r = await execute(c, { driver, intro });
    if (r.status !== "done" || r.data.kind !== "rows") throw new Error("expected rows");
    expect(JSON.stringify(r)).not.toContain("@x.com");
    expect(JSON.stringify(r)).not.toContain("555");
    expect(JSON.stringify(r.data.rows)).toContain("pro");
    expect(JSON.stringify(r.data.rows)).toContain("free");
  });

  it("refuses JSON decomposition functions (off the shared allowlist, on the connector too)", () => {
    const c = checkRequest({ op: "sql", text: "SELECT jsonb_each_text(body::jsonb) FROM notes", max_rows: 10 }, ctx);
    expect(c.ok).toBe(false);
  });

  it("strips a blocked column even if the database returns it (backstop), and caps rows", async () => {
    const driver = fakeDriver({
      sql: vi.fn(async (_t: string, _p: unknown[], o: { maxRows: number }) => ({
        columns: ["id", "email", "plan"],
        rows: Array.from({ length: o.maxRows }, (_, i) => ({ id: i, email: `u${i}@x.com`, plan: "pro" })),
        truncated: true,
      })),
    });
    const c = checkRequest({ op: "sql", text: "SELECT id, plan FROM users", max_rows: 3 }, ctx);
    if (!c.ok) throw new Error(c.reason);
    const r = await execute(c, { driver, intro });
    expect(r.status).toBe("done");
    if (r.status !== "done" || r.data.kind !== "rows") throw new Error("expected rows");
    expect(r.data.columns).toEqual(["id", "plan"]);
    expect(JSON.stringify(r)).not.toContain("@x.com");
    expect(r.data.rows).toHaveLength(3);
    expect(r.data.truncated).toBe(true);
    expect(r.data.removed_columns).toEqual(["email"]);
    expect(vi.mocked(driver.sql).mock.calls[0]![2]).toMatchObject({ maxRows: 3 });
  });

  it("an oversized result drops rows from the end, says truncated, and stays under the byte cap", async () => {
    const big = "x".repeat(4000);
    const driver = fakeDriver({ sql: vi.fn(async () => ({ columns: ["id", "body"], rows: Array.from({ length: 1000 }, (_, i) => ({ id: i, body: big })), truncated: false })) });
    const c = checkRequest({ op: "sql", text: "SELECT id, body FROM notes", max_rows: 1000 }, ctx);
    if (!c.ok) throw new Error(c.reason);
    const r = await execute(c, { driver, intro });
    if (r.status !== "done" || r.data.kind !== "rows") throw new Error("expected rows");
    expect(r.data.truncated).toBe(true);
    expect(r.data.rows.length).toBeGreaterThan(100);
    expect(r.data.rows.length).toBeLessThan(1000);
    expect(Buffer.byteLength(JSON.stringify({ execution_token: "00000000-0000-0000-0000-000000000000", ...r }))).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(parseConnectorResult(r).ok).toBe(true);
  });

  it("long cells are clipped and odd values become protocol scalars", () => {
    expect((toCell("y".repeat(5000)) as string).length).toBe(4096);
    expect(toCell(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02T03:04:05.000Z");
    expect(toCell(10n)).toBe("10");
    expect(toCell({ a: 1 })).toBe('{"a":1}');
    expect(toCell(Number.NaN)).toBe("NaN");
    expect(toCell(Buffer.from("hi"))).toBe("base64:aGk=");
  });

  it("more than 200 columns fails with a reason instead of sending a broken result", async () => {
    const cols = Array.from({ length: 201 }, (_, i) => `c${i}`);
    const driver = fakeDriver({ sql: vi.fn(async () => ({ columns: cols, rows: [], truncated: false })) });
    const c = checkRequest({ op: "sql", text: "SELECT id FROM users", max_rows: 5 }, ctx);
    if (!c.ok) throw new Error(c.reason);
    const r = await execute(c, { driver, intro });
    expect(r.status).toBe("failed");
  });

  it("summary rows under 5 records are dropped before anything leaves; __n stays for the cloud's own floor", async () => {
    const driver = fakeDriver({ sql: vi.fn(async () => ({ columns: ["plan", "__n", "count"], rows: [{ plan: "pro", __n: "12", count: "12" }, { plan: "vip", __n: "2", count: "2" }], truncated: false })) });
    const c = checkRequest({ op: "summary", request: { table: "users", measures: [{ fn: "count" }], group_by: [{ field: "plan" }] } }, ctx);
    if (!c.ok) throw new Error(c.reason);
    const r = await execute(c, { driver, intro });
    if (r.status !== "done" || r.data.kind !== "rows") throw new Error("expected rows");
    expect(r.data.rows).toEqual([["pro", "12", "12"]]);
    expect(r.data.columns).toContain("__n");
  });

  it("describe lists allowed tables only, omits blocked columns, and carries no values", () => {
    const c = checkRequest({ op: "describe" }, ctx);
    if (!c.ok || c.kind !== "describe") throw new Error("expected describe");
    const r = describeResult(intro, c.policy);
    if (r.status !== "done" || r.data.kind !== "describe") throw new Error("expected describe");
    expect(r.data.introspection.tables.map((t) => t.name)).toEqual(["users", "notes"]);
    expect(r.data.introspection.tables[0]!.columns.map((x) => x.name)).toEqual(["id", "plan"]);
    expect(JSON.stringify(r)).not.toContain("hidden_tbl");
    expect(parseConnectorResult(r).ok).toBe(true);
  });

  it("describe names only allowed partitions; a switched-off partition's name never leaves", () => {
    const pIntro: Introspection = {
      ...intro,
      tables: [
        { name: "events", rowEstimate: 100, partitioned: true, partitions: ["events_2025", "events_secret"], columns: [{ name: "id", type: "integer", nullable: false }] },
        { name: "events_2025", rowEstimate: 50, columns: [{ name: "id", type: "integer", nullable: false }] },
        { name: "events_secret", rowEstimate: 50, columns: [{ name: "id", type: "integer", nullable: false }] },
        { name: "logs", rowEstimate: 10, partitioned: true, partitions: ["logs_secret"], columns: [{ name: "id", type: "integer", nullable: false }] },
        { name: "logs_secret", rowEstimate: 10, columns: [{ name: "id", type: "integer", nullable: false }] },
      ],
    };
    const rules = parseRulesText("allowed_tables: [events, events_2025, logs]\nwhat_can_leave: rows_without_blocked_columns\n");
    const c = checkRequest({ op: "describe" }, { ...ctx, rules, catalog: pIntro });
    if (!c.ok || c.kind !== "describe") throw new Error("expected describe");
    const r = describeResult(pIntro, c.policy);
    if (r.status !== "done" || r.data.kind !== "describe") throw new Error("expected describe");
    const byName = Object.fromEntries(r.data.introspection.tables.map((t) => [t.name, t]));
    expect(Object.keys(byName)).toEqual(["events", "events_2025", "logs"]);
    expect(byName.events).toMatchObject({ partitioned: true, partitions: ["events_2025"] });
    expect(byName.logs).toMatchObject({ partitioned: true, partitions: [] });
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(parseConnectorResult(r).ok).toBe(true);

    const q = checkRequest({ op: "sql", text: "SELECT count(*) FROM events", params: [], max_rows: 10 }, { ...ctx, rules, catalog: pIntro });
    expect(q.ok).toBe(false);
    if (q.ok) return;
    expect(q.reason).toContain("events is partitioned and one of its partitions is not allowed by this connector's rules");
    expect(q.reason).not.toContain("secret");
  });

  it("Mongo docs: blocked fields stripped at any depth, sent as EJSON", async () => {
    const mIntro: Introspection = { ...intro, dialect: "mongodb", database: "app", tables: [{ name: "users", rowEstimate: 2, columns: [{ name: "_id", type: "ObjectId", nullable: false }, { name: "email", type: "String", nullable: false }, { name: "plan", type: "String", nullable: true }, { name: "createdAt", type: "Date", nullable: false }] }] };
    const runner: MongoRunner = {
      find: vi.fn(async () => ({ docs: [{ _id: 1, email: "a@b.c", plan: "pro", createdAt: new Date("2026-01-01T00:00:00Z"), profile: { email: "x@y.z" } }], truncated: false })),
      aggregate: vi.fn(),
      countDocuments: vi.fn(),
      estimatedDocumentCount: vi.fn(),
      listCollections: vi.fn(),
    } as unknown as MongoRunner;
    const driver = fakeDriver({ dialect: "mongodb", mongo: () => runner });
    const rules = parseRulesText("allowed_collections: [users]\nblocked_fields: [users.email]\nwhat_can_leave: rows_without_blocked_columns\n");
    const c = checkRequest({ op: "mongo", action: "find", collection: "users", max_rows: 10 }, { rules, dialect: "mongodb", database: "app", catalog: mIntro, maxStatementMs: 30_000 });
    if (!c.ok) throw new Error(c.reason);
    const r = await execute(c, { driver, intro: mIntro });
    expect(JSON.stringify(r)).not.toContain("@");
    expect(JSON.stringify(r)).toContain('{"$date":"2026-01-01T00:00:00Z"}');
  });
});
