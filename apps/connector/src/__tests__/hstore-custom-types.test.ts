import { describe, it, expect, vi } from "vitest";
import { parseRulesText } from "../rules";
import { checkRequest } from "../check";
import { execute } from "../execute";
import { openPostgres } from "../db/postgres";
import type { Driver, Introspection } from "../db/types";

describe("connector Postgres describe: USER-DEFINED columns", () => {
  it("hstore keys and composite attributes are sampled by name; types are resolved", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (/FROM information_schema\.tables/.test(sql)) return { rows: [{ table_name: "profiles", est: "10" }], fields: [] };
      if (/FROM information_schema\.columns/.test(sql)) {
        const col = (column_name: string, data_type: string, udt_name: string, typtype: string) => ({ table_name: "profiles", column_name, data_type, is_nullable: "YES", udt_name, typtype, type_schema: "public", type_citext_ext: udt_name === "citext" });
        return { rows: [col("attrs", "USER-DEFINED", "hstore", "b"), col("city", "USER-DEFINED", "citext", "b"), col("who", "USER-DEFINED", "person_t", "c"), col("shape", "USER-DEFINED", "geometry", "b")], fields: [] };
      }
      if (/p\.proname = 'skeys'/.test(sql)) return { rows: [{ schema: "public", type_schema: "public" }], fields: [] };
      if (/count\(\*\)::int AS n/.test(sql)) return { rows: [{ n: 3 }], fields: [] };
      if (/skeys\(s\.h\)/.test(sql)) return { rows: [{ k: "email" }], fields: [] };
      if (/FROM pg_type t\s+JOIN pg_namespace n/.test(sql) && (params?.[0] as string[])?.[0] === "public.person_t") {
        return { rows: [{ type_schema: "public", type_name: "person_t", attname: "ssn", att_typtype: "b", att_typname: "text", att_schema: "pg_catalog" }], fields: [] };
      }
      return { rows: [], fields: [] };
    });
    const d = openPostgres("postgres://u:p@localhost/app", () => ({ connect: async () => undefined, query, end: async () => undefined }) as never);
    const out = await d.introspect(Date.now() + 10_000);
    const cols = new Map(out.tables[0]!.columns.map((c) => [c.name, c]));
    expect(cols.get("attrs")).toMatchObject({ type: "hstore", json_sampled: "full", json_keys: ["email"] });
    expect(cols.get("city")?.type).toBe("citext");
    expect(cols.get("who")).toMatchObject({ type: "composite (person_t)", json_sampled: "full", json_keys: ["ssn"] });
    expect(cols.get("shape")?.type).toBe("USER-DEFINED (geometry)");
  });

  it("a look-alike public.citext (not the extension's) and arrays/domains over it stay unknown and hidden", async () => {
    const query = vi.fn(async (sql: string) => {
      if (/FROM information_schema\.tables/.test(sql)) return { rows: [{ table_name: "shops", est: "10" }], fields: [] };
      if (/FROM information_schema\.columns/.test(sql)) {
        expect(sql).toMatch(/deptype = 'e' AND xe\.extname = 'citext'/);
        const base = { table_name: "shops", is_nullable: "YES", type_schema: "public" };
        return {
          rows: [
            { ...base, column_name: "real_city", data_type: "USER-DEFINED", udt_name: "citext", typtype: "b", type_citext_ext: true },
            { ...base, column_name: "fake_city", data_type: "USER-DEFINED", udt_name: "citext", typtype: "b", type_citext_ext: false },
            { ...base, column_name: "fake_tags", data_type: "ARRAY", udt_name: "_citext", typtype: "b", elem_typtype: "b", elem_name: "citext", elem_schema: "public", elem_citext_ext: false },
            { ...base, column_name: "fake_dom", data_type: "ARRAY", udt_name: "_email_d", typtype: "b", elem_typtype: "d", elem_name: "email_d", elem_schema: "public", elem_citext_ext: false, elem_base_typtype: "b", elem_base_name: "citext", elem_base_schema: "public", elem_base_citext_ext: false },
          ],
          fields: [],
        };
      }
      return { rows: [], fields: [] };
    });
    const d = openPostgres("postgres://u:p@localhost/app", () => ({ connect: async () => undefined, query, end: async () => undefined }) as never);
    const out = await d.introspect(Date.now() + 10_000);
    const cols = new Map(out.tables[0]!.columns.map((c) => [c.name, c.type]));
    expect(cols.get("real_city")).toBe("citext");
    expect(cols.get("fake_city")).toBe("USER-DEFINED (citext)");
    expect(cols.get("fake_tags")).toBe("USER-DEFINED (citext[])");
    expect(cols.get("fake_dom")).toBe("USER-DEFINED (email_d[])");
    const c2 = { ...ctx, rules: parseRulesText("allowed_tables: [shops]\nwhat_can_leave: rows_without_blocked_columns\nmax_rows_per_query: 1000\n"), catalog: out };
    const sum = (field: string) => checkRequest({ op: "summary", request: { table: "shops", measures: [{ fn: "count" }], group_by: [{ field }] } }, c2);
    expect(sum("real_city").ok).toBe(true);
    for (const f of ["fake_city", "fake_tags", "fake_dom"]) expect(sum(f).ok, f).toBe(false);
    expect(checkRequest({ op: "sql", text: "SELECT fake_city FROM shops", max_rows: 10 }, c2).ok).toBe(false);
  });
});

