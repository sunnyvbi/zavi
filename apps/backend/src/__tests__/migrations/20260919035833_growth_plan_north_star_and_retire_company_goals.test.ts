import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260919035833_growth_plan_north_star_and_retire_company_goals.sql",
  ),
  "utf8",
);
const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("20260919035833_growth_plan_north_star_and_retire_company_goals.sql", () => {
  it("renames the plan's column to north_star_metric", () => {
    expect(code).toMatch(/alter table growth_plan rename column target_metric to north_star_metric/i);
  });

  it("re-creates set_growth_plan on the SAME signature writing the new column", () => {
    expect(code).toMatch(/create or replace function set_growth_plan\(\s*p_tenant_id\s+uuid,\s*p_objective\s+text,\s*p_target_metric\s+text,\s*p_constraint_statement\s+text,\s*p_constraint_confidence text,\s*p_basis_evidence\s+jsonb,\s*p_actor_kind\s+text,\s*p_actor_ref\s+text\s*\)/i);
    expect(code).toMatch(/tenant_id, objective, north_star_metric,/i);
    expect(code).not.toMatch(/objective, target_metric,/i);
    expect(code).toMatch(/security definer set search_path = public, pg_temp/i);
    expect(code).toMatch(/revoke all on function set_growth_plan\(uuid, text, text, text, text, jsonb, text, text\)\s+from public, anon, authenticated/i);
    expect(code).toMatch(/grant execute on function set_growth_plan\(uuid, text, text, text, text, jsonb, text, text\)\s+to service_role/i);
  });

  it("refuses the retired company_goals fact on every new write", () => {
    expect(code).toMatch(/add constraint tenant_fact_company_goals_retired\s+check \(key <> 'company_goals'\) not valid/i);
  });
});
