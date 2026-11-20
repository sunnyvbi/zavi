import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260528165203_conductor_runs.sql"),
  "utf-8",
);

describe("20260528165203_conductor_runs.sql", () => {
  it("creates conductor_runs with a status CHECK + numeric spend/max", () => {
    expect(sql).toMatch(/create table if not exists conductor_runs/i);
    expect(sql).toMatch(/status\s+text not null default 'active'/i);
    expect(sql).toMatch(/check \(status in \('active', 'halted', 'done', 'failed'\)\)/i);
    expect(sql).toMatch(/spend_usd\s+numeric not null default 0/i);
    expect(sql).toMatch(/max_usd\s+numeric/i);
  });

  it("FK ON DELETE CASCADE from tenants", () => {
    expect(sql).toMatch(/tenant_id\s+uuid not null references tenants\(id\) on delete cascade/i);
  });

  it("RLS enabled + member-select policy (operator-facing, not raw PII)", () => {
    expect(sql).toMatch(/alter table conductor_runs enable row level security/i);
    expect(sql).toMatch(/create policy conductor_runs_select on conductor_runs/i);
  });

  it("defines the per-conductor cap RPC as security definer + service_role-only", () => {
    expect(sql).toMatch(
      /create or replace function consume_conductor_budget_or_reject\(\s*p_conductor_run_id uuid,\s*p_estimate_usd\s+numeric/i,
    );
    expect(sql).toMatch(/language plpgsql security definer set search_path = public/i);
    expect(sql).toMatch(/revoke all on function consume_conductor_budget_or_reject\(uuid, numeric\) from public/i);
    expect(sql).toMatch(/grant execute on function consume_conductor_budget_or_reject\(uuid, numeric\) to service_role/i);
  });

  it("cap check is INSIDE the UPDATE WHERE (atomic, no read-then-write race)", () => {
    expect(sql).toMatch(/set spend_usd = spend_usd \+ p_estimate_usd/i);
    expect(sql).toMatch(/and \(max_usd is null or spend_usd \+ p_estimate_usd <= max_usd\)/i);
    expect(sql).toMatch(/set status = 'halted'/i);
  });

  it("does NOT reuse the per-tenant daily cap (consume_budget_or_reject) — the corrected money-path design", () => {
    const ddl = sql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(ddl).not.toMatch(/consume_budget_or_reject/i);
  });
});
