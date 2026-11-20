import { describe, it, expect } from "vitest";
import {
  annotatePgStructuredColumns,
  checkSummary,
  effectivePolicy,
  guardSql,
  isSensitiveColumn,
  pgColumnType,
  sensitiveColumnKind,
  stripJsonInRows,
  type CatalogLike,
  type PolicyRow,
  type StructuredColumn,
  HSTORE_UNCHECKED,
  STRIP_MAX_CELL_CHARS,
  STRIP_MAX_RESULT_CHARS,
  parseHstoreText,
  serializeHstore,
} from "@zavi/shared/db-guard";

const autoHide: PolicyRow = { auto_hide: true, hidden_fields: [], unhidden_fields: [], disabled_tables: [] };
const pg = (sql: string, policy: ReturnType<typeof effectivePolicy>) => guardSql(sql, { policy, dialect: "postgres" });
const reason = (r: { ok: boolean; reason?: string }) => (r.ok ? "" : (r.reason ?? ""));

describe("discovery records the real type of USER-DEFINED columns", () => {
  it("hstore, citext, enum, composite, unknown and arrays", () => {
    expect(pgColumnType({ data_type: "USER-DEFINED", udt_name: "hstore", typtype: "b" })).toBe("hstore");
    expect(pgColumnType({ data_type: "USER-DEFINED", udt_name: "citext", typtype: "b", type_citext_ext: true })).toBe("citext");
    expect(pgColumnType({ data_type: "USER-DEFINED", udt_name: "order_status", typtype: "e" })).toBe("enum (order_status)");
    expect(pgColumnType({ data_type: "USER-DEFINED", udt_name: "person_t", typtype: "c" })).toBe("composite (person_t)");
    expect(pgColumnType({ data_type: "USER-DEFINED", udt_name: "geometry", typtype: "b" })).toBe("USER-DEFINED (geometry)");
    expect(pgColumnType({ data_type: "USER-DEFINED", udt_name: "hstore" })).toBe("USER-DEFINED (hstore)");
    expect(pgColumnType({ data_type: "ARRAY", udt_name: "_int4", elem_typtype: "b", elem_name: "int4", elem_schema: "pg_catalog" })).toBe("ARRAY");
    expect(pgColumnType({ data_type: "ARRAY", udt_name: "_order_status", elem_typtype: "e", elem_name: "order_status", elem_schema: "public" })).toBe("ARRAY");
    expect(pgColumnType({ data_type: "ARRAY", udt_name: "_person_t", elem_typtype: "c", elem_name: "person_t", elem_schema: "public" })).toBe("USER-DEFINED (person_t[])");
    expect(pgColumnType({ data_type: "text", udt_name: "text", typtype: "b" })).toBe("text");
  });

  it("only the citext EXTENSION's type is citext; a look-alike public.citext is unknown (hidden)", () => {
    expect(pgColumnType({ data_type: "USER-DEFINED", udt_name: "citext", typtype: "b", type_schema: "public", type_citext_ext: true })).toBe("citext");
    const fake = pgColumnType({ data_type: "USER-DEFINED", udt_name: "citext", typtype: "b", type_schema: "public", type_citext_ext: false });
    expect(fake).toBe("USER-DEFINED (citext)");
    expect(isSensitiveColumn("profiles", { name: "city", type: fake })).toBe(true);
    expect(pgColumnType({ data_type: "USER-DEFINED", udt_name: "citext", typtype: "b" })).toBe("USER-DEFINED (citext)");
    expect(pgColumnType({ data_type: "ARRAY", udt_name: "_citext", elem_typtype: "b", elem_name: "citext", elem_schema: "public", elem_citext_ext: true })).toBe("ARRAY");
    expect(pgColumnType({ data_type: "ARRAY", udt_name: "_citext", elem_typtype: "b", elem_name: "citext", elem_schema: "public", elem_citext_ext: false })).toBe("USER-DEFINED (citext[])");
    const dom = { data_type: "ARRAY", udt_name: "_email_d", elem_typtype: "d", elem_name: "email_d", elem_schema: "public", elem_citext_ext: false, elem_base_typtype: "b", elem_base_name: "citext", elem_base_schema: "public" };
    expect(pgColumnType({ ...dom, elem_base_citext_ext: true })).toBe("ARRAY");
    expect(pgColumnType({ ...dom, elem_base_citext_ext: false })).toBe("USER-DEFINED (email_d[])");
    expect(isSensitiveColumn("profiles", { name: "emails", type: pgColumnType({ ...dom, elem_base_citext_ext: false }) })).toBe(true);
  });
});

