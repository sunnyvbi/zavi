import { describe, it, expect } from "vitest";
import {
  effectivePolicy,
  guardSql,
  policyFromRules,
  stripJsonInRows,
  type CatalogLike,
  type PolicyRow,
} from "@zavi/shared/db-guard";

const base: PolicyRow = { auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] };

const partCat: CatalogLike = {
  tables: [
    { name: "orders", columns: [{ name: "id" }, { name: "internal_note" }, { name: "total" }], partitioned: true, partitions: ["orders_2024", "orders_2025"] },
    { name: "orders_2024", columns: [{ name: "id" }, { name: "internal_note" }, { name: "total" }] },
    { name: "orders_2025", columns: [{ name: "id" }, { name: "internal_note" }, { name: "total" }] },
    { name: "plans", columns: [{ name: "id" }, { name: "name" }] },
  ],
};
const pg = (sql: string, policy: ReturnType<typeof effectivePolicy>) => guardSql(sql, { policy, dialect: "postgres" });
const reason = (r: ReturnType<typeof guardSql>) => (r.ok ? "" : r.reason);

describe("partitions inherit their parent (must-catch)", () => {
  it("a partition of a switched-off parent is not readable, and the refusal does not name it", () => {
    const p = effectivePolicy({ ...base, disabled_tables: ["orders"] }, partCat, "postgres");
    expect(p.isAllowed("orders_2024")).toBe(false);
    const r = pg("SELECT * FROM orders_2024", p);
    expect(r.ok).toBe(false);
    expect(reason(r)).not.toMatch(/orders_2025/);
  });
  it("a partition carries the parent's hidden fields: SELECT * drops them, naming one is refused", () => {
    const p = effectivePolicy({ ...base, hidden_fields: ["orders.internal_note"] }, partCat, "postgres");
    expect(p.isHidden("orders_2024", "internal_note")).toBe(true);
    const star = pg("SELECT * FROM orders_2024", p);
    expect(star.ok && star.sql).toBe('SELECT * FROM (SELECT "id", "total" FROM ONLY "public"."orders_2024") AS "orders_2024"');
    expect(reason(pg("SELECT internal_note FROM orders_2024", p))).toMatch(/hidden/);
  });
  it("a stricter hide on the child is kept", () => {
    const p = effectivePolicy({ ...base, hidden_fields: ["orders.internal_note", "orders_2025.total"] }, partCat, "postgres");
    expect(p.hiddenFields("orders_2025").map((h) => h.toLowerCase()).sort()).toEqual(["internal_note", "total"]);
  });
  it("connector rules: a partition in the allow-list of a parent that is not allowed stays denied, blocked fields copy down", () => {
    const denied = policyFromRules({ allowed: ["orders_2024"], blocked: [], what_can_leave: "rows_without_blocked_columns", max_rows: 100 }, partCat, "postgres");
    expect(denied.isAllowed("orders_2024")).toBe(false);
    const blocked = policyFromRules({ allowed: ["orders", "orders_2024", "orders_2025"], blocked: ["orders.internal_note"], what_can_leave: "rows_without_blocked_columns", max_rows: 100 }, partCat, "postgres");
    expect(blocked.isHidden("orders_2024", "internal_note")).toBe(true);
  });
  it("reading the parent with a switched-off partition is refused without naming the partition", () => {
    const p = effectivePolicy({ ...base, disabled_tables: ["orders_2024"] }, partCat, "postgres");
    const r = pg("SELECT count(*) FROM orders", p);
    expect(reason(r)).toMatch(/one of its partitions is not readable/);
    expect(reason(r)).not.toMatch(/orders_2024/);
  });
});

describe("partitions (must-not-catch)", () => {
  it("an allowed parent with no hides leaves its partitions readable as they were", () => {
    const p = effectivePolicy(base, partCat, "postgres");
    const r = pg("SELECT id, internal_note FROM orders_2024", p);
    expect(r.ok).toBe(true);
    expect(pg("SELECT count(*) FROM orders", p).ok).toBe(true);
  });
});

