import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openPglite, type Pg } from "@/services/growth/booking-metrics/__tests__/pglite";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf-8");
const SAFETY_NET = read("20260531071613_comms_safety_net.sql");
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000002";
const MEMBER = "aaaaaaaa-0000-4000-8000-000000000003";
const OUTSIDER = "aaaaaaaa-0000-4000-8000-000000000004";

let db: Pg | null = null;

const list = async (user: string, search: string | null = null, page = 1, tenant = T1) =>
  (await db!.query("select list_email_suppressions($1, $2, $3, $4) as r", [tenant, user, search, page])).rows[0].r as {
    ok: boolean;
    code?: string;
    rows: Array<{ email: string; reason: string; created_at: string }>;
    total: number;
    masked: boolean;
  };
const add = async (user: string, email: string, tenant = T1) =>
  (await db!.query("select add_email_suppression($1, $2, $3) as r", [tenant, user, email])).rows[0].r as Record<string, unknown>;

describe.skipIf(!process.env.CI && !process.env.PGLITE_DIR)("20261108105000_email_suppressions_view.sql in Postgres", () => {
  beforeAll(async () => {
    db = await openPglite();
    await db!.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create table tenants (id uuid primary key);
      create table tenant_users (user_id uuid, tenant_id uuid, role text);
      insert into tenants values ('${T1}'), ('${T2}');
      insert into tenant_users values ('${OWNER}', '${T1}', 'owner'), ('${ADMIN}', '${T1}', 'admin'), ('${MEMBER}', '${T1}', 'member'), ('${OUTSIDER}', '${T2}', 'owner');
    `);
    await db!.exec(SAFETY_NET.slice(0, SAFETY_NET.indexOf("-- ── 2.")));
    await db!.exec(`alter table email_suppression drop constraint if exists email_suppression_reason_check;
      alter table email_suppression add constraint email_suppression_reason_check check (reason in ('unsubscribe', 'bounce', 'complaint', 'manual', 'erased'));`);
    await db!.exec(read("20261108105000_email_suppressions_view.sql"));
    await db!.exec(read("20261108105000_email_suppressions_view.sql"));
    const rows: string[] = [];
    for (let i = 0; i < 55; i++) rows.push(`('${T1}', 'bulk${String(i).padStart(2, "0")}@acme.test', 'bounce', now() - interval '${i + 10} minutes')`);
    rows.push(`('${T1}', 'pat_ok@example.com', 'complaint', now() - interval '1 minute')`);
    rows.push(`('${T1}', 'pat%ok@example.com', 'unsubscribe', now() - interval '2 minutes')`);
    rows.push(`('${T2}', 'secret@other.test', 'bounce', now())`);
    await db!.exec(`insert into email_suppression (tenant_id, email, reason, created_at) values ${rows.join(", ")};`);
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it("an owner reads only this workspace's addresses, newest first, 50 a page, with the total", async () => {
    const p1 = await list(OWNER);
    expect(p1).toMatchObject({ ok: true, total: 57, masked: false });
    expect(p1.rows).toHaveLength(50);
    expect(p1.rows[0]).toMatchObject({ email: "pat_ok@example.com", reason: "complaint" });
    expect(p1.rows.some((r) => r.email.includes("other.test"))).toBe(false);
    const p2 = await list(OWNER, null, 2);
    expect(p2.rows).toHaveLength(7);
    expect(new Set([...p1.rows, ...p2.rows].map((r) => r.email)).size).toBe(57);
  });

  it("search is literal: % and _ match only themselves", async () => {
    expect((await list(OWNER, "pat_ok")).rows.map((r) => r.email)).toEqual(["pat_ok@example.com"]);
    expect((await list(OWNER, "pat%")).rows.map((r) => r.email)).toEqual(["pat%ok@example.com"]);
    expect((await list(OWNER, "%")).total).toBe(1);
    expect((await list(OWNER, "BULK0")).total).toBe(10);
  });

  it("a member sees masked addresses and can only search by domain", async () => {
    const m = await list(MEMBER);
    expect(m).toMatchObject({ ok: true, total: 57, masked: true });
    expect(m.rows[0].email).toBe("p***@example.com");
    expect(m.rows.every((r) => /^.\*\*\*@/.test(r.email))).toBe(true);
    expect((await list(MEMBER, "pat_ok")).total).toBe(0);
    expect((await list(MEMBER, "example.com")).total).toBe(2);
  });

  it("someone outside the workspace reads nothing", async () => {
    expect(await list(OUTSIDER)).toEqual({ ok: false, code: "not_authorized" });
    expect((await list(OUTSIDER, null, 1, T2)).rows.map((r) => r.email)).toEqual(["secret@other.test"]);
  });

  it("an owner or admin adds a manual suppression; a member or outsider cannot", async () => {
    expect(await add(MEMBER, "new@x.test")).toEqual({ ok: false, code: "not_authorized" });
    expect(await add(OUTSIDER, "new@x.test")).toEqual({ ok: false, code: "not_authorized" });
    expect(await add(OWNER, "  New@X.test ")).toMatchObject({ ok: true, added: true, email: "new@x.test", reason: "manual" });
    expect(await add(ADMIN, "admin@x.test")).toMatchObject({ ok: true, added: true });
    const r = await db!.query("select tenant_id, reason from email_suppression where email = 'new@x.test'");
    expect(r.rows).toEqual([{ tenant_id: T1, reason: "manual" }]);
  });

  it("adding an address that is already suppressed keeps its reason (a complaint stays a complaint)", async () => {
    expect(await add(OWNER, "pat_ok@example.com")).toMatchObject({ ok: true, added: false, reason: "complaint" });
    const r = await db!.query("select reason from email_suppression where tenant_id = $1 and email = 'pat_ok@example.com'", [T1]);
    expect(r.rows[0].reason).toBe("complaint");
  });

  it("refuses something that is not an address", async () => {
    for (const bad of ["", "nobody", "a@b", "a b@c.test", `${"a".repeat(320)}@x.test`]) {
      expect(await add(OWNER, bad)).toEqual({ ok: false, code: "bad_email" });
    }
  });

  it("the table has no client policy or grant, and neither RPC is callable by anon or authenticated", async () => {
    const pol = await db!.query("select count(*)::int as n from pg_policies where tablename = 'email_suppression'");
    expect(pol.rows[0].n).toBe(0);
    const t = await db!.query("select has_table_privilege('authenticated', 'email_suppression', 'select') as a, has_table_privilege('anon', 'email_suppression', 'select') as b");
    expect(t.rows[0]).toEqual({ a: false, b: false });
    const f = await db!.query(
      `select has_function_privilege('authenticated', 'list_email_suppressions(uuid, uuid, text, int)', 'execute') as a,
              has_function_privilege('anon', 'list_email_suppressions(uuid, uuid, text, int)', 'execute') as b,
              has_function_privilege('authenticated', 'add_email_suppression(uuid, uuid, text)', 'execute') as c,
              has_function_privilege('anon', 'add_email_suppression(uuid, uuid, text)', 'execute') as d`,
    );
    expect(f.rows[0]).toEqual({ a: false, b: false, c: false, d: false });
  });
});
