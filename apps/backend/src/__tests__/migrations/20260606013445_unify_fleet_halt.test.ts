import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260606013445_unify_fleet_halt.sql",
  ),
  "utf-8",
);

describe("20260606013445_unify_fleet_halt.sql", () => {
  it("REBUILDS is_fleet_halted to read system_config.blob.fleet_halt (unified store)", () => {
    expect(sql).toMatch(/drop function if exists is_fleet_halted\(\)/i);
    expect(sql).toMatch(/create (or replace )?function is_fleet_halted\(\)/i);
    expect(sql).toMatch(/system_config/i);
    expect(sql).toMatch(/blob\s*->>\s*'fleet_halt'/i);
    expect(sql).toMatch(/where id\s*=\s*1/i);
  });

  it("is_fleet_halted fail-CLOSED on a MISSING system_config row (halted=true)", () => {
    expect(sql).toMatch(/not exists\s*\(select 1 from system_config where id = 1\)/i);
    expect(sql).toMatch(/then true/i);
  });

  it("is_fleet_halted steady-state (row present, flag ABSENT) → NOT halted (false)", () => {
    expect(sql).toMatch(
      /coalesce\(\s*\(select \(blob->>'fleet_halt'\)::boolean from system_config where id = 1\)\s*,\s*false\s*\)/i,
    );
  });

  it("is_fleet_halted stays granted to authenticated + service_role (banner read)", () => {
    expect(sql).toMatch(
      /grant execute on function is_fleet_halted\(\) to authenticated, service_role/i,
    );
  });

  it("retires the dead switch — drops set_fleet_kill and autopilot_fleet_kill", () => {
    expect(sql).toMatch(/drop function if exists set_fleet_kill\(boolean, text\)/i);
    expect(sql).toMatch(/drop table if exists autopilot_fleet_kill/i);
  });

  it("adds the tenant-scoped customer stop RPC (stop_tenant_autopilot), service-role only", () => {
    expect(sql).toMatch(/create (or replace )?function stop_tenant_autopilot\(/i);
    expect(sql).toMatch(/p_tenant_id\s+uuid/i);
    expect(sql).toMatch(/where[\s\S]*?tenant_id\s*=\s*p_tenant_id/i);
    expect(sql).toMatch(/status\s*=\s*'halted'/i);
    expect(sql).toMatch(/kind\s*=\s*'company_goal'/i);
    expect(sql).toMatch(/status\s+in\s*\(\s*'active'\s*\)/i);
    expect(sql).toMatch(
      /grant execute on function stop_tenant_autopilot\(uuid\) to service_role/i,
    );
    expect(sql).not.toMatch(
      /grant execute on function stop_tenant_autopilot\(uuid\) to authenticated/i,
    );
  });

  it("the customer stop appends a WORM ledger row marked tenant_stop", () => {
    expect(sql).toMatch(/append_autopilot_action/i);
    expect(sql).toMatch(/tenant_stop/i);
  });
});