type Call = { sql: string; params?: unknown[] };

function fakeRun(opts: {
  skeysSchema?: string | null;
  skeysTypeSchema?: string;
  hstoreKeys?: Record<string, string[]>;
  hstoreCount?: number;
  attrs?: Record<string, { attname: string; att_typtype: string; att_typname: string; att_schema: string }[]>;
  failComposite?: boolean;
}) {
  const calls: Call[] = [];
  const run = async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (/^(SAVEPOINT|RELEASE|ROLLBACK)/.test(sql)) return [];
    if (/p\.proname = 'skeys'/.test(sql)) return opts.skeysSchema === null ? [] : [{ schema: opts.skeysSchema ?? "public", type_schema: opts.skeysTypeSchema ?? "public" }];
    if (/count\(\*\)::int AS n/.test(sql)) return [{ n: opts.hstoreCount ?? 10 }];
    const k = /skeys\(s\.h\)/.test(sql) ? /WHERE "([^"]+)" IS NOT NULL/.exec(sql)?.[1] : null;
    if (k) return (opts.hstoreKeys?.[k] ?? []).map((x) => ({ k: x }));
    if (/FROM pg_type t\s+JOIN pg_namespace n/.test(sql)) {
      if (opts.failComposite) throw new Error("permission denied");
      const out: Record<string, unknown>[] = [];
      for (const key of (params?.[0] as string[]) ?? []) {
        const [schema, name] = key.split(".");
        for (const a of opts.attrs?.[key] ?? []) out.push({ type_schema: schema, type_name: name, ...a });
      }
      return out;
    }
    return [];
  };
  return { run, calls };
}

const scalar = (attname: string, att_typname = "text") => ({ attname, att_typtype: "b", att_typname, att_schema: "pg_catalog" });

async function discovered(cols: StructuredColumn[], run: Parameters<typeof annotatePgStructuredColumns>[2], refs: { column: string; name: string; schema?: string }[] = []) {
  const tables = [{ name: "profiles", columns: cols }];
  const all: { column: string; name: string; schema?: string }[] = [...refs, ...cols.filter((c) => c.type === "hstore" && !refs.some((r) => r.column === c.name)).map((c) => ({ column: c.name, name: "hstore" }))];
  await annotatePgStructuredColumns(tables, all.map((r) => ({ table: "profiles", column: r.column, schema: r.schema ?? "public", name: r.name })), run, { deadlineAt: Date.now() + 5000 });
  return tables;
}

