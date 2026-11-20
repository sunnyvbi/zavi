import { describe, it, expect } from "vitest";
import { guardSql, effectivePolicy, stripHiddenColumns, type CatalogLike, type PolicyRow } from "@zavi/shared/db-guard";

const catalog: CatalogLike = {
  tables: [
    { name: "users", columns: [{ name: "id" }, { name: "email" }, { name: "role" }, { name: "account_id" }] },
    { name: "customers", columns: [{ name: "id" }, { name: "email" }, { name: "plan" }] },
    { name: "bookings", columns: [{ name: "id" }, { name: "user_id" }, { name: "city" }, { name: "created_at" }, { name: "status" }] },
    { name: "audit_secret", columns: [{ name: "id" }] },
  ],
};
const base: PolicyRow = { auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] };
const hideEmail = effectivePolicy({ ...base, hidden_fields: ["users.email"], disabled_tables: ["audit_secret"] }, catalog, "postgres");
const legacy = effectivePolicy(base, catalog, "postgres");
const pg = (sql: string, policy = hideEmail) => guardSql(sql, { policy, dialect: "postgres" });
const my = (sql: string, policy = effectivePolicy({ ...base, hidden_fields: ["users.email"] }, catalog, "mysql"), mysqlDatabase: string | null = "shop") =>
  guardSql(sql, { policy, dialect: "mysql", mysqlDatabase });

const refused = (r: ReturnType<typeof guardSql>) => {
  expect(r.ok).toBe(false);
  return r.ok ? "" : r.reason;
};

describe("guardSql must-catch", () => {
  it.each([
    ["hidden column by name", "SELECT email FROM users"],
    ["under an alias", "SELECT u.email FROM users u"],
    ["quoted", 'SELECT "email" FROM users'],
    ["in JOIN ON", "SELECT u.id FROM users u JOIN customers c ON u.email = c.email"],
    ["in USING", "SELECT id FROM users JOIN customers USING (email)"],
    ["in WHERE", "SELECT id FROM users WHERE email LIKE '%x%'"],
    ["in GROUP BY", "SELECT count(*) FROM users GROUP BY email"],
    ["in a subquery", "SELECT id FROM bookings WHERE user_id IN (SELECT id FROM users WHERE email IS NOT NULL)"],
    ["in a function argument", "SELECT lower(email) FROM users"],
    ["through a user CTE", "WITH x AS (SELECT * FROM users) SELECT email FROM x"],
  ])("hidden field: %s", (_n, sql) => {
    expect(refused(pg(sql))).toMatch(/users\.email is hidden/);
  });

  it.each([
    ["switched-off table", "SELECT id FROM audit_secret"],
    ["table missing from the catalog", "SELECT * FROM audit_logs"],
    ["a view not in the catalog", "SELECT * FROM v_user_emails"],
    ["other schema", "SELECT * FROM public.secret_table"],
    ["pg_catalog", "SELECT * FROM pg_catalog.pg_shadow"],
    ["information_schema", "SELECT column_name FROM information_schema.columns"],
    ["cross database", "SELECT * FROM otherdb.public.users"],
    ["non-public schema of a catalog table", "SELECT * FROM app.users"],
    ["after ON in a comma list", "SELECT * FROM users u JOIN bookings b ON true, audit_logs"],
    ["parenthesized join", "SELECT * FROM (audit_logs JOIN users ON true)"],
    ["TABLE in a CTE", "WITH x AS (TABLE audit_logs) SELECT * FROM x"],
    ["non-recursive CTE body reading its own name", "WITH audit_logs AS (SELECT * FROM audit_logs) SELECT * FROM audit_logs"],
    ["CTE used outside its scope", "SELECT * FROM (WITH audit_logs AS (SELECT 1) SELECT * FROM audit_logs) a, audit_logs"],
    ["lateral subquery", "SELECT * FROM users, LATERAL (SELECT * FROM audit_logs) x"],
  ])("relation: %s", (_n, sql) => {
    expect(refused(pg(sql))).toMatch(/not a table Zavi may read/);
  });

  it("quoted identifier does not fold: \"Users\" is not users", () => {
    expect(refused(pg('SELECT id FROM "Users"'))).toMatch(/not a table/);
  });
  it("functions", () => {
    expect(refused(pg("SELECT pg_read_file('/etc/passwd')"))).toMatch(/pg_read_file\(\) is not allowed/);
    expect(refused(pg("SELECT * FROM generate_series(1,10)"))).toMatch(/in FROM is not allowed/);
    expect(refused(pg("SELECT pg_catalog.count(*) FROM users"))).toMatch(/not allowed/);
    expect(refused(my("SELECT LOAD_FILE('/etc/passwd')"))).toMatch(/not allowed/);
  });
  it("a call inside type arguments is still checked", () => {
    expect(refused(pg("SELECT id::varchar(pg_read_file('/x')) FROM bookings"))).toMatch(/pg_read_file\(\) is not allowed/);
  });
  it("a hidden column named like a non-reserved keyword", () => {
    const p = effectivePolicy({ ...base, hidden_fields: ["bookings.last"] }, { tables: [{ name: "bookings", columns: [{ name: "id" }, { name: "last" }] }] }, "postgres");
    expect(refused(pg("SELECT last FROM bookings", p))).toMatch(/bookings\.last is hidden/);
  });
  it("scalar subquery inside a function argument is checked", () => {
    expect(refused(pg("SELECT coalesce((SELECT id FROM audit_logs LIMIT 1), 0)"))).toMatch(/not a table/);
  });
  it("unknown qualifier", () => {
    expect(refused(pg("SELECT x.id FROM users u"))).toMatch(/not a table or alias/);
  });
  it("MySQL database-qualified name", () => {
    expect(refused(my("SELECT id FROM appdb.users"))).toMatch(/without a database prefix/);
  });
});

