import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260521200000_unreserve_batch_fanout_budget.sql",
  ),
  "utf-8",
);

describe("20260521200000_unreserve_batch_fanout_budget.sql", () => {
  it("creates the batch_fanout_refunds audit table with full reservation fields", () => {
    expect(sql).toMatch(/create table if not exists batch_fanout_refunds/i);
    for (const col of [
      "tenant_id",
      "total_reserved",
      "estimate_per_child",
      "reserved_at",
      "parent_message_id",
      "refunded_usd",
      "refunded_children",
      "refund_reason",
      "refunded_at",
    ]) {
      expect(sql).toContain(col);
    }
  });

  it("adds acknowledged_at + acknowledged_reason to batch_fanout_reservations", () => {
    expect(sql).toMatch(/alter table batch_fanout_reservations/i);
    expect(sql).toMatch(/add column if not exists acknowledged_at timestamptz/i);
    expect(sql).toMatch(/add column if not exists acknowledged_reason text/i);
  });

  it("seeds the forensic-ghost ack (smoke-2026-05-21-forensic)", () => {
    expect(sql).toMatch(/acknowledged_reason\s*=\s*'smoke-2026-05-21-forensic'/);
  });

  it("validates p_refund_usd range (rejects negative + over-refund)", () => {
    expect(sql).toMatch(/p_refund_usd\s*<\s*0\s*or\s*p_refund_usd\s*>\s*v_ledger\.total_reserved/i);
    expect(sql).toMatch(/22023/);
  });

  it("validates p_actual_spend_usd is non-negative", () => {
    expect(sql).toMatch(/p_actual_spend_usd\s*<\s*0/i);
  });

  it("computes delta atomically from actual spend (greatest(0, total - actual))", () => {
    expect(sql).toMatch(/greatest\(0,\s*v_ledger\.total_reserved\s*-\s*p_actual_spend_usd\)/i);
  });

  it("upserts a zero counter row before the decrement (closes silent-no-op)", () => {
    expect(sql).toMatch(
      /insert into tenant_budget_counters[\s\S]*on conflict \(tenant_id, day\) do nothing/i,
    );
  });

  it("fails loud when the counter UPDATE affects 0 rows (RETURNING/GET DIAGNOSTICS guard)", () => {
    expect(sql).toMatch(/get diagnostics v_updated_rows = row_count/i);
    expect(sql).toMatch(/v_updated_rows\s*=\s*0/i);
  });

  it("decrements with a zero floor (never negative)", () => {
    expect(sql).toMatch(/spend_estimate\s*=\s*greatest\(0,\s*spend_estimate\s*-\s*v_decrement\)/i);
  });

  it("idempotent: returns no_reservation when the ledger row is absent + deletes on success", () => {
    expect(sql).toMatch(/'no_reservation'/);
    expect(sql).toMatch(/delete from batch_fanout_reservations where batch_id = p_batch_id/i);
  });

  it("locks the ledger row FOR UPDATE before mutating", () => {
    expect(sql).toMatch(/from batch_fanout_reservations[\s\S]*for update/i);
  });

  it("grants execute to service_role only (revoked from public)", () => {
    expect(sql).toMatch(/revoke all on function unreserve_batch_fanout_budget\([^)]*\)\s*\n?\s*from public/i);
    expect(sql).toMatch(/grant execute on function unreserve_batch_fanout_budget\([^)]*\)\s*\n?\s*to service_role/i);
  });
});