describe("hstore, composite and unknown columns are hidden by default", () => {
  it("discovery records hstore key names and composite attribute names (values-free) for the reason label", async () => {
    const f = fakeRun({ hstoreKeys: { attrs: ["email", "plan"], tags: ["color"] }, attrs: { "public.person_t": [scalar("label"), scalar("ssn")] } });
    const tables = await discovered(
      [{ name: "id", type: "integer" }, { name: "attrs", type: "hstore" }, { name: "tags", type: "hstore" }, { name: "who", type: "composite (person_t)" }],
      f.run,
      [{ column: "who", name: "person_t" }],
    );
    expect(tables[0]!.columns[1]).toMatchObject({ json_sampled: "full", json_keys: ["email", "plan"] });
    expect(tables[0]!.columns[3]).toMatchObject({ json_sampled: "full", json_keys: ["label", "ssn"] });
    expect(f.calls.some((c) => /"public"\.skeys\(s\.h\)/.test(c.sql))).toBe(true);
    expect(sensitiveColumnKind("profiles", tables[0]!.columns[1]!)).toBe("hstore column: contains email, plan");
    expect(sensitiveColumnKind("profiles", tables[0]!.columns[3]!)).toBe("Custom type: label, ssn");
    expect(sensitiveColumnKind("profiles", { name: "shape", type: "USER-DEFINED (geometry)" })).toBe("Custom type: Zavi couldn't check what's inside");
    const failing = async (sql: string) => {
      if (/skeys\(s\.h\)/.test(sql)) throw new Error("boom");
      return fakeRun({}).run(sql);
    };
    const failed = await discovered([{ name: "attrs", type: "hstore" }], failing);
    expect(failed[0]!.columns[0]!.json_sampled).toBe("none");
    expect(isSensitiveColumn("profiles", failed[0]!.columns[0]!)).toBe(true);
  });

  const cat: CatalogLike = {
    tables: [
      {
        name: "events",
        columns: [
          { name: "id", type: "integer" },
          { name: "attrs", type: "hstore", json_sampled: "full", json_keys: ["plan"] },
          { name: "who", type: "composite (place_t)", json_sampled: "full", json_keys: ["lat", "lng"] },
          { name: "shape", type: "USER-DEFINED (geometry)" },
          { name: "legacy", type: "USER-DEFINED" },
          { name: "city", type: "citext" },
          { name: "status", type: "enum (store_status)" },
          { name: "tags", type: "ARRAY" },
          { name: "revenue", type: "numeric" },
        ],
      },
    ],
  };

  it("hidden even with no sensitive keys sampled and auto-hide off; SELECT * excludes them; naming one or any expression over it is refused", () => {
    for (const autoHideOn of [true, false]) {
      const p = effectivePolicy({ auto_hide: autoHideOn, hidden_fields: [], unhidden_fields: [], disabled_tables: [] }, cat, "postgres");
      expect(p.hiddenFields("events").sort()).toEqual(["attrs", "legacy", "shape", "who"]);
      const star = pg("SELECT * FROM events", p);
      expect(star.ok && star.sql).toBe('SELECT * FROM (SELECT "id", "city", "status", "tags", "revenue" FROM ONLY "public"."events") AS "events"');
      for (const sql of ["SELECT attrs FROM events", "SELECT attrs->'plan' FROM events", "SELECT left(attrs::text, 5) FROM events", "SELECT (who).lat FROM events", "SELECT id FROM events WHERE shape IS NOT NULL", "SELECT count(legacy) FROM events"]) {
        expect(reason(pg(sql, p)), sql).toMatch(/hidden/);
      }
      expect(pg("SELECT city, status, tags FROM events WHERE city = 'Austin'", p).ok).toBe(true);
    }
  });

  it("un-hiding makes the column an ordinary readable column (no special checks)", () => {
    const p = effectivePolicy({ auto_hide: true, hidden_fields: [], unhidden_fields: ["events.attrs", "events.who"], disabled_tables: [] }, cat, "postgres");
    for (const sql of ["SELECT attrs FROM events", "SELECT attrs->'plan', attrs - 'x', left(attrs::text, 5) FROM events", "SELECT (who).lat FROM events", "SELECT a FROM (SELECT attrs AS a FROM events) s"]) {
      expect(pg(sql, p).ok, sql).toBe(true);
    }
  });

  it("summaries refuse hstore, composite and unknown columns even when un-hidden; citext and enums work like text", () => {
    const sp = effectivePolicy({ auto_hide: true, hidden_fields: [], unhidden_fields: ["events.attrs", "events.who", "events.shape"], disabled_tables: [] }, cat, "postgres");
    const sum = (field: string) => checkSummary({ table: "events", measures: [{ fn: "count" }], group_by: [{ field }], filters: [], limit: 50 }, sp);
    expect(reason(sum("attrs"))).toMatch(/structured/);
    expect(reason(sum("who"))).toMatch(/structured/);
    expect(reason(sum("shape"))).toMatch(/structured/);
    expect(sum("city").ok).toBe(true);
    expect(sum("status").ok).toBe(true);
    expect(checkSummary({ table: "events", measures: [{ fn: "sum", field: "revenue" }], group_by: [], filters: [{ field: "attrs", op: "is_null" }], limit: 50 }, sp).ok).toBe(false);
  });

  const visible: CatalogLike = {
    tables: [
      { name: "profiles", columns: [{ name: "id", type: "integer" }, { name: "attrs", type: "hstore", json_sampled: "full", json_keys: ["plan"] }, { name: "payload", type: "jsonb", json_sampled: "full", json_keys: ["zone"] }] },
    ],
  };
  const p = effectivePolicy(autoHide, visible, "postgres");

  it("the result strip parses hstore text and drops sensitive and hidden keys", () => {
    const hidden = effectivePolicy({ ...autoHide, hidden_fields: ["profiles.plan_code"] }, visible, "postgres");
    const rows = [{ attrs: '"plan"=>"pro", "email"=>"a@b.co", "plan_code"=>"X1", "phone"=>NULL, "zone"=>"we\\"st"' }, { attrs: '"ssn"=>"123-45-67' }];
    const out = stripJsonInRows(rows, { policy: hidden, tables: ["profiles"], hidden: hidden.hiddenFields("profiles") });
    const text = JSON.stringify(out);
    expect(text).not.toContain("a@b.co");
    expect(text).not.toContain("X1");
    expect(text).not.toContain("123-45");
    expect(out[0]!.attrs).toBe('"plan"=>"pro", "zone"=>"we\\"st"');
    expect(out[1]!.attrs).toBe(HSTORE_UNCHECKED);
  });

  describe("the hstore strip parses exactly and fails closed", () => {
    const strip = (attrs: string) =>
      stripJsonInRows([{ attrs }], { policy: p, tables: ["profiles"], hidden: [] })[0]!.attrs;
    it("round-trips tricky but valid hstore text", () => {
      for (const ok of [
        '"a=>b, c"=>"v"',
        '"k"=>"x, \\"y\\"=>z"',
        '"back\\\\slash"=>"\\\\"',
        '"plan"=>NULL',
        '"plan"=>"", ""=>"x"',
        '"a"=>"1", "b"=>NULL, "c"=>"3"',
      ]) {
        expect(parseHstoreText(ok), ok).not.toBeNull();
        expect(serializeHstore(parseHstoreText(ok)!)).toBe(ok);
        expect(strip(ok), ok).toBe(ok);
      }
      expect(parseHstoreText("")).toEqual([]);
      expect(strip("")).toBe("");
    });
    it("drops sensitive keys, including one whose name holds =>, commas or escapes", () => {
      expect(strip('"email=>x, y"=>"a@b.co", "plan"=>"pro"')).toBe('"plan"=>"pro"');
      expect(strip('"e\\\\mail"=>"a@b.co", "plan"=>"pro"')).toBe('"plan"=>"pro"');
      expect(strip('"plan"=>"pro", "phone"=>NULL')).toBe('"plan"=>"pro"');
      expect(strip('"plan"=>"\\"email\\"=>\\"a@b.co\\""')).toBe('"plan"=>"\\"email\\"=>\\"a@b.co\\""');
    });
    it("anything that is not exactly hstore output is replaced whole", () => {
      for (const bad of [
        '"em\\ail"=>"a@b.co"',
        '"email"=>"a@b.co',
        '"email" => "a@b.co"',
        '"a"=>"1","email"=>"a@b.co"',
        '"a"=>"1",  "email"=>"x"',
        'prefix "email"=>"a@b.co"',
        '"email"=>"a@b.co" trailing',
        '"email"=>null',
        '"email"=>NULLx',
        'email=>"a@b.co", "x"=>"y"',
        '"a"=>"1", ',
      ]) {
        expect(strip(bad), bad).toBe(HSTORE_UNCHECKED);
      }
    });
  });

});

