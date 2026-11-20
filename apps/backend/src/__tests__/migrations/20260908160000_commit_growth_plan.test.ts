import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260908160000_commit_growth_plan.sql"),
  "utf8",
);

describe("20260908160000_commit_growth_plan.sql", () => {
  it("grants execute to service_role, not just revoking from everyone else", () => {
    expect(sql).toMatch(
      /grant execute on function commit_growth_plan\(uuid, text, text, text, text, jsonb, text, text\)\s*\n?\s*to service_role/i,
    );
  });

  it("still revokes from public, anon and authenticated", () => {
    expect(sql).toMatch(
      /revoke all on function commit_growth_plan\([^)]*\)\s*\n?\s*from public, anon, authenticated/i,
    );
  });

  it("repairs the same missing grant on the three functions it depends on", () => {
    for (const fn of ["set_growth_plan", "set_growth_plan_bet", "log_growth_plan_change"]) {
      expect(sql, `${fn} must be granted to service_role`).toMatch(
        new RegExp(`grant execute on function ${fn}\\([^)]*\\)\\s*\\n?\\s*to service_role`, "i"),
      );
    }
  });

  it("refuses to write a plan when no bet is selectable", () => {
    const fn = sql.slice(sql.indexOf("create or replace function commit_growth_plan("));
    const guard = fn.slice(0, fn.indexOf("v_plan_id := set_growth_plan("));
    expect(guard).toMatch(/jsonb_array_elements\(coalesce\(p_bets/i);
    expect(guard).toMatch(/\)\s*=\s*0 then\s*\n\s*return null;/i);
  });

  it("keeps the security-definer posture", () => {
    const fn = sql.slice(sql.indexOf("create or replace function commit_growth_plan("));
    expect(fn).toMatch(/security definer set search_path = public, pg_temp/i);
  });

  it("derives bet order from array position, never from a field in the payload", () => {
    const fn = sql.slice(sql.indexOf("create or replace function commit_growth_plan("));
    expect(fn).not.toMatch(/b->>'sort_order'|bet->>'sort_order'|->>'priority'/i);
    expect(fn).toMatch(/v_i := v_i \+ 1/);
  });

  it("never flips a founder's autorun switch back on", () => {
    const fn = sql.slice(sql.indexOf("create or replace function commit_growth_plan("));
    expect(fn).toMatch(/if v_prev_set = 'founder' then/i);
    expect(fn).toMatch(/case when autorun_set_by = 'founder' then autorun else false end/i);
  });
});
