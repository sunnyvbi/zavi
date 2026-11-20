import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openPglite, type Pg } from "@/services/growth/booking-metrics/__tests__/pglite";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf-8");
const between = (sql: string, from: string, to: string) => sql.slice(sql.indexOf(from), sql.indexOf(to));
const FILE = "20261117120000_email_threads_unsub_token_server_only.sql";
const AGENTMAIL = read("20260524060000_agentmail_email_identity_threads.sql");
const SAFETY_NET = read("20260531071613_comms_safety_net.sql");
const P2 = read("20260606075246_p2_bulk_active_tenant_restrict.sql");
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000002";
const MEMBER = "aaaaaaaa-0000-4000-8000-000000000003";
const TABLES = ["email_unsub_token", "email_threads", "email_messages"] as const;

let db: Pg | null = null;

async function as<T>(role: "authenticated" | "anon" | "service_role", uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db!.exec(`set test.uid = '${uid ?? ""}'; set test.active_tenant = '${uid ? T1 : ""}'; set role ${role};`);
  try {
    return await fn();
  } finally {
    await db!.exec("reset role; reset test.uid; reset test.active_tenant;");
  }
}

const readAll = (table: string) => db!.query(`select * from public.${table}`).then((r) => r.rows);
const denied = (table: string) =>
  readAll(table).then(
    () => "readable",
    (e: Error) => (/permission denied/.test(e.message) ? "denied" : e.message),
  );

describe(FILE, () => {
  it("sorts after every migration before it", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf("20261117090000_decision_home_library_video_backfill.sql"));
    expect(all.filter((f) => f.startsWith("20261117120000"))).toEqual([FILE]);
  });
});

describe.skipIf(!process.env.CI && !process.env.PGLITE_DIR)(`${FILE} in Postgres`, () => {
  beforeAll(async () => {
    db = await openPglite();
    await db!.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as $$
        select jsonb_build_object('app_metadata', jsonb_build_object('active_tenant_id', nullif(current_setting('test.active_tenant', true), '')))
      $$;
      grant usage on schema auth to anon, authenticated, service_role;
      grant execute on all functions in schema auth to anon, authenticated, service_role;
      grant usage on schema public to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      create table public.tenants (id uuid primary key);
      create table public.tenant_users (user_id uuid, tenant_id uuid, role text);
      create table public.email_triage_window (tenant_id uuid);
      create table public.email_triage_claims (tenant_id uuid);
      insert into public.tenants values ('${T1}'), ('${T2}');
      insert into public.tenant_users values ('${OWNER}', '${T1}', 'owner'), ('${ADMIN}', '${T1}', 'admin'), ('${MEMBER}', '${T1}', 'member');
    `);
    await db!.exec(between(AGENTMAIL, "-- (1) immutable", "-- (5) layered"));
    await db!.exec(between(AGENTMAIL, "-- (10) RLS", "-- triage_window + triage_claims"));
    await db!.exec(between(SAFETY_NET, "-- ── 4. Stable", "-- ── RPC: is_email_suppressed"));
    await db!.exec(P2);
    await db!.exec(`
      insert into public.email_threads (id, tenant_id, owner_agent_slug, root_message_id)
        values ('33333333-3333-4333-8333-333333333333', '${T1}', 'cgo', '<root@acme.test>');
      insert into public.email_messages (tenant_id, thread_id, direction, from_address, subject, body_text, dedup_key)
        values ('${T1}', '33333333-3333-4333-8333-333333333333', 'in', 'founder@acme.test', 'Our numbers', 'private reply', 'k1');
      insert into public.email_unsub_token (tenant_id, email) values ('${T1}', 'ada@example.com'), ('${T2}', 'bob@other.test');
    `);
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("before the migration a plain member of the workspace reads every row of all three tables", async () => {
    const seen = await as("authenticated", MEMBER, async () => ({
      tokens: (await readAll("email_unsub_token")).map((r) => r.email),
      threads: (await readAll("email_threads")).length,
      bodies: (await readAll("email_messages")).map((r) => r.body_text),
    }));
    expect(seen).toEqual({ tokens: ["ada@example.com"], threads: 1, bodies: ["private reply"] });
  });

  describe("after the migration, applied twice", () => {
    beforeAll(async () => {
      await db!.exec(read(FILE));
      await db!.exec(read(FILE));
    });

    it.each([
      ["member", MEMBER],
      ["admin", ADMIN],
      ["owner", OWNER],
    ])("a signed-in %s reads none of the tables with the browser session", async (_label, uid) => {
      for (const t of TABLES) expect(await as("authenticated", uid, () => denied(t))).toBe("denied");
    });

    it("an anonymous caller reads none of them", async () => {
      for (const t of TABLES) expect(await as("anon", null, () => denied(t))).toBe("denied");
    });

    it("the server still reads and writes them, so unsubscribe links and inbound mail keep working", async () => {
      const r = await as("service_role", null, async () => {
        await db!.exec(`insert into public.email_unsub_token (tenant_id, email) values ('${T1}', 'new@example.com')`);
        return {
          token: (await db!.query("select tenant_id, email from public.email_unsub_token where email = 'ada@example.com'")).rows,
          tokens: (await readAll("email_unsub_token")).length,
          threads: (await readAll("email_threads")).length,
          messages: (await readAll("email_messages")).length,
        };
      });
      expect(r).toEqual({ token: [{ tenant_id: T1, email: "ada@example.com" }], tokens: 3, threads: 1, messages: 1 });
    });

    it("no client grant or permissive read policy is left on any of the three tables", async () => {
      for (const t of TABLES) {
        const g = await db!.query(
          `select has_table_privilege('authenticated', 'public.${t}', 'select') as a, has_table_privilege('anon', 'public.${t}', 'select') as b,
                  has_table_privilege('authenticated', 'public.${t}', 'insert,update,delete') as c`,
        );
        expect(g.rows[0]).toEqual({ a: false, b: false, c: false });
        const p = await db!.query("select policyname from pg_policies where tablename = $1 and permissive = 'PERMISSIVE'", [t]);
        expect(p.rows).toEqual([]);
      }
    });
  });
});