const intro: Introspection = {
  dialect: "postgres",
  database: null,
  tables: [
    {
      name: "stores",
      rowEstimate: 50,
      columns: [
        { name: "id", type: "integer", nullable: false },
        { name: "attrs", type: "hstore", nullable: true, json_sampled: "full", json_keys: ["plan"] },
        { name: "who", type: "composite (person_t)", nullable: true, json_sampled: "full", json_keys: ["label"] },
        { name: "city", type: "citext", nullable: true },
      ],
    },
  ],
  skippedUnsafeNames: 0,
  namesSeenTotal: 1,
  deadlineHit: false,
  listingTruncated: false,
};
const ctx = { rules: parseRulesText("allowed_tables: [stores]\nwhat_can_leave: rows_without_blocked_columns\nmax_rows_per_query: 1000\n"), dialect: "postgres" as const, database: null, catalog: intro, maxStatementMs: 30_000 };

function fakeDriver(sql: Driver["sql"]): Driver {
  return {
    dialect: "postgres",
    database: null,
    test: vi.fn(async () => undefined),
    introspect: vi.fn(async () => intro),
    sql,
    mongo: () => {
      throw new Error("no mongo");
    },
    transport: () => "verified_tls",
    close: vi.fn(async () => undefined),
  };
}

describe("connector guard: hstore and composite columns", () => {
  it("blocked by default: key reads, decomposition and composite field access are refused", () => {
    for (const text of ["SELECT attrs->'salary' FROM stores", "SELECT each(attrs) FROM stores", "SELECT (who).label FROM stores"]) {
      expect(checkRequest({ op: "sql", text, max_rows: 10 }, ctx).ok, text).toBe(false);
    }
  });
  it("summaries refuse hstore and composite group-bys; a citext city works", () => {
    const sum = (field: string) => checkRequest({ op: "summary", request: { table: "stores", measures: [{ fn: "count" }], group_by: [{ field }] } }, ctx);
    expect(sum("attrs").ok).toBe(false);
    expect(sum("who").ok).toBe(false);
    expect(sum("city").ok).toBe(true);
  });
  it("hstore text in a result loses sensitive keys before it leaves (column allowed in rules.yaml)", async () => {
    const allowed = { ...ctx, rules: parseRulesText("allowed_tables: [stores]\nallowed_columns: [stores.attrs]\nwhat_can_leave: rows_without_blocked_columns\nmax_rows_per_query: 1000\n") };
    expect(checkRequest({ op: "sql", text: "SELECT id, attrs FROM stores", max_rows: 10 }, ctx).ok).toBe(false);
    const c = checkRequest({ op: "sql", text: "SELECT id, attrs FROM stores", max_rows: 10 }, allowed);
    if (!c.ok) throw new Error(`read should pass: ${JSON.stringify(c)}`);
    const sql = vi.fn(async () => ({ columns: ["id", "attrs"], rows: [{ id: 1, attrs: '"plan"=>"pro", "email"=>"a@b.co"' }], truncated: false }));
    const r = await execute(c, { driver: fakeDriver(sql), intro });
    if (r.status !== "done" || r.data.kind !== "rows") throw new Error("expected rows");
    expect(JSON.stringify(r.data.rows)).not.toContain("a@b.co");
    expect(JSON.stringify(r.data.rows)).toContain("pro");
  });
});

