import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(dir, "20260927130000_no_charge_on_failed_runs.sql"), "utf8");
const prior = readFileSync(join(dir, "20260924130200_setup_draft_admission_bridge.sql"), "utf8");
const fnOf = (src: string, name: string) => {
  const at = src.indexOf(`create or replace function ${name}(`);
  return src.slice(at, src.indexOf("$$;", at));
};
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const next = fnOf(sql, "finalize_run_credits");

const NEW_GUARD =
  /\s*-- A run that did not finish its work never charges the tenant[\s\S]*?\n\s*if p_cost_usd is null or p_cost_usd <= 0\s+or coalesce\(p_terminal_reason, ''\) not in \('success', 'paused_awaiting_approval'\) then\n/;

describe("20260927130000_no_charge_on_failed_runs", () => {
  it("refunds every terminal status except success and paused_awaiting_approval", () => {
    expect(next).toMatch(NEW_GUARD);
  });

  it("is the 20260924130200 body with ONLY the refund condition changed", () => {
    const stripped = next.replace(NEW_GUARD, "\n  if p_cost_usd is null or p_cost_usd <= 0 then\n");
    expect(norm(stripped)).toBe(norm(fnOf(prior, "finalize_run_credits")));
  });

  it("keeps the function service-role only", () => {
    expect(next).toMatch(/security definer set search_path = public, pg_temp/);
    expect(sql).toContain("revoke all on function finalize_run_credits(uuid, numeric, text) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function finalize_run_credits(uuid, numeric, text) to service_role;");
  });
});
