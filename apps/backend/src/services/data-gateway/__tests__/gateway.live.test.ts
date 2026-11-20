import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { effectivePolicy } from "@zavi/shared/db-guard";

vi.mock("../audit", () => ({
  reserveAudit: vi.fn(async () => "live-log"),
  finalizeAudit: vi.fn(async () => undefined),
  writeRefusalAudit: vi.fn(async () => null),
}));

import { loggedSession } from "../logged-session";
import { openSqlSession } from "../direct/sql";
import { openMongoSession } from "../direct/mongo";
import type { DbAccess } from "../resolve";
import type { ReadSession } from "../session";
import { introspectPostgres } from "../discovery/postgres";
import { normalizeRawCatalog } from "@/services/tools/operator-db/discovery";

const PG_URL = process.env.DATA_GATEWAY_LIVE_PG_URL;
const MONGO_URL = process.env.DATA_GATEWAY_LIVE_MONGO_URL;
const SECRET = "hidden-live@example.com";
const ctx = { tenant_id: "live", caller: { kind: "agent" as const, agent_slug: "live", run_id: null, tool_name: "live" } };

type LiveTable = { name: string; columns: { name: string }[]; view_of?: string; partitioned?: boolean; partitions?: string[] };
function access(dialect: DbAccess["dialect"], tables: LiveTable[], extra: { disabled_tables?: string[]; auto_hide?: boolean; hidden_fields?: string[] } = {}): DbAccess {
  return {
    tenant_id: "live",
    mode: "direct",
    dialect,
    database: null,
    policy: effectivePolicy(
      { auto_hide: extra.auto_hide ?? false, hidden_fields: [...tables.map((t) => `${t.name}.email`), ...(extra.hidden_fields ?? [])], unhidden_fields: [], disabled_tables: extra.disabled_tables ?? [] },
      { tables },
      dialect,
    ),
  } as unknown as DbAccess;
}

describe.skipIf(!PG_URL)("live Postgres: hidden email never leaves", () => {
  let session: ReadSession;
  beforeAll(async () => {
    const { Client } = await import("pg");
    const c = new Client({ connectionString: PG_URL });
    await c.connect();
    await c.query("DROP TABLE IF EXISTS users_gw_live; CREATE TABLE users_gw_live (id int, email text, role text)");
    await c.query("INSERT INTO users_gw_live VALUES (1, $1, 'host')", [SECRET]);
    await c.end();
    const inner = await openSqlSession("postgres", PG_URL!);
    session = loggedSession(inner, access("postgres", [{ name: "users_gw_live", columns: [{ name: "id" }, { name: "email" }, { name: "role" }] }]), ctx);
  });
  afterAll(async () => {
    await session?.close();
  });
  it.each([
    "SELECT * FROM users_gw_live",
    "SELECT u::text AS t FROM users_gw_live u",
    "SELECT row_to_json(u) AS j FROM users_gw_live u",
    "SELECT concat(u.*) AS c FROM users_gw_live u",
    "SELECT json_agg(u) AS a FROM users_gw_live u",
    "SELECT * FROM public.users_gw_live",
  ])("%s", async (sql) => {
    const r = await session.query(sql, [], { maxRows: 10 });
    expect(r.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.rows)).not.toContain(SECRET);
  });
});

