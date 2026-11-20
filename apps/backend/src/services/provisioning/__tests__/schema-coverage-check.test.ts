import { describe, it, expect } from "vitest";
import {
  assertSchemaCoversQueries,
  detectUnmigratedTables,
  detectMigrateNotRunAtStart,
  readSchemaBaseline,
  SCHEMA_COVERAGE_ERROR_PREFIX,
  type RepoExec,
} from "../schema-coverage-check";
import { readBlessedTemplate } from "@/services/agents/codegen-templates";
import { buildStarterFiles } from "../templates/starters";
import { STARTER_CATEGORIES } from "../starter-picker";
import { hasRunFailureCode } from "@/services/agents/run-failure-code";

const BLESSED_MIGRATE = readBlessedTemplate("migrate.mjs.template");

function migrateWith(extra: string[]): string {
  const marker = "  // Example additive evolution";
  const entry = `  {\n    id: "0002_booking",\n    statements: [\n${extra.map((s) => `      \`${s}\`,`).join("\n")}\n    ],\n  },\n`;
  return BLESSED_MIGRATE.replace(marker, `${entry}${marker}`);
}

const AVAILABILITY_ROUTE = `import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const date = new URL(req.url).searchParams.get("date");
  if (!date) return NextResponse.json({ error: "date required" }, { status: 400 });
  const hours = await query("SELECT open_time, close_time FROM business_hours WHERE weekday = EXTRACT(DOW FROM $1::date)", [date]);
  const taken = await query(
    \`SELECT start_time FROM bookings WHERE booking_date = $1::date AND status <> 'cancelled'\`,
    [date],
  );
  const services = await query("SELECT id, name FROM services ORDER BY name");
  return NextResponse.json({ hours: hours.rows, taken: taken.rows, services: services.rows });
}
`;

const BOOK_ROUTE = `import { NextResponse } from "next/server";
import { withTransaction } from "@/lib/db";

export async function POST(req: Request) {
  const b = await req.json();
  const row = await withTransaction(async (c) => {
    const r = await c.query(
      "INSERT INTO bookings (service_id, booking_date, start_time, name, email) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [b.serviceId, b.date, b.time, b.name, b.email],
    );
    await c.query("INSERT INTO booking_events (booking_id, kind) VALUES ($1, 'created')", [r.rows[0].id]);
    return r.rows[0];
  });
  return NextResponse.json({ booking: row }, { status: 201 });
}
`;

const push = (migrate: string | null, extra: Record<string, string> = {}) => [
  ...(migrate === null ? [] : [{ path: "scripts/migrate.mjs", content: migrate }]),
  { path: "app/api/availability/route.ts", content: AVAILABILITY_ROUTE },
  { path: "app/api/bookings/route.ts", content: BOOK_ROUTE },
  ...Object.entries(extra).map(([path, content]) => ({ path, content })),
];

describe("detectUnmigratedTables: a booking app whose migrate.mjs never creates its tables is refused (DEL-1323 B2)", () => {
  it("names each table the routes query that the blessed migrate.mjs (users/invites/_zavi_audit/favorites) does not create", () => {
    const hits = detectUnmigratedTables(push(BLESSED_MIGRATE));
    expect(hits).toEqual([
      { file: "app/api/availability/route.ts", line: 9, table: "business_hours" },
      { file: "app/api/availability/route.ts", line: 11, table: "bookings" },
      { file: "app/api/availability/route.ts", line: 14, table: "services" },
      { file: "app/api/bookings/route.ts", line: 8, table: "bookings" },
      { file: "app/api/bookings/route.ts", line: 11, table: "booking_events" },
    ]);
  });

  it("only the table still missing is named once the migration appends the rest", () => {
    const migrate = migrateWith([
      "CREATE TABLE IF NOT EXISTS services (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS business_hours (weekday INT PRIMARY KEY, open_time TIME NOT NULL, close_time TIME NOT NULL)",
      "CREATE TABLE IF NOT EXISTS public.\"Bookings_Old\" (id BIGSERIAL PRIMARY KEY)",
      "ALTER TABLE \"Bookings_Old\" RENAME TO bookings",
    ]);
    expect(detectUnmigratedTables(push(migrate)).map((h) => h.table)).toEqual(["booking_events"]);
  });

  it("passes when every queried table is migrated", () => {
    const migrate = migrateWith([
      "CREATE TABLE IF NOT EXISTS services (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS business_hours (weekday INT PRIMARY KEY, open_time TIME NOT NULL, close_time TIME NOT NULL)",
      "CREATE TABLE IF NOT EXISTS bookings (id BIGSERIAL PRIMARY KEY, service_id BIGINT REFERENCES services(id), booking_date DATE NOT NULL, start_time TIME NOT NULL, name TEXT, email TEXT, status TEXT NOT NULL DEFAULT 'booked')",
      "CREATE TABLE IF NOT EXISTS booking_events (id BIGSERIAL PRIMARY KEY, booking_id BIGINT REFERENCES bookings(id), kind TEXT NOT NULL)",
    ]);
    expect(detectUnmigratedTables(push(migrate))).toEqual([]);
  });

  it("a table that only appears in a commented-out migration does not count as created", () => {
    const migrate = BLESSED_MIGRATE.replace(
      "  // Example additive evolution",
      "  // { id: \"0002\", statements: [`CREATE TABLE IF NOT EXISTS bookings (id BIGSERIAL PRIMARY KEY)`] },\n  // Example additive evolution",
    );
    expect(detectUnmigratedTables(push(migrate)).map((h) => h.table)).toContain("bookings");
  });

  it("a pushed .sql migration counts as created", () => {
    const hits = detectUnmigratedTables(
      push(BLESSED_MIGRATE, {
        "db/schema.sql":
          "CREATE TABLE services (id BIGSERIAL PRIMARY KEY);\nCREATE TABLE business_hours (weekday INT);\nCREATE TABLE bookings (id BIGSERIAL PRIMARY KEY);\nCREATE TABLE booking_events (id BIGSERIAL PRIMARY KEY);",
      }),
    );
    expect(hits).toEqual([]);
  });

  it("does not judge a push that carries no scripts/migrate.mjs", () => {
    expect(detectUnmigratedTables(push(null))).toEqual([]);
    expect(detectUnmigratedTables([{ path: "scripts/migrate.mjs", action: "delete" }, ...push(null)])).toEqual([]);
  });
});

describe("detectUnmigratedTables never flags SQL that names no real table", () => {
  it("ignores UI copy, imports, SQL functions, CTEs, subqueries, locking clauses and other schemas", () => {
    const page = `import { query } from "@/lib/db";
import Link from "next/link";
const label = "Select a time from the list below";
const other = 'Update your booking from the dashboard';
// const dead = await query("SELECT * FROM ghosts");
/* await query("SELECT * FROM phantoms"); */
export async function load(d: string) {
  await query(\`WITH open_slots AS (SELECT generate_series(0, 23) AS h) SELECT h FROM open_slots\`);
  await query("SELECT * FROM generate_series(1, 5) AS g(n)");
  await query("SELECT EXTRACT(EPOCH FROM now()) AS t, SUBSTRING(email FROM 1 FOR 3) AS s FROM users");
  await query("SELECT 1 FROM users WHERE email IS DISTINCT FROM $1 FOR UPDATE", [d]);
  await query("INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email", [d, d]);
  await query("SELECT x.n FROM (SELECT 1 AS n) x");
  await query("SELECT table_name FROM information_schema.tables");
  await query("SELECT 1 FROM pg_catalog.pg_tables");
  await query("SELECT count(*) FROM _schema_migrations");
  await query(\`SELECT * FROM \${table}\`);
  await query("SELECT * FROM public.users JOIN LATERAL (SELECT 1) z ON true");
}
`;
    expect(detectUnmigratedTables([{ path: "scripts/migrate.mjs", content: BLESSED_MIGRATE }, { path: "lib/load.ts", content: page }])).toEqual([]);
  });

  it("skips test files and non-code files", () => {
    const files = [
      { path: "scripts/migrate.mjs", content: BLESSED_MIGRATE },
      { path: "app/api/x/__tests__/route.test.ts", content: 'query("SELECT * FROM bookings")' },
      { path: "README.md", content: 'query("SELECT * FROM bookings")' },
    ];
    expect(detectUnmigratedTables(files)).toEqual([]);
  });

  it("every starter the platform ships passes its own check", () => {
    for (const category of STARTER_CATEGORIES) {
      const files = Object.entries(buildStarterFiles(category)).map(([path, content]) => ({ path, content }));
      expect(detectUnmigratedTables(files), category).toEqual([]);
    }
  });
});

describe("detectUnmigratedTables recognises every CREATE shape and stands down on dynamic or ORM schemas (DEL-1323 B2 review)", () => {
  const ALL_TABLES = ["services", "business_hours", "bookings", "booking_events"];

  it("CREATE OR REPLACE VIEW, CREATE TEMP/TEMPORARY TABLE and CREATE MATERIALIZED VIEW all count as created", () => {
    const migrate = migrateWith([
      "CREATE OR REPLACE VIEW services AS SELECT 1 AS id",
      "CREATE TEMP TABLE business_hours (weekday INT)",
      "CREATE TEMPORARY TABLE IF NOT EXISTS bookings (id BIGSERIAL PRIMARY KEY)",
      "CREATE MATERIALIZED VIEW IF NOT EXISTS booking_events AS SELECT 1 AS id",
    ]);
    expect(detectUnmigratedTables(push(migrate))).toEqual([]);
    expect(detectUnmigratedTables(push(migrateWith(["CREATE OR REPLACE VIEW services AS SELECT 1 AS id"]))).map((h) => h.table)).not.toContain("services");
  });

  it("a migrate.mjs that builds a CREATE TABLE name at runtime is not judged", () => {
    const interpolated = BLESSED_MIGRATE.replace(
      "  // Example additive evolution",
      "  ...[\"bookings\"].map((t) => ({ id: `0002_${t}`, statements: [`CREATE TABLE IF NOT EXISTS ${t} (id BIGSERIAL PRIMARY KEY)`] })),\n  // Example additive evolution",
    );
    expect(detectUnmigratedTables(push(interpolated))).toEqual([]);
    const concatenated = BLESSED_MIGRATE.replace(
      "  // Example additive evolution",
      "  { id: \"0002\", statements: [\"CREATE TABLE \" + name + \" (id INT)\"] },\n  // Example additive evolution",
    );
    expect(detectUnmigratedTables(push(concatenated))).toEqual([]);
    const commentedOnly = BLESSED_MIGRATE.replace(
      "  // Example additive evolution",
      "  // `CREATE TABLE ${t} (id INT)`\n  // Example additive evolution",
    );
    expect(detectUnmigratedTables(push(commentedOnly)).map((h) => h.table)).toEqual(expect.arrayContaining(ALL_TABLES));
  });

  it("a push that carries Prisma, Drizzle or .mjs migration modules is not judged", () => {
    for (const extra of <Array<Record<string, string>>>[
      { "prisma/schema.prisma": "model Booking { id Int @id }" },
      { "prisma/migrations/0001_init/migration.sql": "CREATE TABLE \"Booking\" (id INT);" },
      { "drizzle/0000_init.sql": "CREATE TABLE booking (id INT);" },
      { "drizzle.config.ts": "export default {}" },
      { "db/migrations/0002_bookings.mjs": "export const up = (db) => db.query(q);" },
    ]) {
      expect(detectUnmigratedTables(push(BLESSED_MIGRATE, extra)), Object.keys(extra)[0]).toEqual([]);
    }
  });

  it("UI copy that starts with an SQL word but is not a statement is ignored", () => {
    const page = `export const copy = [
  "UPDATE failed, please try again",
  "WITH love FROM the team",
  "SELECT a plan to continue",
  'DELETE this booking?',
  "INSERT your card",
];
export const real = "UPDATE bookings SET status = 'x'";
`;
    const hits = detectUnmigratedTables([{ path: "scripts/migrate.mjs", content: BLESSED_MIGRATE }, { path: "lib/copy.ts", content: page }]);
    expect(hits).toEqual([{ file: "lib/copy.ts", line: 8, table: "bookings" }]);
  });
});

describe("assertSchemaCoversQueries", () => {
  it("throws a plain repairable Error naming file:line and table, with the fix", () => {
    let err: unknown;
    try {
      assertSchemaCoversQueries(push(BLESSED_MIGRATE));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(hasRunFailureCode(err)).toBe(false);
    const msg = (err as Error).message;
    expect(msg.startsWith(`${SCHEMA_COVERAGE_ERROR_PREFIX} app/api/availability/route.ts:9 queries "business_hours"`)).toBe(true);
    expect(msg).toContain("append a new MIGRATIONS entry to scripts/migrate.mjs");
  });

  it("does not throw when the schema covers every query", () => {
    expect(() => assertSchemaCoversQueries(push(null))).not.toThrow();
  });
});

function sandboxRepo(tree: Record<string, string>, opts: { failCat?: string; throwOn?: RegExp } = {}) {
  const calls: string[] = [];
  const run: RepoExec = async (cmd) => {
    calls.push(cmd);
    if (opts.throwOn?.test(cmd)) throw new Error("sandbox gone");
    if (!cmd.startsWith("cd '/home/user/repo' && ")) return { stdout: "", exit_code: 128 };
    const rest = cmd.slice("cd '/home/user/repo' && ".length);
    if (rest === "git ls-files") return { stdout: `${Object.keys(tree).join("\n")}\n`, exit_code: 0 };
    const cat = rest.match(/^cat '(.+)'$/);
    if (cat && cat[1] !== opts.failCat && cat[1] in tree) return { stdout: tree[cat[1]], exit_code: 0 };
    return { stdout: "", exit_code: 1 };
  };
  return { run, calls };
}

const WIRED_PACKAGE_JSON = JSON.stringify({ scripts: { build: "next build", prestart: "node scripts/migrate.mjs", start: "next start -p ${PORT:-3000}" } });
const UNWIRED_PACKAGE_JSON = JSON.stringify({ scripts: { build: "next build", start: "next start -p ${PORT:-3000}" } });

const COVERING_SQL =
  "CREATE TABLE services (id BIGSERIAL PRIMARY KEY);\nCREATE TABLE business_hours (weekday INT);\nCREATE TABLE bookings (id BIGSERIAL PRIMARY KEY);\nCREATE TABLE booking_events (id BIGSERIAL PRIMARY KEY);";

describe("a push that adds booking routes without touching migrate.mjs is judged against the repo's own migrate.mjs (DEL-1323 B2 S3)", () => {
  const starterTree = {
    "scripts/migrate.mjs": BLESSED_MIGRATE,
    "package.json": WIRED_PACKAGE_JSON,
    "app/page.tsx": "export default function Page() { return null; }",
  };

  it("refuses the push with the actionable repair message naming bookings", async () => {
    const pushed = push(null);
    const { run } = sandboxRepo({ ...starterTree, "app/api/availability/route.ts": AVAILABILITY_ROUTE, "app/api/bookings/route.ts": BOOK_ROUTE });
    const repo = await readSchemaBaseline(run, "/home/user/repo", pushed);
    expect(repo.map((f) => f.path).sort()).toEqual(["package.json", "scripts/migrate.mjs"]);
    expect(() => assertSchemaCoversQueries(pushed)).not.toThrow();
    let err: unknown;
    try {
      assertSchemaCoversQueries(pushed, repo);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(hasRunFailureCode(err)).toBe(false);
    const msg = (err as Error).message;
    expect(msg.startsWith(`${SCHEMA_COVERAGE_ERROR_PREFIX} app/api/availability/route.ts:9 queries "business_hours"`)).toBe(true);
    expect(msg).toContain('app/api/availability/route.ts:11 queries "bookings"');
    expect(msg).toContain("scripts/migrate.mjs never creates that table, so the live site answers 500");
    expect(msg).toContain("append a new MIGRATIONS entry to scripts/migrate.mjs");
  });

  it("a .sql migration already in the repo counts as created", async () => {
    const { run } = sandboxRepo({ ...starterTree, "db/schema.sql": COVERING_SQL });
    const repo = await readSchemaBaseline(run, "/home/user/repo", push(null));
    expect(repo.map((f) => f.path).sort()).toEqual(["db/schema.sql", "package.json", "scripts/migrate.mjs"]);
    expect(() => assertSchemaCoversQueries(push(null), repo)).not.toThrow();
  });

  it("the pushed migrate.mjs wins over the repo copy, and a pushed delete of it stands the check down", async () => {
    const covering = migrateWith([
      "CREATE TABLE IF NOT EXISTS services (id BIGSERIAL PRIMARY KEY)",
      "CREATE TABLE IF NOT EXISTS business_hours (weekday INT)",
      "CREATE TABLE IF NOT EXISTS bookings (id BIGSERIAL PRIMARY KEY)",
      "CREATE TABLE IF NOT EXISTS booking_events (id BIGSERIAL PRIMARY KEY)",
    ]);
    const { run } = sandboxRepo(starterTree);
    const withMigrate = push(covering);
    expect((await readSchemaBaseline(run, "/home/user/repo", withMigrate)).map((f) => f.path)).toEqual(["package.json"]);
    expect(() => assertSchemaCoversQueries(withMigrate, [{ path: "scripts/migrate.mjs", content: BLESSED_MIGRATE }])).not.toThrow();
    const deleted = [{ path: "scripts/migrate.mjs", action: "delete" }, ...push(null)];
    expect(detectUnmigratedTables(deleted, [{ path: "scripts/migrate.mjs", content: BLESSED_MIGRATE }])).toEqual([]);
  });

  it("stands down when the repo already carries Prisma or Drizzle migrations", async () => {
    const { run } = sandboxRepo({ ...starterTree, "prisma/schema.prisma": "model Booking { id Int @id }" });
    const repo = await readSchemaBaseline(run, "/home/user/repo", push(null));
    expect(() => assertSchemaCoversQueries(push(null), repo)).not.toThrow();
  });

  it("fails open when the sandbox cannot be read", async () => {
    expect(await readSchemaBaseline(sandboxRepo(starterTree, { throwOn: /ls-files/ }).run, "/home/user/repo", push(null))).toEqual([]);
    expect(await readSchemaBaseline(sandboxRepo(starterTree, { failCat: "scripts/migrate.mjs" }).run, "/home/user/repo", push(null))).toEqual([]);
    expect(await readSchemaBaseline(sandboxRepo(starterTree).run, "/elsewhere", push(null))).toEqual([]);
  });

  it("quotes the repo root and paths for the shell", async () => {
    const { run, calls } = sandboxRepo({ "db/it's.sql": COVERING_SQL, "scripts/migrate.mjs": BLESSED_MIGRATE });
    await readSchemaBaseline(run, "/home/user/repo", []);
    expect(calls).toContain("cd '/home/user/repo' && cat 'db/it'\\''s.sql'");
  });
});

describe("a DB-backed push whose package.json never runs migrate.mjs before start is refused (DEL-1323 B2 deploy trace)", () => {
  const covering = migrateWith([
    "CREATE TABLE IF NOT EXISTS services (id BIGSERIAL PRIMARY KEY)",
    "CREATE TABLE IF NOT EXISTS business_hours (weekday INT)",
    "CREATE TABLE IF NOT EXISTS bookings (id BIGSERIAL PRIMARY KEY)",
    "CREATE TABLE IF NOT EXISTS booking_events (id BIGSERIAL PRIMARY KEY)",
  ]);

  it("refuses when the repo's package.json has no prestart migrate, with the fix", async () => {
    const { run } = sandboxRepo({ "package.json": UNWIRED_PACKAGE_JSON });
    const pushed = push(covering);
    const repo = await readSchemaBaseline(run, "/home/user/repo", pushed);
    expect(detectUnmigratedTables(pushed, repo)).toEqual([]);
    expect(() => assertSchemaCoversQueries(pushed)).not.toThrow();
    let err: unknown;
    try {
      assertSchemaCoversQueries(pushed, repo);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(hasRunFailureCode(err)).toBe(false);
    const msg = (err as Error).message;
    expect(msg.startsWith(`${SCHEMA_COVERAGE_ERROR_PREFIX} app/api/availability/route.ts:9 queries "business_hours"`)).toBe(true);
    expect(msg).toContain("package.json never runs scripts/migrate.mjs before the app starts");
    expect(msg).toContain('add "prestart": "node scripts/migrate.mjs"');
  });

  it("a pushed package.json that adds the prestart hook passes, and one that drops it is refused", () => {
    const repo = [{ path: "package.json", content: UNWIRED_PACKAGE_JSON }];
    expect(detectMigrateNotRunAtStart(push(covering, { "package.json": WIRED_PACKAGE_JSON }), repo)).toBeNull();
    expect(
      detectMigrateNotRunAtStart(push(covering, { "package.json": UNWIRED_PACKAGE_JSON }), [{ path: "package.json", content: WIRED_PACKAGE_JSON }]),
    ).toEqual({ file: "app/api/availability/route.ts", line: 9, table: "business_hours" });
  });

  it("a start script that runs the migration itself counts, and pushes with no queries or no migrate.mjs are not judged", () => {
    const startRuns = JSON.stringify({ scripts: { start: "node ./scripts/migrate.mjs && next start" } });
    expect(detectMigrateNotRunAtStart(push(covering, { "package.json": startRuns }))).toBeNull();
    expect(detectMigrateNotRunAtStart([{ path: "scripts/migrate.mjs", content: covering }, { path: "package.json", content: UNWIRED_PACKAGE_JSON }])).toBeNull();
    expect(detectMigrateNotRunAtStart(push(null, { "package.json": UNWIRED_PACKAGE_JSON }))).toBeNull();
  });

  it("a prestart that runs the migration through an npm script counts; an npm script that does not migrate does not", () => {
    const viaScript = JSON.stringify({ scripts: { migrate: "node scripts/migrate.mjs", prestart: "npm run migrate", start: "next start" } });
    expect(detectMigrateNotRunAtStart(push(covering, { "package.json": viaScript }))).toBeNull();
    const notMigrate = JSON.stringify({ scripts: { lint: "next lint", prestart: "npm run lint", start: "next start" } });
    expect(detectMigrateNotRunAtStart(push(covering, { "package.json": notMigrate }))).not.toBeNull();
  });

  it("every starter that ships migrate.mjs also runs it before start", () => {
    for (const category of STARTER_CATEGORIES) {
      const files = Object.entries(buildStarterFiles(category)).map(([path, content]) => ({ path, content }));
      expect(detectMigrateNotRunAtStart(files), category).toBeNull();
    }
  });
});
