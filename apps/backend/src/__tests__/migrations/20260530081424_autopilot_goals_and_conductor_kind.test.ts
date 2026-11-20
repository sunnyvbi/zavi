import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260530081424_autopilot_goals_and_conductor_kind.sql",
  ),
  "utf-8",
);

describe("20260530081424_autopilot_goals_and_conductor_kind.sql", () => {
  it("creates autopilot_goals with status + source CHECK + tenant cascade", () => {
    expect(sql).toMatch(/create table if not exists autopilot_goals/i);
    expect(sql).toMatch(
      /tenant_id\s+uuid not null references tenants\(id\) on delete cascade/i,
    );
    expect(sql).toMatch(/objective\s+text not null/i);
    expect(sql).toMatch(/target_metric\s+text not null/i);
    expect(sql).toMatch(/target_value\s+numeric not null/i);
    expect(sql).toMatch(
      /check \(status in \('active','met','missed','paused'\)\)/i,
    );
    expect(sql).toMatch(
      /check \(source in \('founder','agent_proposed'\)\)/i,
    );
  });

  it("RLS enabled + tenant-member select policy on autopilot_goals", () => {
    expect(sql).toMatch(/alter table autopilot_goals enable row level security/i);
    expect(sql).toMatch(/create policy autopilot_goals_select on autopilot_goals/i);
    expect(sql).not.toMatch(/create policy .* on autopilot_goals\s+for (insert|update|delete)/i);
  });

  it("adds conductor_runs.kind discriminator (default build_app, CHECK to {build_app, company_goal})", () => {
    expect(sql).toMatch(
      /alter table conductor_runs\s+add column if not exists kind text not null default 'build_app'/i,
    );
    expect(sql).toMatch(/check \(kind in \('build_app','company_goal'\)\)/i);
  });

  it("widens conductor_runs.status CHECK to include 'proposed' (PLAN §3.4 staged state)", () => {
    expect(sql).toMatch(/alter table conductor_runs drop constraint if exists conductor_runs_status_check/i);
    expect(sql).toMatch(
      /check \(status in \('provisioning','active','halted','done','failed','proposed'\)\)/i,
    );
  });

  it("set_autopilot_goal RPC: security-definer + service_role-only", () => {
    expect(sql).toMatch(
      /create or replace function set_autopilot_goal\(\s*p_tenant_id\s+uuid,\s*p_objective\s+text,\s*p_target_metric\s+text,\s*p_target_value\s+numeric/i,
    );
    expect(sql).toMatch(/language plpgsql security definer set search_path = public/i);
    expect(sql).toMatch(
      /revoke all on function set_autopilot_goal\(uuid, text, text, numeric, numeric, date, int, text\) from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function set_autopilot_goal\(uuid, text, text, numeric, numeric, date, int, text\) to service_role/i,
    );
  });

  it("update_goal_progress RPC: security-definer + service_role-only + 'met' flip when value >= target", () => {
    expect(sql).toMatch(
      /create or replace function update_goal_progress\(\s*p_goal_id\s+uuid,\s*p_current_value\s+numeric/i,
    );
    expect(sql).toMatch(
      /revoke all on function update_goal_progress\(uuid, numeric\) from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function update_goal_progress\(uuid, numeric\) to service_role/i,
    );
    expect(sql).toMatch(/p_current_value >= v_target/i);
    expect(sql).toMatch(/then 'met'/i);
    expect(sql).toMatch(/v_status = 'met' or v_status = 'missed'/i);
  });

  it("seeds the autopilot.daily-plan decision class (approval-gated by default)", () => {
    expect(sql).toMatch(
      /insert into decision_classes \(slug, description, default_autonomy, dispatch_handler\)/i,
    );
    expect(sql).toMatch(/'autopilot\.daily-plan'/i);
    expect(sql).toMatch(/'approval'/i);
    expect(sql).toMatch(/'autopilot\.daily_plan_approve'/i);
    expect(sql).toMatch(/on conflict \(slug\) do nothing/i);
  });

  it("migration header explicitly distinguishes the re-introduction from the build-app DROP (PLAN §3.1)", () => {
    expect(sql).toMatch(/Re-introduces autopilot_goals/i);
    expect(sql).toMatch(/build-app/i);
    expect(sql).toMatch(/POLSIA/i);
  });
});
