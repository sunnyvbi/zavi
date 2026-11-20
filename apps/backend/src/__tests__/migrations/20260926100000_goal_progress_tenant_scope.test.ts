import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations");
const raw = readFileSync(join(MIGRATIONS_DIR, "20260926100000_goal_progress_tenant_scope.sql"), "utf8");
const sql = raw
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .toLowerCase();
const defs = sql
  .split("create or replace function public.update_goal_progress")
  .slice(1)
  .map((d) => d.slice(0, d.indexOf("end $$;") + 7));
const threeArg = defs.find((d) => /p_tenant_id\s+uuid/.test(d)) ?? "";
const twoArg = defs.find((d) => !/p_tenant_id/.test(d)) ?? "";

describe("goal_progress_tenant_scope migration", () => {
  it("defines update_goal_progress(p_tenant_id, p_goal_id, p_current_value)", () => {
    expect(sql).toMatch(
      /create or replace function public\.update_goal_progress\(\s*p_tenant_id\s+uuid,\s*p_goal_id\s+uuid,\s*p_current_value\s+numeric\s*\)/,
    );
  });

  it("keeps SECURITY DEFINER with search_path pinned to public, pg_temp", () => {
    expect(threeArg).toMatch(/security definer set search_path = public, pg_temp/);
  });

  it("filters the read and both updates by the tenant", () => {
    expect(threeArg).toMatch(/from autopilot_goals where id = p_goal_id and tenant_id = p_tenant_id;/);
    expect((threeArg.match(/where id = p_goal_id and tenant_id = p_tenant_id;/g) ?? []).length).toBe(3);
    expect(sql).not.toMatch(/where id = p_goal_id;/);
    expect(threeArg).toMatch(/p_tenant_id is null or p_goal_id is null or p_current_value is null/);
  });

  it("keeps the met flip and the terminal-status guard", () => {
    expect(sql).toMatch(/case when p_current_value >= v_target then 'met' else status end/);
    expect(sql).toMatch(/if v_status = 'met' or v_status = 'missed' then/);
  });

  it("revokes from public, anon, authenticated and grants service_role on the new signature", () => {
    expect(sql).toMatch(
      /revoke all on function public\.update_goal_progress\(uuid, uuid, numeric\) from public, anon, authenticated;/,
    );
    expect(sql).toMatch(/grant execute on function public\.update_goal_progress\(uuid, uuid, numeric\) to service_role;/);
  });

  it("keeps the (uuid, numeric) overload as a no-op shim, not a drop", () => {
    expect(defs).toHaveLength(2);
    expect(sql).not.toMatch(/drop function/);
    expect(twoArg).toMatch(/^\(\s*p_goal_id\s+uuid,\s*p_current_value\s+numeric\s*\)/);
    expect(twoArg).toMatch(/security definer set search_path = public, pg_temp/);
    expect(twoArg).not.toMatch(/\b(update|insert|delete)\b/);
    expect(twoArg).toMatch(/begin\s+return;\s+end \$\$;/);
    expect(sql).toMatch(
      /revoke all on function public\.update_goal_progress\(uuid, numeric\) from public, anon, authenticated;/,
    );
    expect(sql).toMatch(/grant execute on function public\.update_goal_progress\(uuid, numeric\) to service_role;/);
  });
});
