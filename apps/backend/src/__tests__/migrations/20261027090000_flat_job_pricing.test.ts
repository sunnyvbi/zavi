import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(dir, "20261027090000_flat_job_pricing.sql"), "utf8");
const prior = readFileSync(join(dir, "20261016130000_credit_settle_records_window_generation.sql"), "utf8");
const fnOf = (src: string, name: string) => {
  const at = src.indexOf(`create or replace function ${name}(`);
  return src.slice(at, src.indexOf("$$;", at));
};
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const next = fnOf(sql, "finalize_run_credits");

const OLD_LINE = "v_credits := ceil(p_cost_usd / 0.0025)::int;";
const NEW_BLOCK = /\n\s*-- Flat price per job type[\s\S]*?v_credits := ceil\(p_cost_usd \/ 0\.0025\)::int;\n\s*end if;\n/;

describe("20261027090000_flat_job_pricing", () => {
  it("adds a nullable billed_credits column to agent_runs", () => {
    expect(sql).toMatch(/alter table agent_runs add column if not exists billed_credits int;/);
    expect(sql).not.toMatch(/billed_credits int not null/);
  });

  it("is the 20261016130000 body with ONLY the v_flat declaration and the v_credits line changed", () => {
    expect(next).toMatch(NEW_BLOCK);
    const stripped = next.replace(NEW_BLOCK, `\n  ${OLD_LINE}\n`).replace(/\n\s*v_flat\s+int;/, "");
    expect(norm(stripped)).toBe(norm(fnOf(prior, "finalize_run_credits")));
  });

  it("reads the run's price and honours the off switch (unset = on)", () => {
    expect(next).toMatch(/select r\.billed_credits into v_flat from agent_runs r where r\.id = p_run_id;/);
    expect(next).toMatch(/coalesce\(\(select blob->>'flat_job_pricing' from system_config where id = 1\), 'true'\) <> 'false'/);
  });

  it("refunds failed / zero-cost runs BEFORE the flat price is consulted", () => {
    expect(next.indexOf("not in ('success', 'paused_awaiting_approval')")).toBeGreaterThan(-1);
    expect(next.indexOf("not in ('success', 'paused_awaiting_approval')")).toBeLessThan(next.indexOf("into v_flat"));
  });

  it("keeps the function service-role only and reloads the PostgREST schema", () => {
    expect(next).toMatch(/security definer set search_path = public, pg_temp/);
    expect(sql).toContain("revoke all on function finalize_run_credits(uuid, numeric, text) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function finalize_run_credits(uuid, numeric, text) to service_role;");
    expect(sql).toContain("notify pgrst, 'reload schema';");
  });
});
