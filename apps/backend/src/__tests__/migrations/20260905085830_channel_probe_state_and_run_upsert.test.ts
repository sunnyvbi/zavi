
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf-8");

const FIX = read("20260905085830_channel_probe_state_and_run_upsert.sql");
const ORIGIN = read("20260901200000_tenant_channels.sql");

describe("20260905085830 — probe state + guarded upsert", () => {
  it("adds both probe columns idempotently", () => {
    expect(FIX).toMatch(/add column if not exists last_probe_at\s+timestamptz/i);
    expect(FIX).toMatch(/add column if not exists last_probe_delta jsonb/i);
  });

  it("upserts on the table's real primary key", () => {
    expect(ORIGIN).toMatch(/primary key \(tenant_id, channel_slug\)/i);
    expect(FIX).toMatch(/on conflict \(tenant_id, channel_slug\) do update/i);
    expect(FIX).toMatch(/insert into tenant_channels \(tenant_id, channel_slug, work_state, last_run_at\)/i);
  });

  it("guards work_state against an older run finishing late", () => {
    expect(FIX).toMatch(/when tenant_channels\.last_run_at is null/i);
    expect(FIX).toMatch(/or v_at >= tenant_channels\.last_run_at/i);
    expect(FIX).toMatch(/else tenant_channels\.work_state/i);
    expect(FIX).toMatch(/last_run_at = greatest\(coalesce\(tenant_channels\.last_run_at, v_at\), v_at\)/i);
  });

  it("keeps the security posture of the function it replaces", () => {
    expect(FIX).toMatch(/security definer set search_path = public, pg_temp/i);
    expect(FIX).toMatch(/if p_tenant_id is distinct from v_tenant then/i);
    expect(FIX).toMatch(/raise exception 'record_channel_run: run % belongs to tenant %, not %'/i);
    expect(FIX).toMatch(/revoke all on function record_channel_run\(uuid, uuid\) from public, anon, authenticated/i);
    expect(FIX).toMatch(/grant execute on function record_channel_run\(uuid, uuid\) to service_role/i);
  });

  it("pins the defect: the function it replaces could not create a row", () => {
    const body = ORIGIN.slice(
      ORIGIN.indexOf("create or replace function record_channel_run"),
    );
    expect(body).toMatch(/update tenant_channels\s+set work_state/i);
    expect(body).not.toMatch(/insert into tenant_channels/i);
    expect(ORIGIN).toMatch(/insert into tenant_channels[\s\S]*on conflict/i);
  });

  it("does NOT add a third backfill", () => {
    expect(FIX).not.toMatch(/insert into tenant_channels[\s\S]*select[\s\S]*from tenants/i);
  });
});
