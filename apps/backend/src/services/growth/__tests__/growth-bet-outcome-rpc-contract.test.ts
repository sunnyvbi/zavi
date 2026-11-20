
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = "20260611130000_growth_bet_outcome_signal.sql";

let sql = "";
beforeAll(() => {
  const path = join(
    __dirname, "..", "..", "..", "..", "..", "..",
    "supabase", "migrations", MIGRATION,
  );
  sql = readFileSync(path, "utf8").toLowerCase();
});

describe("get_growth_bet_outcomes — lineage + no-fake-causality contract", () => {
  it("starts from the three growth bet classes only", () => {
    expect(sql).toMatch(/growth-lead\.reallocate-budget/);
    expect(sql).toMatch(/growth-lead\.lifecycle-draft/);
    expect(sql).toMatch(/growth-lead\.social-draft/);
  });

  it("joins the dispatch by origin_decision_id = bet.id and only APPROVED/acted/dispatched", () => {
    expect(sql).toMatch(/growth-lead\.dispatch-specialist/);
    expect(sql).toMatch(/origin_decision_id'\s*=\s*b\.id::text/);
    expect(sql).toMatch(/d\.status in \('approved', 'acted', 'dispatched'\)/);
  });

  it("joins the specialist run by payload->>source_decision_id = dispatch.id", () => {
    expect(sql).toMatch(/source_decision_id'\s*=\s*d\.id::text/);
  });

  it("joins the meta decision by agent_run_id and the MEASURED action_outcome", () => {
    expect(sql).toMatch(/m\.agent_run_id\s*=\s*ar\.id/);
    expect(sql).toMatch(/o\.decision_id\s*=\s*m\.id/);
    expect(sql).toMatch(/o\.reconcile_status\s*=\s*'measured'/);
  });

  it("is tenant-scoped on every joined table (C8)", () => {
    expect(sql).toMatch(/d\.tenant_id\s*=\s*b\.tenant_id/);
    expect(sql).toMatch(/ar\.tenant_id\s*=\s*b\.tenant_id/);
    expect(sql).toMatch(/m\.tenant_id\s*=\s*b\.tenant_id/);
    expect(sql).toMatch(/o\.tenant_id\s*=\s*b\.tenant_id/);
    expect(sql).toMatch(/b\.tenant_id\s*=\s*p_tenant_id/);
  });

  it("surfaces the measured spend/roas delta + measured_at, not a fabricated value", () => {
    expect(sql).toMatch(/delta_metrics->>'spend'/);
    expect(sql).toMatch(/delta_metrics->>'roas'/);
    expect(sql).toMatch(/o\.measured_at/);
  });

  it("rejects a null tenant and is service_role-only", () => {
    expect(sql).toMatch(/raise exception 'get_growth_bet_outcomes: null tenant_id'/);
    expect(sql).toMatch(/revoke all on function get_growth_bet_outcomes\([^)]*\) from public/);
    expect(sql).toMatch(/revoke all on function get_growth_bet_outcomes\([^)]*\) from authenticated/);
    expect(sql).toMatch(/grant execute on function get_growth_bet_outcomes\([^)]*\) to service_role/);
  });
});