const USERS = '(SELECT "id", "role", "account_id" FROM ONLY "public"."users")';

describe("guardSql rewrite: every relation becomes a projection of its visible catalog columns", () => {
  it("SELECT * FROM users", () => {
    const r = pg("SELECT * FROM users");
    expect(r.ok && r.sql).toBe(`SELECT * FROM ${USERS} AS "users"`);
    expect(r.ok && r.hidden).toEqual(["email"]);
    expect(r.ok && r.tables).toEqual(["users"]);
  });
  it("public.users and a written ONLY are folded into the qualified source; an alias is kept", () => {
    expect((pg("SELECT * FROM public.users") as { sql: string }).sql).toBe(`SELECT * FROM ${USERS} AS "users"`);
    expect((pg("SELECT u.id FROM ONLY users u") as { sql: string }).sql).toBe(`SELECT u.id FROM ${USERS} u`);
    expect((pg("SELECT u.id FROM users AS u") as { sql: string }).sql).toBe(`SELECT u.id FROM ${USERS} AS u`);
  });
  it.each(["SELECT u::text FROM users u", "SELECT row_to_json(u) FROM users u", "SELECT concat(u.*) FROM users u", "SELECT json_agg(u) FROM users u"])(
    "whole-row form reads the projection: %s",
    (sql) => {
      const r = pg(sql);
      expect(r.ok && r.sql).toContain(`FROM ${USERS} u`);
    },
  );
  it("tables without hidden fields are projected too (a column added after discovery is invisible)", () => {
    const r = pg("SELECT city FROM bookings");
    expect(r.ok && r.sql).toBe('SELECT city FROM (SELECT "id", "user_id", "city", "created_at", "status" FROM ONLY "public"."bookings") AS "bookings"');
  });
  it("relations inside CTEs, subqueries and joins are all rewritten; user CTE names are not", () => {
    const r = pg("WITH b AS (SELECT * FROM bookings) SELECT * FROM users JOIN b ON b.user_id = users.id");
    expect(r.ok && r.sql).toBe(
      `WITH b AS (SELECT * FROM (SELECT "id", "user_id", "city", "created_at", "status" FROM ONLY "public"."bookings") AS "bookings") SELECT * FROM ${USERS} AS "users" JOIN b ON b.user_id = users.id`,
    );
    const rec = pg("WITH RECURSIVE n AS (SELECT 1 AS k UNION ALL SELECT k + 1 FROM n WHERE k < 3) SELECT * FROM users, n");
    expect(rec.ok && rec.sql).toContain(`FROM ${USERS} AS "users", n`);
  });
  it("MySQL qualifies with the connected database", () => {
    const r = my("SELECT * FROM users");
    expect(r.ok && r.sql).toBe("SELECT * FROM (SELECT `id`, `role`, `account_id` FROM `shop`.`users`) AS `users`");
  });
  it("auto_hide policy hides detected columns", () => {
    const p = effectivePolicy({ ...base, auto_hide: true }, catalog, "postgres");
    expect(refused(pg("SELECT email FROM customers", p))).toMatch(/customers\.email is hidden/);
  });
});