const jsonCat: CatalogLike = {
  tables: [
    {
      name: "events",
      columns: [
        { name: "id", type: "integer" },
        { name: "payload", type: "jsonb", json_keys: ["city", "plan", "items"], json_sampled: "full" },
        { name: "contact", type: "jsonb", json_keys: ["city", "email", "profile.phone"], json_sampled: "full" },
        { name: "tags", type: "ARRAY" },
        { name: "note", type: "text" },
      ],
    },
    { name: "users", columns: [{ name: "id" }, { name: "email" }, { name: "plan" }] },
  ],
};
const jsonPolicy = (row: Partial<PolicyRow> = {}, dialect: "postgres" | "mysql" = "postgres") =>
  effectivePolicy({ ...base, auto_hide: true, hidden_fields: ["users.email"], ...row }, jsonCat, dialect);
const my = (sql: string, row: Partial<PolicyRow> = {}) => guardSql(sql, { policy: jsonPolicy(row, "mysql"), dialect: "mysql", mysqlDatabase: "shop" });

describe("JSON columns at the column level", () => {
  it("a JSON column whose sampled keys include email is hidden by default; plain JSON stays visible", () => {
    const p = jsonPolicy();
    expect(p.isHidden("events", "contact")).toBe(true);
    expect(p.isHidden("events", "payload")).toBe(false);
    expect(pg("SELECT contact FROM events", p).ok).toBe(false);
    const star = pg("SELECT * FROM events", p);
    expect(star.ok && star.sql).not.toContain('"contact"');
  });
  it("un-hiding the whole column allows it: a direct select is passed whole", () => {
    const p = jsonPolicy({ unhidden_fields: ["events.contact"] });
    expect(p.isHidden("events", "contact")).toBe(false);
    const g = pg("SELECT id, contact FROM events", p);
    expect(g.ok && g.passthrough).toEqual(["contact"]);
    const rows = stripJsonInRows([{ id: 1, contact: { email: "a@b.c", city: "SF" } }], { policy: p, tables: ["events"], hidden: [], passthrough: g.ok ? g.passthrough : [], fieldNames: ["id", "contact"] });
    expect(rows[0]).toEqual({ id: 1, contact: { email: "a@b.c", city: "SF" } });
  });
  it("a JSON key that names a hidden field hides the column too", () => {
    const p = jsonPolicy({ hidden_fields: ["users.email", "users.plan"] });
    expect(p.isHidden("events", "payload")).toBe(true);
  });
});

