import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260704230000_credit_finalize_include_paused_awaiting_approval.sql",
);

describe("migration 20260704230000_credit_finalize_include_paused_awaiting_approval", () => {
  const sql = readFileSync(MIG_PATH, "utf8");

  it("CREATE OR REPLACEs the finalize trigger function", () => {
    expect(sql).toMatch(/create or replace function _trg_finalize_run_credits\(\)/i);
  });

  it("adds paused_awaiting_approval to the NEW.status billing-terminal set", () => {
    expect(sql).toMatch(
      /new\.status in \([^)]*'paused_awaiting_approval'[^)]*\)/i,
    );
  });

  it("is a SUPERSET — keeps every classic terminal token", () => {
    for (const tok of [
      "success",
      "parse_failed",
      "error",
      "failed",
      "cancelled",
      "dispatch_error",
    ]) {
      expect(sql).toMatch(new RegExp(`new\\.status in \\([^)]*'${tok}'`, "i"));
    }
  });

  it("does NOT widen the OLD.status guard — no re-finalize on paused→success", () => {
    expect(sql).toMatch(/old\.status in \('queued','running','blocked'\)/i);
    expect(sql).not.toMatch(/old\.status in \([^)]*'paused_awaiting_approval'/i);
  });

  it("leaves the re-reserve trigger untouched (paused never → queued under R2)", () => {
    expect(sql).not.toMatch(/create or replace function _trg_rereserve_run_credits/i);
  });

  it("preserves the attempt-aware open-reserve short-circuit", () => {
    expect(sql).toMatch(/_credits_enforced\(new\.tenant_id\)/i);
    expect(sql).toMatch(/kind = 'reserve'/i);
  });
});
