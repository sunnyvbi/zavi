import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260606013430_consume_class_budget_or_reject.sql"),
  "utf-8",
);

describe("20260606013430_consume_class_budget_or_reject.sql", () => {
  it("defines the per-class cap RPC with the (tenant, class, estimate) signature", () => {
    expect(sql).toMatch(
      /create or replace function consume_class_budget_or_reject\(\s*p_tenant_id\s+uuid,\s*p_decision_class text,\s*p_estimate_usd\s+numeric/i,
    );
    expect(sql).toMatch(/returns text/i);
  });

  it("is security definer with a locked search_path", () => {
    expect(sql).toMatch(/language plpgsql security definer set search_path = public/i);
  });

  it("reads the per-class caps off tenant_decision_class_overrides", () => {
    expect(sql).toMatch(/from tenant_decision_class_overrides/i);
    expect(sql).toMatch(/max_daily_usd/i);
    expect(sql).toMatch(/max_per_action_usd/i);
  });

  it("enforces the per-action ceiling (single action over cap → over_cap)", () => {
    expect(sql).toMatch(/v_max_per_action is not null and p_estimate_usd > v_max_per_action/i);
  });

  it("sums the rolling-24h spend from the autopilot_action_ledger keyed by class", () => {
    expect(sql).toMatch(/sum\(l\.spend_delta\)/i);
    expect(sql).toMatch(/from autopilot_action_ledger l/i);
    expect(sql).toMatch(/join decisions d on d\.id = l\.decision_id/i);
    expect(sql).toMatch(/d\.decision_class = p_decision_class/i);
    expect(sql).toMatch(/now\(\) - interval '24 hours'/i);
    expect(sql).toMatch(/v_spent_24h \+ p_estimate_usd > v_max_daily/i);
  });

  it("returns 'charged' on the happy path + 'over_cap' on a breach", () => {
    expect(sql).toMatch(/return 'charged'/i);
    expect(sql).toMatch(/return 'over_cap'/i);
  });

  it("null cap = no limit (the daily-window sum is only computed when a cap is set)", () => {
    expect(sql).toMatch(/if v_max_daily is not null then/i);
  });

  it("rejects null/negative estimate (invalid argument)", () => {
    expect(sql).toMatch(/null\/invalid argument/i);
    expect(sql).toMatch(/p_estimate_usd < 0/i);
  });

  it("revokes from public + grants execute to service_role and authenticated", () => {
    expect(sql).toMatch(
      /revoke all on function consume_class_budget_or_reject\(uuid, text, numeric\) from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function consume_class_budget_or_reject\(uuid, text, numeric\) to service_role/i,
    );
    expect(sql).toMatch(
      /grant execute on function consume_class_budget_or_reject\(uuid, text, numeric\) to authenticated/i,
    );
  });
});