describe("visible JSON column: allowlist only, no key parsing", () => {
  it.each([
    ["jsonb_each_text", "SELECT * FROM events, jsonb_each_text(payload)"],
    ["jsonb_each_text in select", "SELECT jsonb_each_text(payload) FROM events"],
    ["jsonb_object_keys", "SELECT jsonb_object_keys(payload) FROM events"],
    ["jsonb_path_query", "SELECT jsonb_path_query(payload, '$.city') FROM events"],
    ["jsonb_populate_record", "SELECT jsonb_populate_record(null::events, payload) FROM events"],
    ["jsonb_to_record", "SELECT * FROM jsonb_to_record((SELECT payload FROM events LIMIT 1)) AS x(city text)"],
    ["subscript with a key", "SELECT payload['city'] FROM events"],
    ["subscript with an index on JSON", "SELECT payload[0] FROM events"],
    ["@? jsonpath", "SELECT id FROM events WHERE payload @? '$.city'"],
    ["@@ jsonpath", "SELECT id FROM events WHERE payload @@ '$.city == 1'"],
    ["#- delete", "SELECT payload #- '{city}' FROM events"],
  ])("Postgres %s is refused", (_l, sql) => {
    expect(pg(sql, jsonPolicy()).ok).toBe(false);
  });
  it.each([
    ["JSON_TABLE", "SELECT * FROM events, JSON_TABLE(payload, '$' COLUMNS (city VARCHAR(100) PATH '$.city')) jt"],
    ["JSON_VALUE", "SELECT JSON_VALUE(payload, '$.city') FROM events"],
    ["JSON_SEARCH", "SELECT JSON_SEARCH(payload, 'one', 'x') FROM events"],
    ["JSON_KEYS", "SELECT JSON_KEYS(payload) FROM events"],
  ])("MySQL %s is refused (not on the allowlist)", (_l, sql) => {
    expect(my(sql).ok).toBe(false);
  });
  it.each([
    ["->> a plain key", "SELECT payload->>'city' FROM events"],
    ["->> a key that looks sensitive (accepted residual: the guard does not parse keys)", "SELECT payload->>'email' FROM events"],
    ["-> an array index", "SELECT payload->'items'->0->>'sku' FROM events"],
    ["#>> a path", "SELECT payload #>> '{items,0,sku}' FROM events"],
    ["extract-path function", "SELECT jsonb_extract_path_text(payload, 'items', 'sku') FROM events"],
    ["jsonb_typeof", "SELECT jsonb_typeof(payload) FROM events"],
    ["jsonb_array_length", "SELECT jsonb_array_length(payload->'items') FROM events"],
    ["array subscript and constructor", "SELECT tags[1] FROM events WHERE id = ANY(ARRAY[1, 2])"],
  ])("Postgres %s passes", (_l, sql) => {
    expect(pg(sql, jsonPolicy()).ok).toBe(true);
  });
  it("MySQL json_extract / ->> pass", () => {
    expect(my("SELECT json_extract(payload, '$.city'), payload->>'$.email' FROM events").ok).toBe(true);
  });
  it("->>'email' returns a scalar (not stripped); ->'profile' returns JSON and its sensitive key is stripped", () => {
    const p = jsonPolicy();
    const rows = stripJsonInRows([{ e: "a@b.c", profile: { email: "a@b.c", city: "SF" } }], { policy: p, tables: ["events"], hidden: [] });
    expect(rows[0]).toEqual({ e: "a@b.c", profile: { city: "SF" } });
  });
});

describe("JSON keys in SQL results (backstop)", () => {
  const ctx = (row: Partial<PolicyRow> = {}) => ({ policy: jsonPolicy(row), tables: ["events", "users"], hidden: [] as string[] });
  it("must-catch: a jsonb value loses sensitive and hidden-name keys at any depth", () => {
    const rows = stripJsonInRows([{ id: 1, payload: { plan: "pro", email: "a@b.c", profile: { phone: "555", city: "SF" } } }], ctx());
    expect(rows[0]).toEqual({ id: 1, payload: { plan: "pro", profile: { city: "SF" } } });
  });
  it("must-catch: JSON text is parsed, stripped and re-serialized", () => {
    const rows = stripJsonInRows([{ payload: '{"plan":"pro","email":"a@b.c"}' }], ctx());
    expect(JSON.parse(rows[0]!.payload as string)).toEqual({ plan: "pro" });
  });
  it("must-catch: truncated JSON text has the blocked value blanked", () => {
    const rows = stripJsonInRows([{ snippet: '{"plan":"pro","email":"a@b.c","na' }], ctx());
    expect(rows[0]!.snippet).not.toContain("a@b.c");
    expect(rows[0]!.snippet).toContain('"plan":"pro"');
  });
  it("must-not-catch: plain keys, plain strings and numbers are untouched (same object)", () => {
    const input = [{ id: 1, note: "hello", payload: { plan: "pro", items: [{ sku: "A" }] } }];
    expect(stripJsonInRows(input, ctx())[0]).toBe(input[0]);
  });
  it("there are no per-key un-hides: a nested un-hide entry does not keep a key", () => {
    const rows = stripJsonInRows([{ payload: { email: "a@b.c" } }], ctx({ unhidden_fields: ["events.payload.email"] }));
    expect(rows[0]).toEqual({ payload: {} });
  });
});

