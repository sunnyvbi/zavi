import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const SQL = readFileSync(join(DIR, "20261009110000_resume_build_claims_site.sql"), "utf-8");
const code = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const body = code.slice(code.indexOf("create or replace function continue_paused_build_with_site("), code.indexOf("end $$;"));

describe("Retry claims its site in the resume's own transaction (20261009110000, codex F6)", () => {
  it("takes the per-tenant build lock, then locks THIS run's own site row before resuming", () => {
    const lock = body.indexOf("pg_advisory_xact_lock(hashtextextended('build:' || p_tenant_id::text, 0))");
    const forUpdate = body.indexOf("for update");
    const resume = body.indexOf("v_outcome := continue_paused_build(");
    expect(lock).toBeGreaterThan(0);
    expect(forUpdate).toBeGreaterThan(lock);
    expect(resume).toBeGreaterThan(forUpdate);
    expect(body).toMatch(/s\.tenant_id = p_tenant_id\s+and s\.root_conductor_run_id = p_run_id/);
  });

  it("a gone site, or one whose providers the reaper started on, returns site_gone before anything changes", () => {
    const gone = body.indexOf("return 'site_gone';");
    expect(gone).toBeGreaterThan(0);
    expect(gone).toBeLessThan(body.indexOf("v_outcome := continue_paused_build("));
    expect(body).toMatch(/v_status in \('fell_back_old', 'deleting', 'deleted'\)/);
    expect(body).toMatch(/sp\.state not in \('claimed', 'created'\)/);
  });

  it("moves a failed site to building ONLY when the run resumed, in the same transaction", () => {
    const flip = body.indexOf("set status = 'building', last_error = null");
    expect(flip).toBeGreaterThan(body.indexOf("v_outcome := continue_paused_build("));
    expect(body).toMatch(/if v_outcome = 'resumed' and v_status = 'failed' then/);
    expect(body).toMatch(/where id = p_site_id and tenant_id = p_tenant_id and status = 'failed'/);
  });

  it("an old-flow build (no site) is exactly continue_paused_build", () => {
    expect(body).toMatch(/if p_site_id is null then\s+return continue_paused_build\(p_tenant_id, p_run_id, p_expected_updated_at, p_goal_graph\);/);
  });

  it("is security definer with a pinned search_path, service_role only, and leaves the old function alone", () => {
    expect(SQL).toMatch(/security definer set search_path = public, pg_temp/);
    expect(SQL).toMatch(/revoke all on function continue_paused_build_with_site\(uuid, uuid, timestamptz, jsonb, uuid\) from public, anon, authenticated;/);
    expect(SQL).toMatch(/grant execute on function continue_paused_build_with_site\(uuid, uuid, timestamptz, jsonb, uuid\) to service_role;/);
    expect(code).not.toMatch(/create or replace function continue_paused_build\(/);
  });

  it("a site cannot be failed while its build run is still running (a stale writer's give-back is refused)", () => {
    expect(code).toMatch(/create trigger sites_fail_only_after_run\s+before update of status on public\.sites/);
    const fn = code.slice(code.indexOf("create or replace function public.sites_fail_only_after_run()"));
    expect(fn).toMatch(/new\.status = 'failed'\s+and old\.status in \('provisioning', 'building', 'publishing'\)/);
    expect(fn).toMatch(/r\.status in \('provisioning', 'active'\)/);
    expect(fn).toMatch(/raise exception/);
  });
});
