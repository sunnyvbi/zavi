import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.CUSTOM_AGENT_NOTES_PG_URL;
const MIG = resolve(__dirname, "../../../../../supabase/migrations");
const T_A = "11111111-1111-4111-8111-111111111111";
const T_B = "22222222-2222-4222-8222-222222222222";
const AG_A = "44444444-4444-4444-8444-444444444444";
const AG_B = "55555555-5555-4555-8555-555555555555";
const AG_A2 = "66666666-6666-4666-8666-666666666666";
const USER = "aaaaaaaa-0000-4000-8000-000000000001";
const N_OWN = "a0000000-0000-4000-8000-000000000001";
const N_B = "a0000000-0000-4000-8000-000000000002";
const N_OTHER = "a0000000-0000-4000-8000-000000000003";
const N_HUMAN = "a0000000-0000-4000-8000-000000000004";

describe.skipIf(!url)("delete_custom_agent_note on real Postgres", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  beforeAll(async () => {
    const { Client } = await import("pg");
    db = new Client({ connectionString: url });
    await db.connect();
    const s1 = readFileSync(resolve(MIG, "20260926120000_custom_agents.sql"), "utf8");
    const i = s1.indexOf("create or replace function _custom_agent_authorize");
    const authorize = s1.slice(i, s1.indexOf("end $$;", i) + "end $$;".length);
    await db.query(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.ctx(uid uuid, role text);
      insert into auth.ctx values ('${USER}', 'authenticated');
      create function auth.uid() returns uuid language sql stable as $$ select uid from auth.ctx $$;
      create function auth.role() returns text language sql stable as $$ select role from auth.ctx $$;
      create table tenants(id uuid primary key);
      create table tenant_users(user_id uuid, tenant_id uuid);
      create table custom_agents(id uuid primary key, tenant_id uuid);
      create table agent_runs(id uuid primary key, tenant_id uuid);
      create table memory_note(id uuid primary key, tenant_id uuid not null, title text not null default '',
        body_markdown text not null default '', source text, note_type text default 'untyped',
        trust_tier int default 2, slug text, created_at timestamptz default now(), updated_at timestamptz default now());
    `);
    await db.query(readFileSync(resolve(MIG, "20260630003538_memory_mutation_audit.sql"), "utf8"));
    await db.query(authorize);
    await db.query(readFileSync(resolve(MIG, "20260927220100_custom_agent_brain_notes.sql"), "utf8"));
    await db.query(`
      insert into tenants values ('${T_A}'), ('${T_B}');
      insert into tenant_users values ('${USER}', '${T_A}');
      insert into custom_agents values ('${AG_A}', '${T_A}'), ('${AG_B}', '${T_B}'), ('${AG_A2}', '${T_A}');
      insert into memory_note(id, tenant_id, title, body_markdown, source, custom_agent_id) values
        ('${N_OWN}', '${T_A}', 'Secret title', 'secret body', 'agent_run', '${AG_A}'),
        ('${N_B}', '${T_B}', 'B', 'b', 'agent_run', '${AG_B}'),
        ('${N_OTHER}', '${T_A}', 'Other agent', 'b', 'agent_run', '${AG_A2}'),
        ('${N_HUMAN}', '${T_A}', 'Human note', 'b', 'human', null);
    `);
  });
  afterAll(async () => {
    await db?.end();
  });

  const asMember = async (tenant: string, agent: string, note: string) => {
    await db.query("set role authenticated");
    try {
      const r = await db.query("select delete_custom_agent_note($1, $2, $3) as ok", [tenant, agent, note]);
      return r.rows[0].ok as boolean;
    } finally {
      await db.query("reset role");
    }
  };
  const audits = async () => (await db.query("select * from memory_mutation_audit order by created_at")).rows;

  it("another agent's note and a human note: nothing deleted, no audit", async () => {
    expect(await asMember(T_A, AG_A, N_OTHER)).toBe(false);
    expect(await asMember(T_A, AG_A, N_HUMAN)).toBe(false);
    expect(await audits()).toHaveLength(0);
  });

  it("another tenant: refused, nothing deleted, no audit", async () => {
    await expect(asMember(T_B, AG_B, N_B)).rejects.toThrow(/not a member/);
    expect((await db.query("select 1 from memory_note where id = $1", [N_B])).rowCount).toBe(1);
    expect(await audits()).toHaveLength(0);
  });

  it("its own note: deleted, with exactly one redacted audit row", async () => {
    expect(await asMember(T_A, AG_A, N_OWN)).toBe(true);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: T_A, note_id: N_OWN, actor_user_id: USER, action: "delete" });
    const snap = rows[0].before_snapshot;
    expect(snap).toMatchObject({ redaction: "rtbf_delete", note_id: N_OWN, source: "agent_run", note_type: "untyped", trust_tier: 2 });
    expect(snap.title_sha256).toBe(createHash("sha256").update("Secret title", "utf8").digest("hex").slice(0, 16));
    expect(JSON.stringify(snap)).not.toMatch(/Secret title|secret body/);
    expect(await asMember(T_A, AG_A, N_OWN)).toBe(false);
    expect(await audits()).toHaveLength(1);
  });

  it("anon cannot call it at all", async () => {
    await db.query("set role anon");
    try {
      await expect(db.query("select delete_custom_agent_note($1, $2, $3)", [T_A, AG_A, N_OTHER])).rejects.toThrow(/permission denied/);
    } finally {
      await db.query("reset role");
    }
  });
});