describe("JSON key sampling (values never leave)", () => {
  it("builds key paths from sampler rows and a values-free statement", async () => {
    const { jsonKeysFromRows, pgJsonKeySampleSql, sampleJsonKeys } = await import("@zavi/shared/db-guard");
    expect(jsonKeysFromRows([{ k1: "profile", k2: "email" }, { k1: "city", k2: null }, { ks: '["a","b"]' }])).toEqual(["a", "b", "city", "profile", "profile.email"]);
    const sql = pgJsonKeySampleSql("events", "payload");
    expect(sql).toMatch(/jsonb_each/);
    expect(sql).not.toMatch(/v1\s*(AS|,)|SELECT DISTINCT e1\.v1/);
    const tables = [{ name: "events", columns: [{ name: "payload", type: "jsonb" } as { name: string; type: string; json_keys?: string[] }, { name: "id", type: "integer" }] }];
    const ran: string[] = [];
    await sampleJsonKeys("postgres", tables, async (q) => {
      ran.push(q);
      if (q.includes("count(*)")) return [{ n: 3, objs: 3, obj_arrays: 0 }];
      return q.startsWith("SELECT") ? [{ k1: "email", k2: null }] : [];
    }, { deadlineAt: Date.now() + 5000 });
    expect(tables[0]!.columns[0]!.json_keys).toEqual(["email"]);
    expect(ran.filter((q) => q.startsWith("SELECT"))).toHaveLength(2);
    expect(ran).toContain("SAVEPOINT zavi_json_keys");
  });
});