describe("the JSON / hstore result strip is linear and capped (adversarial inputs)", () => {
  const cat: CatalogLike = { tables: [{ name: "events", columns: [{ name: "id", type: "integer" }, { name: "body", type: "text" }] }] };
  const p = effectivePolicy({ auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] }, cat, "postgres");
  const strip = (rows: Record<string, unknown>[]) => stripJsonInRows(rows, { policy: p, tables: ["events"], hidden: [] });
  const timed = <T>(fn: () => T): { out: T; ms: number } => {
    const t0 = performance.now();
    const out = fn();
    return { out, ms: performance.now() - t0 };
  };
  const N = STRIP_MAX_CELL_CHARS - 10;
  const fill = (unit: string) => unit.repeat(Math.floor(N / unit.length));

  it("long runs of backslashes, quotes and escaped quotes finish in bounded time", () => {
    for (const body of [
      fill("\\"),
      fill('"'),
      fill('\\"'),
      fill('"\\'),
      fill('" '),
      fill('"=>'),
      '"a"=>"' + fill("\\\\") + '"',
      fill('"k":'),
      fill('"email":'),
      "{" + fill('"a":'),
    ]) {
      const { ms } = timed(() => strip([{ body }]));
      expect(ms, body.slice(0, 12)).toBeLessThan(2000);
    }
  });

  it("deeply nested JSON is bounded by the depth cap", () => {
    const deep = "[".repeat(200_000) + "]".repeat(200_000);
    const { out, ms } = timed(() => strip([{ body: deep }]));
    expect(ms).toBeLessThan(2000);
    expect(String(out[0]!.body).length).toBeLessThan(1000);
    const deepObj = '{"a":'.repeat(50_000) + '{"email":"a@b.co"}' + "}".repeat(50_000);
    expect(JSON.stringify(strip([{ body: deepObj }]))).not.toContain("a@b.co");
  });

  it("over a cap the value fails closed: cell length, nodes per cell, characters per result", () => {
    expect(strip([{ body: "x".repeat(STRIP_MAX_CELL_CHARS + 1) }])[0]!.body).toBe(HSTORE_UNCHECKED);
    const wide = Object.fromEntries(Array.from({ length: 150_000 }, (_, i) => [`k${i}`, 1]));
    expect(strip([{ body: wide }])[0]!.body).toBe(HSTORE_UNCHECKED);
    const big = "y".repeat(STRIP_MAX_CELL_CHARS - 1);
    const rows = Array.from({ length: Math.ceil(STRIP_MAX_RESULT_CHARS / big.length) + 2 }, () => ({ body: big, id: 1 }));
    const out = strip(rows);
    expect(out[0]!.body).toBe(big);
    expect(out[out.length - 1]!.body).toBe(HSTORE_UNCHECKED);
    expect(out[out.length - 1]!.id).toBe(1);
  });

  it("text cut inside a string still loses a blocked key (both quote alignments are checked)", () => {
    const out = strip([{ body: 'x", "email": "a@b.co", "zone": "w"' }, { body: '{"note":"a", "email": "a@b.co"' }]);
    expect(JSON.stringify(out)).not.toContain("a@b.co");
    expect(JSON.stringify(out)).toContain("zone");
  });
});

