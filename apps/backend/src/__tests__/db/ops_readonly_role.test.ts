import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.OPS_ROLE_PG_URL;
const MIG = resolve(__dirname, "../../../../../supabase/migrations");

describe.skipIf(!url)("zavi_ops role on real Postgres", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let admin: any, ops: any;
  beforeAll(async () => {
    const { Client } = await import("pg");
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`
      drop schema if exists ops cascade;
      drop table if exists public.agent_runs, public.tenants, public.memory_note;
      do $$ begin
        if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
        if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      end $$;
      create table public.tenants(id uuid primary key default gen_random_uuid(), slug text, display_name text,
        kind text, tier text, created_at timestamptz default now(), deleted_at timestamptz);
      create table public.memory_note(id uuid primary key default gen_random_uuid(), tenant_id uuid, note_type text,
        source text, trust_tier int, agent_slug text, created_at timestamptz default now(), archived_at timestamptz,
        body_markdown text);
      create table public.agent_runs(id uuid primary key default gen_random_uuid(), tenant_id uuid, agent_slug text,
        trigger text, status text, enqueued_at timestamptz default now(), started_at timestamptz, finished_at timestamptz,
        error text, cost_usd numeric, input_tokens int, output_tokens int, cache_read_tokens int,
        cache_creation_tokens int, model_used text, outcome jsonb, channel_slug text, custom_agent_id uuid,
        parent_run_id uuid, batch_id uuid, output_text text, reasoning_text text, prompt_snapshot text,
        raw_response_text text, tool_calls jsonb, parsed jsonb, payload jsonb);
      alter table public.agent_runs enable row level security;
      insert into public.agent_runs(tenant_id, agent_slug, status, prompt_snapshot, output_text, error)
        values (gen_random_uuid(), 'operator', 'success', repeat('x', 100000), 'hello', (select string_agg(md5(random()::text), '') from generate_series(1, 2000))),
               (gen_random_uuid(), 'operator', 'failed', null, null, 'short failure');
    `);
    await admin.query(readFileSync(resolve(MIG, "20260930180000_ops_readonly_role.sql"), "utf8"));
    await admin.query(`alter role zavi_ops password 'test-only'`);
    ops = new Client({ connectionString: url!.replace("postgres@", "zavi_ops:test-only@") });
    await ops.connect();
  });
  afterAll(async () => {
    await ops?.end();
    await admin?.end();
  });

  it("logs in with the role's own settings", async () => {
    expect((await ops.query("show statement_timeout")).rows[0].statement_timeout).toBe("15s");
    expect((await ops.query("show default_transaction_read_only")).rows[0].default_transaction_read_only).toBe("on");
  });

  it("reads sizes across tenants through ops, despite RLS on the base table", async () => {
    const r = await ops.query("select prompt_bytes, error, error_bytes from ops.agent_runs order by status desc");
    expect(r.rows).toHaveLength(2);
    expect(Number(r.rows[0].prompt_bytes)).toBeGreaterThan(0);
    expect(r.rows[0].error).toBeNull();
    expect(r.rows[1].error).toBe("short failure");
  });

  it("cannot read the base table", async () => {
    await expect(ops.query("select prompt_snapshot from public.agent_runs")).rejects.toThrow(/permission denied/);
  });

  it("cannot create objects in ops", async () => {
    await expect(ops.query("create table ops.x(i int)")).rejects.toThrow(/read-only|permission denied/);
  });

  it("read-only mode blocks a write even where a grant would allow it", async () => {
    await admin.query("create table if not exists ops.write_probe(i int); grant insert on ops.write_probe to zavi_ops;");
    await expect(ops.query("insert into ops.write_probe values (1)")).rejects.toThrow(/read-only transaction/);
    await admin.query("drop table ops.write_probe");
  });

  it("the statement timeout actually fires", async () => {
    await expect(ops.query("select pg_sleep(16)")).rejects.toThrow(/statement timeout/);
  }, 20_000);

  it("anon and authenticated cannot read ops", async () => {
    for (const role of ["anon", "authenticated"]) {
      await admin.query("begin");
      await admin.query(`set local role ${role}`);
      await expect(admin.query("select 1 from ops.agent_runs")).rejects.toThrow(/permission denied/);
      await admin.query("rollback");
    }
  });
});