describe("JSON key sampling fails closed and never stores value-like key names", () => {
  type Col = { name: string; type: string; json_keys?: string[]; json_sampled?: "full" | "partial" | "none"; json_map_like?: boolean };
  const run = (shape: Record<string, unknown>, keys: Record<string, unknown>[]) => async (q: string) =>
    q.includes("count(*)") || q.includes("COUNT(*)") ? [shape] : q.startsWith("SELECT") ? keys : [];
  const one = async (shape: Record<string, unknown>, keys: Record<string, unknown>[], dialect: "postgres" | "mysql" = "postgres") => {
    const { sampleJsonKeys } = await import("@zavi/shared/db-guard");
    const col: Col = { name: "payload", type: dialect === "mysql" ? "json" : "jsonb" };
    await sampleJsonKeys(dialect, [{ name: "events", columns: [col] }], run(shape, keys), { deadlineAt: Date.now() + 5000 });
    return col;
  };
  const hidden = (col: Col) => effectivePolicy({ ...base, auto_hide: true }, { tables: [{ name: "events", columns: [{ name: "id" }, col] }] }, "postgres").isHidden("events", "payload");

  it("all-null rows: none -> hidden (couldn't check)", async () => {
    const c = await one({ n: 0, objs: 0, obj_arrays: 0 }, []);
    expect(c.json_sampled).toBe("none");
    expect(hidden(c)).toBe(true);
  });
  it("scalar values sampled (a JSON string can be an email): partial -> hidden", async () => {
    const c = await one({ n: 5, objs: 3, obj_arrays: 0 }, [{ k1: "plan", k2: null }]);
    expect(c.json_sampled).toBe("partial");
    expect(hidden(c)).toBe(true);
  });
  it("a sample that fails: none -> hidden, nothing stored", async () => {
    const { sampleJsonKeys } = await import("@zavi/shared/db-guard");
    const col: Col = { name: "payload", type: "jsonb" };
    await sampleJsonKeys("postgres", [{ name: "events", columns: [col] }], async (q) => {
      if (q.startsWith("SELECT")) throw new Error("permission denied");
      return [];
    }, { deadlineAt: Date.now() + 5000 });
    expect(col.json_sampled).toBe("none");
    expect(col.json_keys).toBeUndefined();
    expect(hidden(col)).toBe(true);
  });
  it("past the deadline: none -> hidden", async () => {
    const { sampleJsonKeys } = await import("@zavi/shared/db-guard");
    const col: Col = { name: "payload", type: "jsonb" };
    await sampleJsonKeys("postgres", [{ name: "events", columns: [col] }], async () => [], { deadlineAt: Date.now() - 1 });
    expect(col.json_sampled).toBe("none");
    expect(hidden(col)).toBe(true);
  });
  it("an old catalog JSON column with no sample record is hidden", () => {
    expect(hidden({ name: "payload", type: "jsonb" })).toBe(true);
  });
  it("value-like key names are never stored and mark the column map-like -> hidden", async () => {
    const c = await one({ n: 3, objs: 3, obj_arrays: 0 }, [
      { k1: "a@b.com", k2: null },
      { k1: "+14155550123", k2: null },
      { k1: "8f14e45f-ceea-467a-9b7a-0a1b2c3d4e5f", k2: null },
      { k1: "plan", k2: null },
    ]);
    expect(c.json_keys).toEqual(["plan"]);
    expect(JSON.stringify(c)).not.toContain("a@b.com");
    expect(c.json_map_like).toBe(true);
    expect(hidden(c)).toBe(true);
  });
  it("more distinct keys than the cap: map-like -> hidden", async () => {
    const keys = Array.from({ length: 401 }, (_, i) => ({ k1: `k${i}x`, k2: null }));
    const c = await one({ n: 3, objs: 3, obj_arrays: 0 }, keys);
    expect(c.json_map_like).toBe(true);
    expect(hidden(c)).toBe(true);
  });
  it("must-not-catch: a fully sampled plain object column stays visible", async () => {
    const c = await one({ n: 3, objs: 3, obj_arrays: 0 }, [{ k1: "plan", k2: null }, { k1: "items", k2: "sku" }]);
    expect(c.json_sampled).toBe("full");
    expect(hidden(c)).toBe(false);
  });
  it("MySQL reads one level down; an unsafe top key name leaves it partial -> hidden", async () => {
    const { sampleJsonKeys } = await import("@zavi/shared/db-guard");
    const col: Col = { name: "payload", type: "json" };
    const ran: string[] = [];
    await sampleJsonKeys("mysql", [{ name: "events", columns: [col] }], async (q) => {
      ran.push(q);
      if (q.includes("COUNT(*)")) return [{ n: 2, objs: 2, obj_arrays: 0 }];
      if (q.includes(`'$."profile"'`)) return [{ ks: '["email"]' }];
      if (q.includes(`'$."`)) return [];
      return [{ ks: '["profile","plan"]' }];
    }, { deadlineAt: Date.now() + 5000, database: "shop" });
    expect(col.json_keys).toEqual(["plan", "profile", "profile.email"]);
    expect(col.json_sampled).toBe("full");
    expect(hidden(col)).toBe(true);
    const col2: Col = { name: "payload", type: "json" };
    await sampleJsonKeys("mysql", [{ name: "events", columns: [col2] }], async (q) => {
      if (q.includes("COUNT(*)")) return [{ n: 2, objs: 2, obj_arrays: 0 }];
      return q.includes("$.") ? [] : [{ ks: '["plan","we.ird"]' }];
    }, { deadlineAt: Date.now() + 5000, database: "shop" });
    expect(col2.json_sampled).toBe("partial");
    expect(hidden(col2)).toBe(true);
  });
  it("the reason says why", async () => {
    const { sensitiveColumnKind } = await import("@zavi/shared/db-guard");
    expect(sensitiveColumnKind("events", { name: "payload", type: "jsonb", json_sampled: "none" })).toBe("Zavi couldn't check what's inside");
    expect(sensitiveColumnKind("events", { name: "payload", type: "jsonb", json_sampled: "full", json_map_like: true })).toBe("Keys look like customer data");
    expect(sensitiveColumnKind("events", { name: "payload", type: "jsonb", json_sampled: "full", json_keys: ["email", "phone"] })).toBe("Contains email, phone");
  });
});