describe("strict vs best-effort strip buckets", () => {
  const cat: CatalogLike = {
    tables: [
      {
        name: "events",
        columns: [
          { name: "id", type: "integer" },
          { name: "payload", type: "jsonb", json_sampled: "full", json_keys: ["zone"] },
          { name: "attrs", type: "hstore", json_sampled: "full", json_keys: ["plan"] },
          { name: "note_text", type: "text" },
        ],
      },
    ],
  };
  const p = effectivePolicy({ auto_hide: true, hidden_fields: [], unhidden_fields: ["events.attrs"], disabled_tables: [] }, cat, "postgres");
  const run = (sql: string, rows: Record<string, unknown>[]) => {
    const g = guardSql(sql, { policy: p, dialect: "postgres" });
    if (!g.ok) throw new Error(g.reason);
    return { g, out: stripJsonInRows(rows, { policy: p, tables: g.tables, hidden: g.hidden, passthrough: g.passthrough, structured: g.structured }) };
  };

  it("the guard reports direct references to JSON / hstore columns, aliased or by *", () => {
    expect(run("SELECT payload AS p, attrs AS a, note_text AS n FROM events", []).g.structured).toEqual([{ name: "p", kind: "json" }, { name: "a", kind: "hstore" }]);
    expect(run("SELECT e.payload AS p FROM events e", []).g.structured).toEqual([{ name: "p", kind: "json" }]);
    expect(run("SELECT * FROM events", []).g.structured.map((s) => s.name).sort()).toEqual(["attrs", "payload"]);
    expect(guardSql("SELECT p FROM (SELECT payload p FROM events) s", { policy: p, dialect: "postgres" }).ok).toBe(false);
  });

  it("a subquery rename of a JSON / hstore column is refused; one that keeps the name stays strict", () => {
    expect(guardSql("SELECT p, a FROM (SELECT payload AS p, attrs AS a FROM events) s", { policy: p, dialect: "postgres" }).ok).toBe(false);
    const { out } = run("SELECT payload FROM (SELECT payload FROM events) s", [{ payload: '{"email": "a@b.co"' }]);
    expect(out[0]).toEqual({ payload: HSTORE_UNCHECKED });
  });

  it("STRICT: a JSON column value that does not parse exactly, or is nested past the cap, is hidden", () => {
    const { out } = run("SELECT payload AS p, payload FROM events", [
      { p: '{"email": "a@b.co"', payload: "[1, " },
      { p: { zone: "w", email: "a@b.co" }, payload: '{"zone":"w","phone":"555"}' },
      { p: '"just a string"', payload: 7 },
    ]);
    expect(out[0]).toEqual({ p: HSTORE_UNCHECKED, payload: HSTORE_UNCHECKED });
    expect(out[1]).toEqual({ p: { zone: "w" }, payload: '{"zone":"w"}' });
    expect(out[2]).toEqual({ p: '"just a string"', payload: 7 });
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i++) deep = { a: deep };
    expect(run("SELECT payload FROM events", [{ payload: deep }]).out[0]!.payload).toBe(HSTORE_UNCHECKED);
  });

  it("STRICT: an aliased hstore value with odd escapes or stray text is hidden; valid text is stripped", () => {
    const { out } = run("SELECT attrs AS a, attrs FROM events", [
      { a: '"em\\ail"=>"a@b.co"', attrs: '"plan"=>"pro" , "email"=>"a@b.co"' },
      { a: '"plan"=>"pro", "email"=>"a@b.co"', attrs: { plan: "pro" } },
    ]);
    expect(out[0]).toEqual({ a: HSTORE_UNCHECKED, attrs: '"plan"=>"pro" , "email"=>"a@b.co"' });
    expect(out[1]).toEqual({ a: '"plan"=>"pro"', attrs: { plan: "pro" } });
  });

  it("BEST EFFORT: other values are stripped only when they parse as JSON, otherwise left (accepted residual)", () => {
    const { out } = run("SELECT note_text, lower(note_text) AS x FROM events", [
      { note_text: '{"email":"a@b.co","zone":"w"}', x: "hello {world" },
      { note_text: '"email"=>"a@b.co"', x: "plain" },
    ]);
    expect(out[0]).toEqual({ note_text: '{"zone":"w"}', x: "hello {world" });
    expect(out[1]!.note_text).not.toBe(HSTORE_UNCHECKED);
    expect(out[1]!.x).toBe("plain");
  });
});

