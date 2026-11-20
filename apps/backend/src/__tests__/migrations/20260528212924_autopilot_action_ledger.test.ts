import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260528212924_autopilot_action_ledger.sql"),
  "utf-8",
);

describe("20260528212924_autopilot_action_ledger.sql", () => {
  it("creates autopilot_action_ledger with an action CHECK + evidence jsonb", () => {
    expect(sql).toMatch(/create table if not exists autopilot_action_ledger/i);
    expect(sql).toMatch(/action\s+text not null/i);
    expect(sql).toMatch(/check \(action in \(/i);
    expect(sql).toMatch(/evidence\s+jsonb not null default '\{\}'::jsonb/i);
  });

  it("FK ON DELETE CASCADE from tenants + soft link to conductor_runs", () => {
    expect(sql).toMatch(/tenant_id\s+uuid not null references tenants\(id\) on delete cascade/i);
    expect(sql).toMatch(/conductor_run_id\s+uuid references conductor_runs\(id\) on delete set null/i);
  });

  it("RLS enabled + member-select policy", () => {
    expect(sql).toMatch(/alter table autopilot_action_ledger enable row level security/i);
    expect(sql).toMatch(/create policy autopilot_action_ledger_select on autopilot_action_ledger/i);
  });

  it("is WORM: a BEFORE UPDATE OR DELETE trigger raises (blocks even service-role)", () => {
    expect(sql).toMatch(/create or replace function autopilot_action_worm_guard\(\)/i);
    expect(sql).toMatch(/raise exception 'autopilot_action_ledger is append-only/i);
    expect(sql).toMatch(/before update or delete on autopilot_action_ledger/i);
  });

  it("append RPC is the only write path: security definer + service_role-only", () => {
    expect(sql).toMatch(/create or replace function append_autopilot_action\(/i);
    expect(sql).toMatch(/language plpgsql security definer set search_path = public/i);
    expect(sql).toMatch(/grant execute on function append_autopilot_action\(.*\) to service_role/i);
    expect(sql).not.toMatch(/grant execute on function append_autopilot_action\(.*\) to authenticated/i);
  });
});