describe.skipIf(!PG_URL)("live Postgres: Codex review scenarios", () => {
  const USERS = [{ name: "id" }, { name: "email" }, { name: "role" }];
  let session: ReadSession;
  let admin: import("pg").Client;
  beforeAll(async () => {
    const { Client } = await import("pg");
    admin = new Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`
      DROP TABLE IF EXISTS gw_child CASCADE; DROP TABLE IF EXISTS gw_users CASCADE; DROP TABLE IF EXISTS gw_events CASCADE;
      DROP SCHEMA IF EXISTS gw_private CASCADE; DROP FUNCTION IF EXISTS public.lower(integer);
      CREATE TABLE gw_users (id int, email text, role text);
      INSERT INTO gw_users VALUES (1, 'hidden-live@example.com', 'host');
      CREATE TABLE gw_child (secret_note text) INHERITS (gw_users);
      INSERT INTO gw_child VALUES (2, 'child@example.com', 'child-row', 'inherits-secret');
      CREATE SCHEMA gw_private;
      CREATE TABLE gw_private.gw_users (id int, email text, role text);
      INSERT INTO gw_private.gw_users VALUES (9, 'x', 'private-schema-secret');
      CREATE FUNCTION public.lower(integer) RETURNS text LANGUAGE sql AS $$ SELECT 'overload-secret'::text $$;
      CREATE TABLE gw_events (id int, kind text) PARTITION BY RANGE (id);
      CREATE TABLE gw_events_a PARTITION OF gw_events FOR VALUES FROM (0) TO (100);
      CREATE TABLE gw_events_b PARTITION OF gw_events FOR VALUES FROM (100) TO (200);
      INSERT INTO gw_events VALUES (1, 'a'), (150, 'b');
    `);
    const db = new URL(PG_URL!).pathname.slice(1);
    await admin.query(`ALTER DATABASE "${db}" SET search_path = gw_private, public`);
    const inner = await openSqlSession("postgres", PG_URL!);
    session = loggedSession(inner, access("postgres", [{ name: "gw_users", columns: USERS }]), ctx);
    await admin.query("ALTER TABLE gw_users ADD COLUMN phone text; UPDATE gw_users SET phone = 'new-column-secret'");
  });
  afterAll(async () => {
    await session?.close();
    const db = new URL(PG_URL!).pathname.slice(1);
    await admin.query(`ALTER DATABASE "${db}" RESET search_path`).catch(() => undefined);
    await admin.end();
  });
  it("search_path cannot redirect gw_users to another schema; INHERITS child rows and new columns stay out", async () => {
    const r = await session.query("SELECT * FROM gw_users", [], { maxRows: 10 });
    const text = JSON.stringify(r.rows);
    expect(r.rows).toHaveLength(1);
    expect(text).toContain("host");
    for (const bad of ["private-schema-secret", "child-row", "inherits-secret", "new-column-secret", "hidden-live@example.com"]) expect(text).not.toContain(bad);
  });
  it("a public lower(integer) overload is never what runs", async () => {
    const out = await session.query("SELECT lower(id) AS l FROM gw_users", [], { maxRows: 10 }).then(
      (r) => JSON.stringify(r.rows),
      (e: Error) => e.message,
    );
    expect(out).not.toContain("overload-secret");
  });
  it("discovery records the partitioned parent; reads include partitions only when all are allowed", async () => {
    const raw = await introspectPostgres(PG_URL!);
    const cat = normalizeRawCatalog(raw);
    const parent = cat.tables.find((t) => t.name === "gw_events");
    expect(parent?.partitioned).toBe(true);
    expect([...(parent?.partitions ?? [])].sort()).toEqual(["gw_events_a", "gw_events_b"]);
    const tables = cat.tables.filter((t) => t.name.startsWith("gw_events")) as LiveTable[];
    const all = loggedSession(await openSqlSession("postgres", PG_URL!), access("postgres", tables), ctx);
    try {
      const r = await all.query("SELECT count(*)::int AS n FROM gw_events", [], { maxRows: 10 });
      expect(r.rows[0]).toMatchObject({ n: 2 });
    } finally {
      await all.close();
    }
    const one = loggedSession(await openSqlSession("postgres", PG_URL!), access("postgres", tables, { disabled_tables: ["gw_events_b"] }), ctx);
    try {
      await expect(one.query("SELECT count(*) FROM gw_events", [], { maxRows: 10 })).rejects.toMatchObject({ code: "data_access_refused" });
    } finally {
      await one.close();
    }
  });
});

