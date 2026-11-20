import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

const db = new PGlite();
const tenant = "00000000-0000-4000-8000-000000000001";
const run = "00000000-0000-4000-8000-000000000002";
beforeAll(async () => {
  await db.exec(`create table agent_runs(id uuid primary key, tenant_id uuid, channel_slug text, status text, finished_at timestamptz, started_at timestamptz, enqueued_at timestamptz);
    create table tenant_channels(tenant_id uuid, channel_slug text, work_state text, last_run_at timestamptz, last_probe_at timestamptz, last_probe_delta jsonb, updated_at timestamptz, primary key(tenant_id,channel_slug));`);
  const sql = readFileSync(resolve(__dirname, "../../../../../../supabase/migrations/20260905192132_invalidate_probe_on_run.sql"), "utf8");
  const start = sql.indexOf("create or replace function record_channel_run(");
  await db.exec(sql.slice(start, sql.indexOf("end $$;", start) + "end $$;".length));
}, 15000);
afterAll(async () => { await db.close(); });

it("reflects a stamped run's running and terminal state, and preserves a newer cache anchor", async () => {
  await db.query("insert into agent_runs values ($1,$2,'linkedin_organic','running',null,'2026-11-18T08:00:00Z','2026-11-18T08:00:00Z')", [run,tenant]);
  await db.query("select record_channel_run($1,$2)",[tenant,run]);
  expect((await db.query("select work_state from tenant_channels")).rows[0]).toEqual({work_state:"running"});
  await db.query("update agent_runs set status='success',finished_at='2026-11-18T08:01:00Z' where id=$1",[run]);
  await db.query("select record_channel_run($1,$2)",[tenant,run]);
  expect((await db.query("select work_state from tenant_channels")).rows[0]).toEqual({work_state:"delivered"});
  await db.exec("update tenant_channels set work_state='running',last_run_at='2026-11-18T08:02:00Z'");
  await db.query("select record_channel_run($1,$2)",[tenant,run]);
  expect((await db.query("select work_state from tenant_channels")).rows[0]).toEqual({work_state:"running"});
});
it("rejects another tenant and ignores an unstamped run", async () => {
  await expect(db.query("select record_channel_run($1,$2)",["00000000-0000-4000-8000-000000000003",run])).rejects.toThrow(/belongs to tenant/);
  await db.query("update agent_runs set channel_slug=null where id=$1",[run]);
  await db.query("select record_channel_run($1,$2)",[tenant,run]);
  expect((await db.query("select count(*)::int n from tenant_channels")).rows[0]).toEqual({n:1});
});