describe("guardSql: Codex review scenarios", () => {
  it("a statement can only reach the schema-qualified catalog table (search_path cannot redirect it)", () => {
    const r = pg("SELECT * FROM users");
    expect(r.ok && r.sql).not.toMatch(/FROM users\b/);
    expect(refused(pg("SELECT * FROM private.users"))).toMatch(/not a table/);
  });
  it("a new email column outside the catalog is not selectable through the projection", () => {
    const legacyNoEmail = effectivePolicy(base, { tables: [{ name: "users", columns: [{ name: "id" }, { name: "role" }] }] }, "postgres");
    const r = pg("SELECT * FROM users", legacyNoEmail);
    expect(r.ok && r.sql).toBe('SELECT * FROM (SELECT "id", "role" FROM ONLY "public"."users") AS "users"');
  });
  it("INHERITS children never join in (ONLY); a partitioned parent needs every partition allowed", () => {
    expect((pg("SELECT id FROM users") as { sql: string }).sql).toContain('FROM ONLY "public"."users"');
    const partCat: CatalogLike = {
      tables: [
        { name: "events", columns: [{ name: "id" }, { name: "kind" }], partitioned: true, partitions: ["events_2025", "events_2026"] },
        { name: "events_2025", columns: [{ name: "id" }, { name: "kind" }] },
        { name: "events_2026", columns: [{ name: "id" }, { name: "kind" }] },
      ],
    };
    const ok = pg("SELECT count(*) FROM events", effectivePolicy(base, partCat, "postgres"));
    expect(ok.ok && ok.sql).toContain('FROM "public"."events")');
    expect(refused(pg("SELECT count(*) FROM events", effectivePolicy({ ...base, disabled_tables: ["events_2025"] }, partCat, "postgres")))).toMatch(/one of its partitions is not readable/);
    expect(refused(pg("SELECT count(*) FROM events", effectivePolicy({ ...base, disabled_tables: ["events_2025"] }, partCat, "postgres")))).not.toMatch(/events_2025/);
    expect(refused(pg("SELECT count(*) FROM events", effectivePolicy({ ...base, hidden_fields: ["events_2026.kind"] }, partCat, "postgres")))).toMatch(/hides more fields/);
  });
  it("casts to non-built-in types and schema-qualified types are refused", () => {
    expect(refused(pg("SELECT id::public.leaktext FROM users"))).toMatch(/Casting to public\.leaktext/);
    expect(refused(pg("SELECT id::leaktext FROM users"))).toMatch(/Casting to leaktext/);
    expect(refused(pg("SELECT CAST(id AS leaktext) FROM users"))).toMatch(/Casting to leaktext/);
    expect(refused(pg("SELECT 'users'::regclass"))).toMatch(/Casting to regclass/);
    expect(pg("SELECT id::text, created_at::date, CAST(id AS double precision) FROM bookings").ok).toBe(true);
  });
  it("custom operators and OPERATOR() are refused; standard ones pass", () => {
    expect(refused(pg("SELECT id FROM users WHERE id ### 1"))).toMatch(/operator ###/);
    expect(refused(pg("SELECT id FROM users WHERE id OPERATOR(public.#) 1"))).toMatch(/not allowed/);
    expect(pg("SELECT id FROM bookings WHERE id >=-1 AND city <> 'x' AND status || 'a' = 'b'").ok).toBe(true);
  });
  it("lower(id) resolves only to pg_catalog (the session pins search_path); the guard still allows the built-in name", () => {
    expect(pg("SELECT lower(city) FROM bookings").ok).toBe(true);
  });
});

describe("guardSql must-not-catch", () => {
  it("an unprotected statement keeps its text around the rewritten relation", () => {
    const sql = "SELECT city, count(*) FROM bookings WHERE created_at > now() - interval '7 days' GROUP BY city";
    const r = pg(sql);
    expect(r.ok && r.sql).toBe(
      `SELECT city, count(*) FROM (SELECT "id", "user_id", "city", "created_at", "status" FROM ONLY "public"."bookings") AS "bookings" WHERE created_at > now() - interval '7 days' GROUP BY city`,
    );
  });
  it("'email' as a string literal is ignored", () => {
    const r = pg("SELECT id FROM bookings WHERE status = 'email'");
    expect(r.ok).toBe(true);
  });
  it("legacy policy (nothing hidden) still reads email through the projection", () => {
    const r = pg("SELECT email FROM users", legacy);
    expect(r.ok && r.sql).toBe('SELECT email FROM (SELECT "id", "email", "role", "account_id" FROM ONLY "public"."users") AS "users"');
  });
  it("FROM inside extract/substring/trim is not a relation", () => {
    expect(pg("SELECT extract(year FROM created_at), substring(city FROM 1 FOR 2), trim(both ' ' FROM city) FROM bookings").ok).toBe(true);
  });
  it("MySQL FROM dual and 1--1 arithmetic", () => {
    expect(my("SELECT 1 FROM dual").ok).toBe(true);
    expect(my("SELECT 1--1 AS n FROM bookings").ok).toBe(true);
  });
});

const realCatalog: CatalogLike = {
  tables: [
    "users", "groups", "group_members", "games", "invites", "events", "registrations", "products", "orders",
    "cake_orders", "menu_items", "site_settings", "opening_hours", "leads", "early_access_signups", "bookings",
    "teachers", "class_styles", "schedule_slots", "trips", "trip_modifications", "app_settings", "books", "moves",
  ].map((name) => ({ name, columns: [{ name: "id" }] })),
};
const real = effectivePolicy(base, realCatalog, "postgres");
const PASS = [
  "SELECT count(*) AS users_total, count(*) FILTER (WHERE created_at >= timestamptz 'X') AS users_since, count(*) FILTER (WHERE created_at >= now() - interval 'X') AS users_last_8d, min(created_at)::text AS first_user, max(created_at)::text AS last_user FROM users",
  "SELECT count(*) AS groups_total, count(*) FILTER (WHERE m.n >= 2) AS groups_2plus FROM groups g LEFT JOIN (SELECT group_id, count(DISTINCT user_id) AS n FROM group_members GROUP BY group_id) m ON m.group_id = g.id",
  "SELECT count(*) AS games_total, count(DISTINCT group_id) FILTER (WHERE finished_at IS NOT NULL) AS groups_with_finished, string_agg(DISTINCT mode, 'X') AS mode_values, max(created_at)::text AS last_game FROM games",
  "SELECT count(*) FILTER (WHERE is_sample = false AND lower(status) = 'X') AS real_published, count(DISTINCT organizer_id) AS organizers, max(created_at) AS last_event_created FROM events",
  "SELECT u.id, u.role::text AS role, u.created_at, (SELECT count(*) FROM events e WHERE e.organizer_id = u.id) AS events_created, (SELECT count(*) FROM registrations r WHERE r.user_id = u.id) AS regs FROM users u ORDER BY u.created_at",
  "SELECT is_sample, is_active, count(*) AS n, max(created_at) AS latest FROM products GROUP BY is_sample, is_active",
  "SELECT lower(status) AS status, lower(payment_status) AS payment_status, count(*) AS n FROM orders GROUP BY 1,2",
  "SELECT date_trunc('X', created_at AT TIME ZONE 'X') AS m, lower(status) AS status, count(*) AS n FROM cake_orders GROUP BY 1,2 ORDER BY 1,2",
  "SELECT count(*) AS total, count(*) FILTER (WHERE is_sample) AS samples, count(*) FILTER (WHERE category ILIKE 'X') AS cakes FROM menu_items",
  "SELECT * FROM site_settings LIMIT 5",
  "SELECT e.is_sample, count(r.*) AS regs, count(distinct r.user_id) AS registrants FROM registrations r JOIN events e ON e.id = r.event_id GROUP BY 1",
  "SELECT (SELECT count(*) FROM users) AS users_n, (SELECT count(*) FROM bookings) AS bookings_n, (SELECT count(*) FROM teachers) AS teachers_n, (SELECT count(*) FROM class_styles) AS styles_n, (SELECT count(*) FROM schedule_slots) AS slots_n, (SELECT count(*) FROM orders) AS orders_n",
  "SELECT (SELECT count(*) FROM (SELECT group_id FROM group_members GROUP BY group_id HAVING count(*)>=2) x) AS groups_2plus, (SELECT count(*) FROM moves) AS moves",
  "SELECT status::text AS status, count(*) AS n FROM leads GROUP BY status::text ORDER BY n DESC",
  "SELECT count(*) AS n FROM leads WHERE lower(coalesce(name,'X')) LIKE 'X' OR lower(coalesce(message,'X')) LIKE 'X'",
  "SELECT count(*) AS this_week FROM users WHERE created_at >= date_trunc('X', now())",
  "SELECT * FROM trips WHERE id = 18914 LIMIT 1",
  "SELECT * FROM trip_modifications WHERE trip_id = 18914 ORDER BY created_at DESC LIMIT 5",
  "SELECT key, updated_at::text FROM app_settings ORDER BY key LIMIT 100",
  "SELECT count(DISTINCT lower(trim(email))) AS n FROM early_access_signups WHERE created_at >= timestamptz 'X' AND coalesce(trim(first_name),'X') <> 'X' AND first_name NOT ILIKE 'X';",
  "SELECT status, payment, count(*) AS n, count(*) FILTER (WHERE payment_last4 IS NOT NULL) AS with_last4 FROM orders GROUP BY status, payment ORDER BY n DESC",
];
const REFUSED_WITH_REWRITE: [string, RegExp][] = [
  ["SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'X' ORDER BY ordinal_position", /information_schema\.columns is not a table/],
  ["SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'X'", /pg_enum is not a table/],
  ["SELECT unnest(enum_range(NULL::lead_status))::text AS v", /enum_range\(\) is not allowed/],
  ["SELECT current_user AS db_user, pg_has_role(current_user, 'X', 'X') AS write_all FROM pg_roles r", /pg_has_role\(\) is not allowed/],
];

describe("real codeact shapes", () => {
  it.each(PASS)("passes: %s", (sql) => {
    const r = guardSql(sql, { policy: real, dialect: "postgres" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.sql).toContain('FROM ONLY "public".');
  });
  it.each(REFUSED_WITH_REWRITE)("refused with a re-plan message: %s", (sql, why) => {
    expect(refused(guardSql(sql, { policy: real, dialect: "postgres" }))).toMatch(why);
  });
});

describe("stripHiddenColumns", () => {
  it("drops hidden keys case-insensitively", () => {
    expect(stripHiddenColumns([{ id: 1, Email: "a@b.c" }], ["email"])).toEqual([{ id: 1 }]);
  });
});

describe("MySQL placeholders (server-side prepares: one ? per value)", () => {
  it("refuses ?? and a count mismatch; accepts matching ? and ignores ? inside strings", async () => {
    const { mysqlPlaceholderProblem, clampStatementTimeoutMs } = await import("@zavi/shared/db-guard");
    expect(mysqlPlaceholderProblem("SELECT ?? FROM users WHERE id = ?", 2)).toMatch(/\?\?/);
    expect(mysqlPlaceholderProblem("SELECT id FROM users WHERE id = ?", 2)).toMatch(/1 \? placeholder but 2 values/);
    expect(mysqlPlaceholderProblem("SELECT id FROM users WHERE id = ? AND plan = ?", 2)).toBeNull();
    expect(mysqlPlaceholderProblem("SELECT id FROM users WHERE note = '??' AND id = ?", 1)).toBeNull();
    expect(clampStatementTimeoutMs(Number.NaN)).toBe(5000);
    expect(clampStatementTimeoutMs(1e12)).toBe(120000);
    expect(clampStatementTimeoutMs(12.7)).toBe(100);
  });
});

describe("MySQL LIMIT ? / OFFSET ? under server-side prepares", () => {
  it("writes a whole-number LIMIT/OFFSET value into the text and drops it from the values", async () => {
    const { inlineMysqlLimitParams } = await import("@zavi/shared/db-guard");
    expect(inlineMysqlLimitParams("SELECT id FROM users WHERE plan = ? ORDER BY id LIMIT ?", ["pro", 50])).toEqual({
      sql: "SELECT id FROM users WHERE plan = ? ORDER BY id LIMIT 50",
      params: ["pro"],
    });
    expect(inlineMysqlLimitParams("SELECT id FROM users LIMIT ? OFFSET ?", [10, "20"])).toEqual({ sql: "SELECT id FROM users LIMIT 10 OFFSET 20", params: [] });
    expect(inlineMysqlLimitParams("SELECT id FROM users limit ?, ?", [5, 10])).toEqual({ sql: "SELECT id FROM users limit 5, 10", params: [] });
    expect(inlineMysqlLimitParams("SELECT id FROM users LIMIT 5, ?", [10])).toEqual({ sql: "SELECT id FROM users LIMIT 5, 10", params: [] });
  });
  it("leaves everything else bound: other placeholders, non-integers, strings with text, ? in a string", async () => {
    const { inlineMysqlLimitParams } = await import("@zavi/shared/db-guard");
    const keep = (sql: string, params: unknown[]) => expect(inlineMysqlLimitParams(sql, params)).toEqual({ sql, params });
    keep("SELECT id FROM users WHERE id = ?", [5]);
    keep("SELECT id FROM users LIMIT ?", [-1]);
    keep("SELECT id FROM users LIMIT ?", [2.5]);
    keep("SELECT id FROM users LIMIT ?", ["10; DROP TABLE users"]);
    keep("SELECT id FROM users LIMIT ?", ["99999999999999999999"]);
    keep("SELECT id FROM users WHERE note = 'LIMIT ?' AND id IN (?, ?)", [1, 2]);
    keep("SELECT id FROM users WHERE a = ?, ?", [1, 2]);
  });
});

describe("refusal origin: the workspace's settings vs Zavi's own guard", () => {
  it("a hidden column is a settings refusal", () => {
    expect(pg("SELECT email FROM users")).toMatchObject({ ok: false, rule: "settings" });
  });
  it("a switched-off table is a settings refusal", () => {
    expect(pg("SELECT * FROM audit_secret")).toMatchObject({ ok: false, rule: "settings" });
  });
  it("a function in FROM is Zavi's guard", () => {
    const r = pg("SELECT * FROM generate_series(1, 3)");
    expect(r.ok).toBe(false);
    expect((r as { rule?: string }).rule).toBeUndefined();
  });
});