describe.skipIf(!MONGO_URL)("live Mongo: hidden email never leaves", () => {
  let session: ReadSession;
  beforeAll(async () => {
    const { MongoClient } = await import("mongodb");
    const c = new MongoClient(MONGO_URL!);
    await c.connect();
    const db = c.db();
    await db.collection("users_gw_live").deleteMany({});
    await db.collection("orders_gw_live").deleteMany({});
    await db.collection("users_gw_live").insertOne({ _id: 1 as never, email: SECRET, role: "host" });
    await db.collection("orders_gw_live").insertOne({ _id: 1 as never, user_id: 1, total: 5 });
    await c.close();
    const inner = await openMongoSession(MONGO_URL!);
    session = loggedSession(
      inner,
      access("mongodb", [
        { name: "users_gw_live", columns: [{ name: "_id" }, { name: "email" }, { name: "role" }] },
        { name: "orders_gw_live", columns: [{ name: "_id" }, { name: "user_id" }, { name: "total" }] },
      ]),
      ctx,
    );
  });
  afterAll(async () => {
    await session?.close();
  });
  it("find({})", async () => {
    expect(JSON.stringify(await session.mongo().find("users_gw_live", {}))).not.toContain(SECRET);
  });
  it("$replaceRoot $$ROOT is refused while email is hidden", async () => {
    await expect(session.mongo().aggregate("users_gw_live", [{ $replaceRoot: { newRoot: "$$ROOT" } }])).rejects.toMatchObject({ code: "data_access_refused" });
  });
  it("$lookup from a second collection", async () => {
    const out = await session.mongo().aggregate("orders_gw_live", [{ $lookup: { from: "users_gw_live", localField: "user_id", foreignField: "_id", as: "u" } }]);
    expect(out.length).toBe(1);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
});

describe.skipIf(!MONGO_URL)("live Mongo: Codex review scenarios", () => {
  let session: ReadSession;
  beforeAll(async () => {
    const { MongoClient } = await import("mongodb");
    const c = new MongoClient(MONGO_URL!);
    await c.connect();
    const db = c.db();
    for (const n of ["gw_people", "gw_people_view", "gw_dotted"]) await db.collection(n).drop().catch(() => undefined);
    await db.collection("gw_people").insertOne({ _id: 1 as never, role: "host", email: SECRET, contact: { email: SECRET, home_email: SECRET } });
    await db.createCollection("gw_people_view", { viewOn: "gw_people", pipeline: [{ $project: { cohort: "$email" } }] });
    await db.collection("gw_dotted").insertOne({ _id: 1 as never, selector: "a.b", "a.b": SECRET } as never);
    await c.close();
    const inner = await openMongoSession(MONGO_URL!);
    session = loggedSession(
      inner,
      access(
        "mongodb",
        [
          { name: "gw_people", columns: [{ name: "_id" }, { name: "role" }] },
          { name: "gw_people_view", columns: [{ name: "_id" }, { name: "cohort" }], view_of: "gw_people" },
          { name: "gw_dotted", columns: [{ name: "_id" }, { name: "selector" }, { name: "a.b" }] },
        ],
        { auto_hide: true, hidden_fields: ["gw_dotted.a.b"] },
      ),
      ctx,
    );
  });
  afterAll(async () => {
    await session?.close();
  });
  it("email outside the sampled catalog is stripped from results", async () => {
    const out = await session.mongo().find("gw_people", {});
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
  it("a query naming an uncatalogued sensitive path is refused", async () => {
    await expect(session.mongo().find("gw_people", { email: SECRET })).rejects.toMatchObject({ code: "data_access_refused" });
  });
  it("a view is never readable, directly or through $lookup", async () => {
    await expect(session.mongo().find("gw_people_view", {})).rejects.toMatchObject({ code: "data_access_refused" });
    await expect(
      session.mongo().aggregate("gw_people", [{ $lookup: { from: "gw_people_view", localField: "_id", foreignField: "_id", as: "v" } }]),
    ).rejects.toMatchObject({ code: "data_access_refused" });
  });
  it("computed $getField is refused while fields are hidden", async () => {
    await expect(session.mongo().aggregate("gw_dotted", [{ $project: { leak: { $getField: "$selector" } } }])).rejects.toMatchObject({ code: "data_access_refused" });
  });
});
