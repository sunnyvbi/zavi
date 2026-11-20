import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260530084921_cancel_conductor_run.sql",
  ),
  "utf-8",
);

describe("20260530084921_cancel_conductor_run.sql", () => {
  it("defines cancel_conductor_run(uuid, uuid) returning jsonb", () => {
    expect(sql).toMatch(
      /create or replace function cancel_conductor_run\(\s*p_tenant_id\s+uuid,\s*p_conductor_run_id\s+uuid\s*\)\s+returns jsonb/i,
    );
  });

  it("is security-definer with search_path set to public (no privilege-escalation)", () => {
    expect(sql).toMatch(
      /language plpgsql\s+security definer\s+set search_path = public/i,
    );
  });

  it("tenant-binds the conductor lookup (a mis-supplied tenant_id is a no-op)", () => {
    expect(sql).toMatch(
      /from conductor_runs\s+where id = p_conductor_run_id\s+and tenant_id = p_tenant_id/i,
    );
    expect(sql).toMatch(
      /update conductor_runs[\s\S]+where id = p_conductor_run_id\s+and tenant_id = p_tenant_id/i,
    );
  });

  it("only flips non-terminal flippable states ('provisioning','active') — never overrides terminal", () => {
    expect(sql).toMatch(/and status in \('provisioning', 'active'\)/i);
  });

  it("appends to the WORM ledger via append_autopilot_action (no direct INSERT)", () => {
    expect(sql).toMatch(/append_autopilot_action\(/);
    expect(sql).not.toMatch(/insert into autopilot_action_ledger/i);
  });

  it("evidence captures the user_cancel signal + prior_status for audit replay", () => {
    expect(sql).toMatch(/'kind',\s*'user_cancel'/);
    expect(sql).toMatch(/'prior_status',\s*v_prior_status/);
    expect(sql).toMatch(/'cancelled_at',\s*now\(\)/);
  });

  it("is idempotent on already-terminal runs (cancelled:false, not an error)", () => {
    expect(sql).toMatch(/if v_prior_status in \('halted', 'done', 'failed'\)/i);
    expect(sql).toMatch(/'cancelled',\s*false/);
  });

  it("returns conductor_run_not_found when the tenant+id combo doesn't resolve", () => {
    expect(sql).toMatch(
      /jsonb_build_object\('ok',\s*false,\s*'reason',\s*'conductor_run_not_found'\)/i,
    );
  });

  it("grants EXECUTE to service_role only (revoked from public)", () => {
    expect(sql).toMatch(
      /revoke all on function cancel_conductor_run\(uuid, uuid\) from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function cancel_conductor_run\(uuid, uuid\) to service_role/i,
    );
    expect(sql).not.toMatch(/grant execute on function cancel_conductor_run.+to authenticated/i);
    expect(sql).not.toMatch(/grant execute on function cancel_conductor_run.+to anon/i);
  });
});
