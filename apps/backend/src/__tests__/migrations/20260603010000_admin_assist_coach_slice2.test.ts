import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260603010000_admin_assist_coach_slice2.sql"),
  "utf-8",
);

describe("20260603010000_admin_assist_coach_slice2.sql", () => {
  it("widens the kind CHECK to include coach (keeps enrichment+unblock)", () => {
    expect(sql).toMatch(/check \(kind in \('enrichment','unblock','coach'\)\)/i);
  });

  it("adds explicit coach context columns (not key-encoded)", () => {
    expect(sql).toMatch(/add column if not exists agent_slug/i);
    expect(sql).toMatch(/add column if not exists detector/i);
    expect(sql).toMatch(/add column if not exists started_at/i);
    expect(sql).toMatch(/add column if not exists completed_at/i);
  });

  it("cooldown RPC takes an advisory lock keyed on tenant+agent+detector", () => {
    expect(sql).toMatch(/pg_advisory_xact_lock\(\s*hashtextextended\('coach:'\|\|p_tenant_id/i);
  });

  it("the idempotency key is TENANT-SCOPED (includes p_tenant_id)", () => {
    expect(sql).toMatch(/v_key\s*:=\s*'coach:'\|\|p_tenant_id/i);
    expect(sql).not.toMatch(/v_key\s*:=\s*'coach:'\|\|p_detector/i);
  });

  it("has a cooldown guard (suppress open OR recent-resolved within cooldown)", () => {
    expect(sql).toMatch(/state not in \('resolved','dismissed'\)/i);
    expect(sql).toMatch(/created_at > now\(\) - make_interval\(hours => p_cooldown_hours\)/i);
  });

  it("does NOT reuse admin_task_create_once (permanent suppression) for coach", () => {
    expect(sql).not.toMatch(/create or replace function admin_task_create_once/i);
    expect(sql).toMatch(/create or replace function admin_task_create_with_cooldown/i);
  });

  it("cooldown RPC is security definer, revoked from public, granted service_role only", () => {
    expect(sql).toMatch(/admin_task_create_with_cooldown[\s\S]*security definer set search_path = public/i);
    expect(sql).toMatch(/revoke all on function admin_task_create_with_cooldown\([^)]*\) from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function admin_task_create_with_cooldown\([^)]*\) to service_role/i);
  });
});