describe("PR 4226 review fixes", () => {
  it("1: skeys is the hstore extension's own (pg_depend), and only columns of its hstore type are sampled", async () => {
    const f = fakeRun({ hstoreKeys: { attrs: ["plan"] } });
    await discovered([{ name: "attrs", type: "hstore" }], f.run);
    const q = f.calls.find((c) => /p\.proname = 'skeys'/.test(c.sql))!.sql;
    expect(q).toMatch(/pg_extension/);
    expect(q).toMatch(/deptype = 'e'/);
    expect(q).toMatch(/td\.objid = t\.oid/);
    const evil = await discovered([{ name: "attrs", type: "hstore" }], fakeRun({ hstoreKeys: { attrs: ["plan"] } }).run, [{ column: "attrs", name: "hstore", schema: "evil" }]);
    expect(evil[0]!.columns[0]!.json_sampled).toBe("none");
    expect(q).toMatch(/p\.pronamespace = e\.extnamespace/);
    expect(q).toMatch(/p\.proretset AND p\.prorettype = 'pg_catalog\.text'/);
    const g = fakeRun({ skeysSchema: "ext", skeysTypeSchema: "ext", hstoreKeys: { attrs: ["plan"] } });
    const ok = await discovered([{ name: "attrs", type: "hstore" }], g.run, [{ column: "attrs", name: "hstore", schema: "ext" }]);
    expect(ok[0]!.columns[0]!.json_sampled).toBe("full");
    expect(g.calls.some((c) => /"ext"\.skeys\(s\.h\)/.test(c.sql))).toBe(true);
  });

  const cat: CatalogLike = {
    tables: [
      { name: "events", columns: [{ name: "id", type: "integer" }, { name: "attrs", type: "hstore", json_sampled: "full", json_keys: ["plan"] }, { name: "payload", type: "jsonb", json_sampled: "full", json_keys: ["zone"] }, { name: "amount", type: "numeric" }] },
      { name: "orders", columns: [{ name: "id", type: "integer" }, { name: "meta", type: "jsonb", json_sampled: "full", json_keys: ["zone"] }] },
      { name: "people", columns: [{ name: "id", type: "integer" }, { name: "who", type: "composite (person_t)", json_sampled: "full", json_keys: ["label"] }] },
    ],
  };
  const p = effectivePolicy({ auto_hide: true, hidden_fields: [], unhidden_fields: [], disabled_tables: [] }, cat, "postgres");
  const g = (sql: string) => guardSql(sql, { policy: p, dialect: "postgres" });

  it("2: alias-column lists and set operations are refused when a JSON column takes part; keyword labels stay strict", () => {
    expect(reason(g("WITH x(p) AS (SELECT payload FROM events) SELECT p FROM x"))).toMatch(/column-alias list/);
    expect(reason(g("SELECT a FROM (SELECT * FROM events) s(a, b)"))).toMatch(/column-alias list|\* inside a subquery/);
    expect(reason(g("SELECT amount FROM events UNION SELECT payload FROM events"))).toMatch(/UNION/);
    expect(g("SELECT id FROM events UNION SELECT id FROM orders").ok).toBe(true);
    expect(g("WITH x(n) AS (SELECT id FROM people) SELECT n FROM x").ok).toBe(true);
    const r = g("SELECT payload AS first, id filter FROM events");
    expect(r.ok && r.structured).toEqual([{ name: "first", kind: "json" }]);
  });

  it("7: a decoded JSON string scalar passes; malformed container text from a JSON column is hidden", () => {
    const strip = (rows: Record<string, unknown>[]) => stripJsonInRows(rows, { policy: p, tables: ["events"], hidden: [] });
    expect(strip([{ payload: "hello" }, { payload: '{"zone": "w"' }, { payload: true }])).toEqual([{ payload: "hello" }, { payload: HSTORE_UNCHECKED }, { payload: true }]);
  });

  it("8: arrays of scalar domains stay ARRAY; arrays of structured domains fail closed", () => {
    expect(pgColumnType({ data_type: "ARRAY", udt_name: "_email_d", elem_typtype: "d", elem_name: "email_d", elem_schema: "public", elem_base_typtype: "b", elem_base_name: "text", elem_base_schema: "pg_catalog" })).toBe("ARRAY");
    expect(pgColumnType({ data_type: "ARRAY", udt_name: "_doc_d", elem_typtype: "d", elem_name: "doc_d", elem_schema: "public", elem_base_typtype: "b", elem_base_name: "jsonb", elem_base_schema: "pg_catalog" })).toBe("USER-DEFINED (doc_d[])");
  });

  it("9: a result-wide node budget counts keys of every value type; once spent, later values are hidden", () => {
    const wide = Object.fromEntries(Array.from({ length: 90_000 }, (_, i) => [`k${i}`, i]));
    const rows = Array.from({ length: 30 }, () => ({ payload: wide }));
    const t0 = performance.now();
    const out = stripJsonInRows(rows, { policy: p, tables: ["events"], hidden: [] });
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(out[0]!.payload).toBe(wide);
    expect(out[29]!.payload).toBe(HSTORE_UNCHECKED);
  });
});

