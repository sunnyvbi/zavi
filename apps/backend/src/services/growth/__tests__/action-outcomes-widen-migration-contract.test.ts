
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = "20260702030246_action_outcomes_widen_tiers.sql";

let sql = "";
beforeAll(() => {
  const path = join(__dirname, "..", "..", "..", "..", "..", "..", "supabase", "migrations", MIGRATION);
  sql = readFileSync(path, "utf8").toLowerCase();
});

describe("action_outcomes widen migration — tier + subject contract", () => {
  it("adds outcome_tier defaulting 'business' with the two-tier check", () => {
    expect(sql).toMatch(/add column if not exists outcome_tier text not null default 'business'/);
    expect(sql).toMatch(/check \(outcome_tier in \('delivery', 'business'\)\)/);
  });

  it("widens subject_type keeping the original meta subjects", () => {
    expect(sql).toMatch(
      /check \(subject_type in \('campaign', 'adset', 'ad', 'pr', 'email', 'other'\)\)/,
    );
  });

  it("drops the old 9-arg record_action_outcome before creating the 10-arg one", () => {
    const dropIdx = sql.indexOf(
      "drop function if exists record_action_outcome(uuid, text, text, text, text, text, text, int, jsonb)",
    );
    const createIdx = sql.indexOf("create or replace function record_action_outcome(");
    expect(dropIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(dropIdx);
    expect(sql).toMatch(/p_outcome_tier\s+text default 'business'/);
    expect(sql).toMatch(/if p_outcome_tier not in \('delivery', 'business'\)/);
  });

  it("keeps the C8 tenant resolution + decision_id idempotency in the new RPC", () => {
    expect(sql).toMatch(/select tenant_id into v_tenant from decisions where id = p_decision_id/);
    expect(sql).toMatch(/on conflict \(decision_id\) do nothing/);
  });

  it("keeps both RPCs service_role-only", () => {
    expect(sql).toMatch(
      /grant execute on function record_action_outcome\(uuid, text, text, text, text, text, text, int, jsonb, text\) to service_role/,
    );
    expect(sql).toMatch(
      /revoke all on function record_action_outcome\(uuid, text, text, text, text, text, text, int, jsonb, text\) from authenticated/,
    );
    expect(sql).toMatch(
      /grant execute on function get_action_outcome_signal\(uuid, interval\) to service_role/,
    );
  });

  it("scopes the business signal aggregate to outcome_tier='business'", () => {
    expect(sql).toMatch(/and outcome_tier = 'business'/);
  });
});