describe("connector rules: hstore, composite and unknown user types are blocked by default", () => {
  const cat: Introspection = {
    ...intro,
    tables: [
      {
        name: "people",
        rowEstimate: 5,
        columns: [
          { name: "id", type: "integer", nullable: false },
          { name: "who", type: "composite (person_t)", nullable: true, json_sampled: "full", json_keys: ["ssn"] },
          { name: "place", type: "composite (place_t)", nullable: true, json_sampled: "full", json_keys: ["lat", "lng"] },
          { name: "shape", type: "USER-DEFINED (geometry)", nullable: true },
        ],
      },
    ],
  };
  const rulesCtx = (text: string) => ({ rules: parseRulesText(text), dialect: "postgres" as const, database: null, catalog: cat, maxStatementMs: 30_000 });
  const base = "allowed_tables: [people]\nwhat_can_leave: rows_without_blocked_columns\nmax_rows_per_query: 100\n";
  it("existing rules without allowed_columns block every composite / unknown column, even one with plain attributes", () => {
    const ctx = rulesCtx(base);
    expect(checkRequest({ op: "sql", text: "SELECT who FROM people", max_rows: 10 }, ctx).ok).toBe(false);
    expect(checkRequest({ op: "sql", text: "SELECT shape FROM people", max_rows: 10 }, ctx).ok).toBe(false);
    expect(checkRequest({ op: "sql", text: "SELECT place FROM people", max_rows: 10 }, ctx).ok).toBe(false);
    expect(checkRequest({ op: "sql", text: "SELECT id FROM people", max_rows: 10 }, ctx).ok).toBe(true);
  });
  it("an exact allowed_columns entry lets that whole column through", () => {
    const parsed = parseRulesText(`${base}allowed_columns: [people.who]\n`);
    expect(parsed.status).toBe("ok");
    expect(parsed.rules.allowed_columns).toEqual(["people.who"]);
    const ctx = rulesCtx(`${base}allowed_columns: [people.who]\n`);
    expect(checkRequest({ op: "sql", text: "SELECT who FROM people", max_rows: 10 }, ctx).ok).toBe(true);
    expect(checkRequest({ op: "sql", text: "SELECT shape FROM people", max_rows: 10 }, ctx).ok).toBe(false);
  });
  it("a literal path to a sampled sensitive key of an allowed JSON column is refused on the connector", () => {
    const jcat: Introspection = { ...intro, tables: [{ name: "leads", rowEstimate: 5, columns: [{ name: "contact", type: "jsonb", nullable: true, json_sampled: "full", json_keys: ["email", "zone"] }] }] };
    const ctx = { rules: parseRulesText("allowed_tables: [leads]\nwhat_can_leave: rows_without_blocked_columns\nmax_rows_per_query: 100\n"), dialect: "postgres" as const, database: null, catalog: jcat, maxStatementMs: 30_000 };
    expect(checkRequest({ op: "sql", text: "SELECT contact->>'email' FROM leads", max_rows: 10 }, ctx).ok).toBe(false);
    expect(checkRequest({ op: "sql", text: "SELECT contact->>'zone' FROM leads", max_rows: 10 }, ctx).ok).toBe(true);
  });
});