describe("PR 4226 review fixes (Grok)", () => {
  const cat: CatalogLike = {
    tables: [
      {
        name: "events",
        columns: [
          { name: "id", type: "integer" },
          { name: "attrs", type: "hstore", json_sampled: "full", json_keys: ["plan"] },
          { name: "contact", type: "jsonb", json_sampled: "full", json_keys: ["email", "profile", "profile.phone", "zone"] },
          { name: "payload", type: "jsonb", json_sampled: "full", json_keys: ["zone"] },
          { name: "who", type: "composite (person_t)", json_sampled: "full", json_keys: ["label"] },
        ],
      },
    ],
  };
  const p = effectivePolicy({ auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] }, cat, "postgres");
  const g = (sql: string) => guardSql(sql, { policy: p, dialect: "postgres" });

  it("B: literal key paths to a sampled sensitive key of a visible JSON column are refused", () => {
    for (const sql of [
      "SELECT contact->>'email' FROM events",
      "SELECT contact -> 'profile' ->> 'phone' FROM events",
      "SELECT contact #>> '{profile,phone}' FROM events",
      "SELECT jsonb_extract_path_text(contact, 'email') FROM events",
      "SELECT e.contact->>'email' FROM events e",
    ]) {
      expect(reason(g(sql)), sql).toMatch(/sensitive key/);
    }
    for (const sql of ["SELECT contact->>'zone' FROM events", "SELECT contact -> 'profile' ->> 'city' FROM events", "SELECT payload->>'email' FROM events"]) {
      expect(g(sql).ok, sql).toBe(true);
    }
    const my = effectivePolicy({ auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] }, { tables: [{ name: "events", columns: [{ name: "contact", type: "json", json_sampled: "full", json_keys: ["email"] }] }] }, "mysql");
    expect(reason(guardSql("SELECT json_extract(contact, '$.email') FROM events", { policy: my, dialect: "mysql" }))).toMatch(/sensitive key/);
    expect(guardSql("SELECT json_extract(contact, '$.zone') FROM events", { policy: my, dialect: "mysql" }).ok).toBe(true);
  });
});

