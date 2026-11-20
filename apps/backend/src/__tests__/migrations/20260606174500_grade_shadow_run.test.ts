import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260606174500_grade_shadow_run.sql",
);

describe("20260606174500_grade_shadow_run.sql", () => {
  it("migration file exists", () => {
    expect(existsSync(PATH)).toBe(true);
  });

  const sql = readFileSync(PATH, "utf-8");

  it("is an UPDATE-only RPC that touches ONLY comparison_score + comparison_notes", () => {
    expect(sql).toMatch(/create or replace function grade_shadow_run/i);
    expect(sql).toMatch(/update agent_shadow_runs\s+set comparison_score = p_comparison_score,\s*\n?\s*comparison_notes = p_comparison_notes/i);
    expect(sql).not.toMatch(/set\s+(output_text|tool_calls|status|usage|cost_usd|parsed_output)\s*=/i);
    expect(sql).not.toMatch(/insert into agent_shadow_runs/i);
  });

  it("C8 — re-derives tenant from the SOURCE agent_run by join, never a caller param", () => {
    expect(sql).not.toMatch(/grade_shadow_run\([^)]*p_tenant_id/i);
    expect(sql).toMatch(/select ar\.tenant_id, asr\.status into v_tenant, v_status\s*\n?\s*from agent_shadow_runs asr\s*\n?\s*join agent_runs ar on ar\.id = asr\.source_agent_run_id/i);
  });

  it("P0 dogfood gate — rejects any tenant but 73db45ff (errcode 22023, sibling-consistent)", () => {
    expect(sql).toMatch(/v_tenant <> '73db45ff-457e-4541-bc8f-bdb625390204'::uuid/i);
    expect(sql).toMatch(/restricted to the dogfood tenant/i);
  });

  it("server-side status guard — only 'success' rows are gradeable", () => {
    expect(sql).toMatch(/v_status is distinct from 'success'/i);
  });

  it("validates the 0-4 score range", () => {
    expect(sql).toMatch(/p_comparison_score < 0 or p_comparison_score > 4/i);
  });

  it("is idempotent — writes only where comparison_score is null + returns the rowcount result", () => {
    expect(sql).toMatch(/where id = p_shadow_run_id\s*\n?\s*and comparison_score is null/i);
    expect(sql).toMatch(/get diagnostics v_rows = row_count/i);
    expect(sql).toMatch(/return v_rows = 1/i);
  });

  it("is service-role only (a tenant user cannot grade shadow rows)", () => {
    expect(sql).toMatch(/revoke all on function grade_shadow_run\([^)]*\) from public, authenticated, anon/i);
    expect(sql).toMatch(/grant execute on function grade_shadow_run\([^)]*\) to service_role/i);
  });

  it("revoke/grant signatures match the function's actual 3 arg types (executable-mismatch guard)", () => {
    const createBlock = sql.match(/create or replace function grade_shadow_run\(([\s\S]*?)\)\s*returns/i);
    expect(createBlock, "could not find grade_shadow_run definition").toBeTruthy();
    const createTypes = (createBlock![1].match(/\b(uuid|text|boolean|jsonb|numeric|integer)\b/gi) ?? []).map((t) => t.toLowerCase());
    expect(createTypes).toEqual(["uuid", "integer", "text"]);

    for (const verb of [/revoke all on function grade_shadow_run\(([^)]*)\)/i, /grant execute on function grade_shadow_run\(([^)]*)\)/i]) {
      const m = sql.match(verb);
      expect(m, `missing grant/revoke for grade_shadow_run`).toBeTruthy();
      const grantTypes = (m![1].match(/\b(uuid|text|boolean|jsonb|numeric|integer)\b/gi) ?? []).map((t) => t.toLowerCase());
      expect(grantTypes).toEqual(createTypes);
    }
  });
});
