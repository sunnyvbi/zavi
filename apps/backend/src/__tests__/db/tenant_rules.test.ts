import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TENANT_RULES_PG_URL;
const MIG = resolve(__dirname, "../../../../../supabase/migrations");
const T_A = "11111111-1111-4111-8111-111111111111";
const T_B = "22222222-2222-4222-8222-222222222222";
const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000002";
const MEMBER = "aaaaaaaa-0000-4000-8000-000000000003";
const VIEWER = "aaaaaaaa-0000-4000-8000-000000000004";
const OWNER_B = "bbbbbbbb-0000-4000-8000-000000000001";

describe.skipIf(!url)("tenant_rules RPCs on real Postgres", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Client: any;

  const rpc = async (fn: string, ...a: unknown[]) => {
    const ph = a.map((_, i) => `$${i + 1}`).join(", ");
    const r = await db.query(`select public.${fn}(${ph}) as r`, a);
    return r.rows[0].r;
  };
  const add = (tenant: string, actor: string, text: string, extra: Partial<Record<string, unknown>> = {}) =>
    rpc("rule_add", tenant, actor, text, extra.scope_kind ?? "all", extra.scope_slug ?? null,
      extra.origin ?? "rules_page", extra.source_ref ?? null, null, null, extra.source_hash ?? null,
      extra.excerpt ?? null, null);
  const reset = () => db.query("truncate public.tenant_rules, public.tenant_rule_settings");

  beforeAll(async () => {
    ({ Client } = await import("pg"));
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`
      do $$ declare r text; begin foreach r in array array['anon', 'authenticated', 'service_role'] loop if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I', r); end if; end loop; end $$; create schema auth;
      create table auth.ctx(uid uuid, active uuid);
      insert into auth.ctx values ('${MEMBER}', '${T_A}');
      create function auth.uid() returns uuid language sql stable as $$ select uid from auth.ctx $$;
      create function auth.jwt() returns jsonb language sql stable as $$
        select jsonb_build_object('app_metadata', jsonb_build_object('active_tenant_id', active)) from auth.ctx $$;
      create function public.app_active_tenant() returns uuid language sql stable as $$ select active from auth.ctx $$;
      create table public.tenants(id uuid primary key);
      create table public.tenant_users(user_id uuid, tenant_id uuid, role text);
      create table public.agent_runs(id uuid primary key, tenant_id uuid);
      create table public.tenant_personalization(tenant_id uuid primary key, custom_instructions text);
      insert into public.tenants values ('${T_A}'), ('${T_B}');
      insert into public.tenant_users values
        ('${OWNER}', '${T_A}', 'owner'), ('${ADMIN}', '${T_A}', 'admin'),
        ('${MEMBER}', '${T_A}', 'member'), ('${VIEWER}', '${T_A}', 'viewer'),
        ('${OWNER_B}', '${T_B}', 'owner');
      grant usage on schema auth to authenticated;
      grant select on auth.ctx to authenticated;
      grant usage on schema public to authenticated;
      grant select on public.tenant_users to authenticated;
      grant execute on function public.app_active_tenant() to authenticated;
    `);
    await db.query(readFileSync(resolve(MIG, "20261005120000_tenant_rules.sql"), "utf8"));
  });
  afterAll(async () => { await db?.end(); });

  it("a member's rule is a suggestion; only an owner or admin activates it", async () => {
    await reset();
    const m = await add(T_A, MEMBER, "Never post on weekends");
    expect(m.status).toBe("suggested");
    await expect(rpc("rule_activate", T_A, MEMBER, m.rule_id)).rejects.toThrow(/owner or admin/);
    expect((await rpc("rule_activate", T_A, ADMIN, m.rule_id)).status).toBe("active");
    const o = await add(T_A, OWNER, "Always reply in English");
    expect(o.status).toBe("active");
  });

  it("a viewer cannot add a rule", async () => {
    await reset();
    await expect(add(T_A, VIEWER, "anything")).rejects.toThrow(/viewers cannot/);
  });

  it("an exact duplicate of an active rule is merged, not added twice", async () => {
    await reset();
    const a = await add(T_A, OWNER, "Never post on weekends");
    const b = await add(T_A, OWNER, "  never post   on weekends ");
    expect(b).toEqual({ status: "duplicate", rule_id: a.rule_id });
  });

  it("the same source is suggested once (idempotency key)", async () => {
    await reset();
    const s = { origin: "chat_typed", source_ref: "msg-1", source_hash: "h1" };
    const a = await add(T_A, MEMBER, "No TikTok", s);
    const b = await add(T_A, MEMBER, "No TikTok", s);
    expect(b).toEqual({ status: "exists", rule_id: a.rule_id });
  });

  it("refuses card-number and SSN-like text, allows a business email", async () => {
    await reset();
    await expect(add(T_A, OWNER, "Charge card 4242 4242 4242 4242 first")).rejects.toThrow(/card or ID number/);
    await expect(add(T_A, OWNER, "My SSN is 123-45-6789")).rejects.toThrow(/card or ID number/);
    expect((await add(T_A, OWNER, "Send weekly reports to growth@acme.com")).status).toBe("active");
  });

  it("refuses text over 280 characters and empty text", async () => {
    await reset();
    await expect(add(T_A, OWNER, "x".repeat(281))).rejects.toThrow(/280/);
    await expect(add(T_A, OWNER, "   ")).rejects.toThrow(/needs some words/);
  });

  it("the 31st active rule is refused with a clear message", async () => {
    await reset();
    for (let i = 0; i < 30; i++) expect((await add(T_A, OWNER, `rule ${i}`)).status).toBe("active");
    await expect(add(T_A, OWNER, "rule 30")).rejects.toThrow(/30 active rules/);
    const s = await add(T_A, MEMBER, "a suggestion is still allowed");
    expect(s.status).toBe("suggested");
    await expect(rpc("rule_activate", T_A, OWNER, s.rule_id)).rejects.toThrow(/30 active rules/);
  });

  it("two concurrent approvals cannot both take the last slot", async () => {
    await reset();
    for (let i = 0; i < 29; i++) await add(T_A, OWNER, `rule ${i}`);
    const s1 = await add(T_A, MEMBER, "pending one");
    const s2 = await add(T_A, MEMBER, "pending two");
    const c1 = new Client({ connectionString: url });
    const c2 = new Client({ connectionString: url });
    await c1.connect(); await c2.connect();
    try {
      await c1.query("begin"); await c2.query("begin");
      await c1.query("select public.rule_activate($1,$2,$3)", [T_A, OWNER, s1.rule_id]);
      const p2 = c2.query("select public.rule_activate($1,$2,$3)", [T_A, ADMIN, s2.rule_id])
        .then(() => "ok", (e: Error) => e.message);
      await new Promise((r) => setTimeout(r, 300));
      await c1.query("commit");
      const r2 = await p2;
      await c2.query(r2 === "ok" ? "commit" : "rollback");
      expect(r2).toMatch(/30 active rules/);
    } finally { await c1.end(); await c2.end(); }
    const n = await db.query(`select count(*)::int n from public.tenant_rules where tenant_id=$1 and status='active'`, [T_A]);
    expect(n.rows[0].n).toBe(30);
  });

  it("edit creates a new active rule that supersedes the old one", async () => {
    await reset();
    const a = await add(T_A, OWNER, "Never post on weekends");
    const e = await rpc("rule_edit", T_A, ADMIN, a.rule_id, "Never post on Sundays", "channel", "linkedin");
    expect(e.status).toBe("active");
    const rows = (await db.query(`select id, status, supersedes from public.tenant_rules where tenant_id=$1 order by created_at`, [T_A])).rows;
    expect(rows.find((r: { id: string }) => r.id === a.rule_id).status).toBe("superseded");
    expect(rows.find((r: { id: string }) => r.id === e.rule_id).supersedes).toBe(a.rule_id);
  });

  it("delete clears the words; delete-all clears every row including superseded ones", async () => {
    await reset();
    const a = await add(T_A, OWNER, "Never post on weekends", { excerpt: "we never post on weekends ok" });
    await rpc("rule_edit", T_A, OWNER, a.rule_id, "Never post on Sundays", "all", null);
    const b = await add(T_A, OWNER, "No TikTok");
    expect((await rpc("rule_delete", T_A, OWNER, b.rule_id)).status).toBe("deleted");
    const del = (await db.query(`select text, excerpt, status from public.tenant_rules where id=$1`, [b.rule_id])).rows[0];
    expect(del).toEqual({ text: "", excerpt: null, status: "deleted" });
    await rpc("rule_delete_all", T_A, ADMIN);
    const left = (await db.query(`select count(*)::int n from public.tenant_rules where tenant_id=$1 and (text <> '' or excerpt is not null or status <> 'deleted')`, [T_A])).rows[0];
    expect(left.n).toBe(0);
  });

  it("a member cannot delete; nobody can touch another tenant's rule", async () => {
    await reset();
    const a = await add(T_A, OWNER, "Never post on weekends");
    await expect(rpc("rule_delete", T_A, MEMBER, a.rule_id)).rejects.toThrow(/owner or admin/);
    expect((await rpc("rule_delete", T_B, OWNER_B, a.rule_id)).status).toBe("not_found");
    expect((await rpc("rule_activate", T_B, OWNER_B, a.rule_id)).status).toBe("not_found");
    await expect(rpc("rule_delete_all", T_A, OWNER_B)).rejects.toThrow(/not a member/);
    await expect(rpc("rule_list", T_A, OWNER_B)).rejects.toThrow(/not a member/);
    const l = await rpc("rule_list", T_B, OWNER_B);
    expect(l.rules).toEqual([]);
  });

  it("the source excerpt goes only to its author and to owners/admins", async () => {
    await reset();
    await add(T_A, OWNER, "Never post on weekends", { excerpt: "owner excerpt" });
    await add(T_A, MEMBER, "Stop suggesting TikTok", { excerpt: "member excerpt" });
    const asViewer = await rpc("rule_list", T_A, VIEWER);
    expect(asViewer.rules.map((r: { excerpt: string | null }) => r.excerpt)).toEqual([null, null]);
    const asMember = await rpc("rule_list", T_A, MEMBER);
    expect(asMember.rules.map((r: { excerpt: string | null }) => r.excerpt).sort()).toEqual(["member excerpt", null].sort());
    const asAdmin = await rpc("rule_list", T_A, ADMIN);
    expect(asAdmin.rules.map((r: { excerpt: string | null }) => r.excerpt).sort()).toEqual(["member excerpt", "owner excerpt"]);
  });

  it("through PostgREST a member reads rule text but never the excerpt, and writes nothing", async () => {
    await reset();
    await add(T_A, OWNER, "Never post on weekends", { excerpt: "secret excerpt" });
    await add(T_B, OWNER_B, "Tenant B rule");
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      const r = await db.query("select text from public.tenant_rules");
      expect(r.rows.map((x: { text: string }) => x.text)).toEqual(["Never post on weekends"]);
      await expect(db.query("select excerpt from public.tenant_rules")).rejects.toThrow(/permission denied/);
    } finally { await db.query("rollback"); }
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await expect(db.query(`insert into public.tenant_rules(tenant_id, scope_kind, text, status, origin) values ('${T_A}','all','x','active','rules_page')`))
        .rejects.toThrow(/permission denied/);
    } finally { await db.query("rollback"); }
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await expect(db.query(`select public.rule_add('${T_A}','${OWNER}','x','all',null,'rules_page',null,null,null,null,null,null)`))
        .rejects.toThrow(/permission denied/);
    } finally { await db.query("rollback"); }
  });

  it("pause suggestions is an owner/admin switch", async () => {
    await reset();
    await expect(rpc("rule_set_suggestions_paused", T_A, MEMBER, true)).rejects.toThrow(/owner or admin/);
    await rpc("rule_set_suggestions_paused", T_A, OWNER, true);
    expect((await rpc("rule_list", T_A, MEMBER)).suggestions_paused).toBe(true);
  });
  it("Personalization instructions move over as suggestions only, skipping markers and ID numbers", async () => {
    await reset();
    await db.query(`insert into public.tenant_personalization values
      ($1, $2), ($3, '')`, [
      T_A,
      "[Growth strategy preferences]\n90-day priority: More users\nMonthly ads and tools budget: $0\n\nCard 4242 4242 4242 4242\n[/Growth strategy preferences]",
      T_B,
    ]);
    const mig = readFileSync(resolve(MIG, "20261005120100_personalization_instructions_to_rule_suggestions.sql"), "utf8");
    await db.query(mig);
    await db.query(mig);
    const rows = (await db.query(
      `select tenant_id, text, status, origin, suggested_by from public.tenant_rules order by text`,
    )).rows;
    expect(rows).toEqual([
      { tenant_id: T_A, text: "90-day priority: More users", status: "suggested", origin: "moved_from_personalization", suggested_by: "zavi" },
      { tenant_id: T_A, text: "Monthly ads and tools budget: $0", status: "suggested", origin: "moved_from_personalization", suggested_by: "zavi" },
    ]);
  });
});
