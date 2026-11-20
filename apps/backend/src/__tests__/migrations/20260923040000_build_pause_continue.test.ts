import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const SQL = readFileSync(join(DIR, "20260923040000_build_pause_continue.sql"), "utf-8");

describe("build pause/continue (20260923040000)", () => {
  it("adds 'paused' to the status check, keeping every prior value", () => {
    const m = SQL.match(/check \(status in \(([^)]*)\)\)/);
    expect(m).not.toBeNull();
    const values = m![1].split(",").map((v) => v.trim().replace(/'/g, ""));
    expect(values).toEqual(
      expect.arrayContaining(["provisioning", "active", "halted", "done", "failed", "proposed", "paused"]),
    );
  });

  it("this is the latest definition of conductor_runs_status_check", () => {
    const definers = readdirSync(DIR)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => /add constraint conductor_runs_status_check/.test(readFileSync(join(DIR, f), "utf-8")))
      .sort();
    expect(definers.at(-1)).toBe("20260923040000_build_pause_continue.sql");
  });

  it("adds paused_at", () => {
    expect(SQL).toMatch(/add column if not exists paused_at timestamptz/);
  });

  it("Continue flips under the same per-tenant build lock a new build takes, service role only", () => {
    const f = SQL.slice(SQL.indexOf("create or replace function continue_paused_build("));
    expect(f).toMatch(/pg_advisory_xact_lock\(hashtextextended\('build:' \|\| p_tenant_id::text, 0\)\)/);
    expect(f).toMatch(/status in \('provisioning', 'active'\)/);
    expect(f).toMatch(/and status = 'paused'\s+and updated_at = p_expected_updated_at/);
    expect(SQL).toMatch(/revoke all on function continue_paused_build\(uuid, uuid, timestamptz, jsonb\) from public, anon, authenticated;/);
    expect(SQL).toMatch(/grant execute on function continue_paused_build\(uuid, uuid, timestamptz, jsonb\) to service_role;/);
  });
  it("under the lock, a newer fresh build in ANY status supersedes (refines do not)", () => {
    const f = SQL.slice(SQL.indexOf("create or replace function continue_paused_build("));
    expect(f).toMatch(/n\.created_at > me\.created_at/);
    expect(f).toMatch(/coalesce\(n\.goal_graph->0->'payload'->>'refine_mode', ''\) <> 'true'/);
    expect(f).toMatch(/coalesce\(n\.objective, ''\) not like '\[refine\]%'/);
    expect(f.indexOf("return 'superseded'")).toBeLessThan(f.indexOf("return 'another_build_running'"));
    expect(f.indexOf("pg_advisory_xact_lock")).toBeLessThan(f.indexOf("return 'superseded'"));
  });

  it("uses the same lock key as try_acquire_build_slot", () => {
    const slot = readFileSync(join(DIR, "20260706170000_refine_daily_bucket_discriminator.sql"), "utf-8");
    expect(slot).toContain("pg_advisory_xact_lock(hashtextextended('build:' || p_tenant_id::text, 0))");
  });
});