describe("PR 4226 delta: checks follow aliases, parentheses and ARRAY paths", () => {
  const cat: CatalogLike = {
    tables: [
      {
        name: "events",
        columns: [
          { name: "id", type: "integer" },
          { name: "attrs", type: "hstore", json_sampled: "full", json_keys: ["plan"] },
          { name: "contact", type: "jsonb", json_sampled: "full", json_keys: ["email", "zone"] },
          { name: "payload", type: "jsonb", json_sampled: "full", json_keys: ["zone"] },
          { name: "who", type: "composite (person_t)", json_sampled: "full", json_keys: ["label"] },
          { name: "amount", type: "numeric" },
        ],
      },
    ],
  };
  const p = effectivePolicy({ auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] }, cat, "postgres");
  const g = (sql: string) => guardSql(sql, { policy: p, dialect: "postgres" });

  it("parenthesized, cast and ARRAY / non-literal paths are checked", () => {
    for (const sql of [
      "SELECT (contact)->>'email' FROM events",
      "SELECT (e.contact)->>'email' FROM events e",
      "SELECT contact::jsonb->>'email' FROM events",
      "SELECT contact #>> ARRAY['email'] FROM events",
      "SELECT contact #>> '{email}' FROM events",
      "SELECT contact->>lower('EMAIL') FROM events",
      "SELECT contact #>> ARRAY[lower('x')] FROM events",
      "SELECT jsonb_extract_path_text(contact, lower('EMAIL')) FROM events",
    ]) {
      expect(g(sql).ok, sql).toBe(false);
    }
  });

});
