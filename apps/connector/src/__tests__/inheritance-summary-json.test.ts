import { describe, it, expect, vi } from "vitest";
import { parseRulesText } from "../rules";
import { checkRequest } from "../check";
import { execute, describeResult } from "../execute";
import { openPostgres } from "../db/postgres";
import { TABLE_CAP, type Driver, type Introspection } from "../db/types";

const intro: Introspection = {
  dialect: "postgres",
  database: null,
  tables: [
    { name: "people", rowEstimate: 5, columns: [{ name: "id", type: "integer", nullable: false }, { name: "salary", type: "numeric", nullable: true }] },
    { name: "staff", rowEstimate: 5, parents: ["people"], columns: [{ name: "id", type: "integer", nullable: false }, { name: "salary", type: "numeric", nullable: true }, { name: "team", type: "text", nullable: true }] },
    { name: "events", rowEstimate: 50, columns: [{ name: "city", type: "text", nullable: true }, { name: "payload", type: "jsonb", nullable: true }, { name: "amount", type: "numeric", nullable: true }] },
  ],
  skippedUnsafeNames: 0,
  namesSeenTotal: 3,
  deadlineHit: false,
  listingTruncated: false,
};
const rules = (text: string) => ({ rules: parseRulesText(text), dialect: "postgres" as const, database: null, catalog: intro, maxStatementMs: 30_000 });
const ROWS = "what_can_leave: rows_without_blocked_columns\nmax_rows_per_query: 1000\n";

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

describe("INHERITS children on the connector", () => {
  it("child allowed but parent not allowed: refused, and describe leaves the child out", () => {
    const ctx = rules(`allowed_tables: [staff, events]\n${ROWS}`);
    const c = checkRequest({ op: "sql", text: "SELECT team FROM staff", max_rows: 10 }, ctx);
    expect(c.ok).toBe(false);
    const d = checkRequest({ op: "describe" }, ctx);
    if (!d.ok || d.kind !== "describe") throw new Error("describe should pass");
    const r = describeResult(intro, d.policy);
    if (r.status !== "done" || r.data.kind !== "describe") throw new Error("expected describe");
    expect(r.data.introspection.tables.map((t) => t.name)).toEqual(["events"]);
  });
  it("parent-blocked field is blocked on the child; describe sends the child's parents", () => {
    const ctx = rules(`allowed_tables: [people, staff]\nblocked_columns: [people.salary]\n${ROWS}`);
    expect(checkRequest({ op: "sql", text: "SELECT salary FROM staff", max_rows: 10 }, ctx).ok).toBe(false);
    const d = checkRequest({ op: "describe" }, ctx);
    if (!d.ok || d.kind !== "describe") throw new Error("describe should pass");
    const r = describeResult(intro, d.policy);
    if (r.status !== "done" || r.data.kind !== "describe") throw new Error("expected describe");
    const staff = r.data.introspection.tables.find((t) => t.name === "staff")!;
    expect(staff.parents).toEqual(["people"]);
    expect(staff.columns.map((x) => x.name)).toEqual(["id", "team"]);
  });
});

describe("summaries and JSON on the connector", () => {
  const ctx = rules(`allowed_tables: [events]\n${ROWS}`);
  it("group by a JSON column is refused", () => {
    const c = checkRequest({ op: "summary", request: { table: "events", measures: [{ fn: "count" }], group_by: [{ field: "payload" }] } }, ctx);
    expect(c.ok).toBe(false);
  });
  it("summary by city still works, and a sensitive key inside a returned value is stripped", async () => {
    const c = checkRequest({ op: "summary", request: { table: "events", measures: [{ fn: "count" }], group_by: [{ field: "city" }] } }, ctx);
    if (!c.ok) throw new Error(`summary should pass: ${JSON.stringify(c)}`);
    const sql = vi.fn(async () => ({ columns: ["city", "__n", "count"], rows: [{ city: '{"email":"a@b.co","zone":"west"}', __n: 7, count: 7 }], truncated: false }));
    const r = await execute(c, { driver: fakeDriver({ sql }), intro });
    if (r.status !== "done" || r.data.kind !== "rows") throw new Error("expected rows");
    expect(JSON.stringify(r.data.rows)).not.toContain("a@b.co");
    expect(JSON.stringify(r.data.rows)).toContain("west");
  });
});

describe("connector Postgres describe: the alphabetical cap keeps parents", () => {
  it("a partition inside the cap brings its parent past the cap along, and records it", async () => {
    const names = Array.from({ length: TABLE_CAP }, (_, i) => `a${String(i).padStart(5, "0")}`);
    const listing = [...names, "zz_parent"].map((n) => ({ table_name: n, est: "1" }));
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (/FROM information_schema\.tables/.test(sql)) return { rows: listing, fields: [] };
      if (/WITH RECURSIVE anc/.test(sql)) return { rows: [{ child: "a00000", parents: ["zz_parent"] }], fields: [] };
      if (/FROM information_schema\.columns/.test(sql)) {
        return { rows: ((params?.[0] as string[]) ?? []).map((n) => ({ table_name: n, column_name: "id", data_type: "integer", is_nullable: "NO" })), fields: [] };
      }
      return { rows: [], fields: [] };
    });
    const d = openPostgres("postgres://u:p@localhost/app", () => ({ connect: async () => undefined, query, end: async () => undefined }) as never);
    const out = await d.introspect(Date.now() + 10_000);
    const byName = new Map(out.tables.map((t) => [t.name, t]));
    expect(out.tables.length).toBe(TABLE_CAP);
    expect(byName.has("zz_parent")).toBe(true);
    expect(byName.get("a00000")?.parents).toEqual(["zz_parent"]);
    expect(out.listingTruncated).toBe(true);
  });
});