describe("whole-column un-hide passes only a direct, unaliased reference", () => {
  const p = () => jsonPolicy({ unhidden_fields: ["events.contact"] });
  const strip = (sql: string, row: Record<string, unknown>, fieldNames?: string[]) => {
    const g = pg(sql, p());
    if (!g.ok) throw new Error(g.reason);
    return stripJsonInRows([row], { policy: p(), tables: g.tables, hidden: g.hidden, passthrough: g.passthrough, fieldNames: fieldNames ?? Object.keys(row) });
  };
  it("an aliased copy of another column under the un-hidden name is stripped (or refused when it collides)", () => {
    expect(strip("SELECT payload AS contact FROM events", { contact: { email: "a@b.c" } })[0]).toEqual({ contact: {} });
    expect(strip("SELECT contact AS contact2 FROM events", { contact2: { email: "a@b.c" } })[0]).toEqual({ contact2: {} });
    expect(pg("SELECT contact, payload AS contact FROM events", p()).ok).toBe(false);
    expect(pg("SELECT contact, contact FROM events", p()).ok).toBe(false);
  });
  it("an expression over the un-hidden column, or an implicit alias, is stripped", () => {
    expect(strip("SELECT coalesce(contact, payload) AS contact FROM events", { contact: { email: "a@b.c" } })[0]).toEqual({ contact: {} });
    expect(strip("SELECT contact::jsonb FROM events", { contact: { email: "a@b.c" } })[0]).toEqual({ contact: {} });
  });
  it("a select list with *, or a set operation, gets no passthrough", () => {
    const g1 = pg("SELECT *, contact FROM events", p());
    expect(g1.ok && g1.passthrough).toEqual([]);
    const g2 = pg("SELECT contact FROM events UNION SELECT payload FROM events", p());
    expect(g2.ok).toBe(false);
  });
  it("a driver result with duplicate names voids every passthrough", () => {
    expect(strip("SELECT contact FROM events", { contact: { email: "a@b.c" } }, ["contact", "contact"])[0]).toEqual({ contact: {} });
  });
  it("other JSON values in the same row are still stripped", () => {
    expect(strip("SELECT contact, payload FROM events", { contact: { email: "a@b.c" }, payload: { email: "x@y.z" } })[0]).toEqual({ contact: { email: "a@b.c" }, payload: {} });
  });
  it("a column un-hidden in one table but not another referenced table that has it gets no passthrough", () => {
    const cat: CatalogLike = {
      tables: [
        { name: "a", columns: [{ name: "id" }, { name: "contact", type: "jsonb", json_sampled: "full", json_keys: ["city"] }] },
        { name: "b", columns: [{ name: "id" }, { name: "contact", type: "jsonb", json_sampled: "full", json_keys: ["city"] }] },
      ],
    };
    const pol = effectivePolicy({ ...base, auto_hide: true, unhidden_fields: ["a.contact"] }, cat, "postgres");
    const g = pg("SELECT b.contact FROM a JOIN b ON a.id = b.id", pol);
    expect(g.ok && g.passthrough).toEqual([]);
  });
});

describe("review of 79cd61dd9f", () => {
  it("must-catch: a hidden JSON column stays unreadable through casts and text functions", () => {
    const p = jsonPolicy();
    for (const sql of [
      "SELECT contact::text FROM events",
      "SELECT substring(contact::text, 1, 50) FROM events",
      "SELECT position('@' in contact::text) FROM events",
      "SELECT e.contact->>'city' FROM events e",
      "SELECT id FROM events WHERE contact::text LIKE '%@%'",
    ]) expect(pg(sql, p).ok, sql).toBe(false);
  });
  it("accepted residual: a VISIBLE JSON column can be cast and sliced like any visible column", () => {
    expect(pg("SELECT substring(payload::text, 1, 50), position('a' in payload::text) FROM events", jsonPolicy()).ok).toBe(true);
  });
  it("must-catch: a subquery cannot put another value under the un-hidden column's name (no passthrough)", () => {
    const p = jsonPolicy({ unhidden_fields: ["events.contact"] });
    const g = pg("SELECT contact FROM (SELECT payload AS contact FROM events) s", p);
    expect(g.ok).toBe(false);
    const rows = stripJsonInRows([{ contact: { email: "a@b.c" } }], { policy: p, tables: ["events"], hidden: [], passthrough: [], fieldNames: ["contact"] });
    expect(rows[0]).toEqual({ contact: {} });
  });
  it("must-not-catch: array type casts still pass (control regression)", () => {
    const p = jsonPolicy();
    expect(pg("SELECT id FROM events WHERE id = ANY('{1,2}'::int[])", p).ok).toBe(true);
    expect(pg("SELECT CAST(tags AS text[]) FROM events", p).ok).toBe(true);
    expect(pg("SELECT '{}'::text[][] FROM events", p).ok).toBe(true);
  });
});
