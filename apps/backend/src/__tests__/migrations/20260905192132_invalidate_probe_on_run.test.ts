
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf-8");

const FIX = read("20260905192132_invalidate_probe_on_run.sql");
const PRIOR = read("20260905085830_channel_probe_state_and_run_upsert.sql");

describe("20260905192132 — invalidate the probe verdict on a run", () => {
  it("nulls both probe fields", () => {
    expect(FIX).toMatch(/last_probe_at\s*=\s*case/i);
    expect(FIX).toMatch(/last_probe_delta\s*=\s*case/i);
  });

  it("only invalidates when the run actually moves the anchor FORWARD", () => {
    const clauses = FIX.match(/when tenant_channels\.last_run_at is null\s*\n\s*or v_at > tenant_channels\.last_run_at/gi);
    expect(clauses, "expected a strict > guard on each probe field").toHaveLength(2);
    expect(FIX).toMatch(/then null[\s\S]{0,80}else tenant_channels\.last_probe_at/i);
    expect(FIX).toMatch(/then null[\s\S]{0,80}else tenant_channels\.last_probe_delta/i);
  });

  it("keeps the upsert and the security posture it inherited", () => {
    expect(FIX).toMatch(/on conflict \(tenant_id, channel_slug\) do update/i);
    expect(FIX).toMatch(/security definer set search_path = public, pg_temp/i);
    expect(FIX).toMatch(/if p_tenant_id is distinct from v_tenant then/i);
    expect(FIX).toMatch(/grant execute on function record_channel_run\(uuid, uuid\) to service_role/i);
  });

  it("pins the defect: the version it replaces never touched the probe fields", () => {
    const body = PRIOR.slice(PRIOR.indexOf("create or replace function record_channel_run"));
    expect(body).not.toMatch(/last_probe_at\s*=/i);
    expect(body).not.toMatch(/last_probe_delta\s*=/i);
  });

  it("documents why it invalidates rather than recomputing", () => {
    expect(FIX).toMatch(/no_baseline/);
    expect(FIX).toMatch(/41 5 \* \* \*/);
  });
});
