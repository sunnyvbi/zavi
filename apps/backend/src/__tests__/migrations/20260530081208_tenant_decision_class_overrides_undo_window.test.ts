import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260530081208_tenant_decision_class_overrides_undo_window.sql"),
  "utf-8",
);

describe("20260530081208_tenant_decision_class_overrides_undo_window.sql", () => {
  it("adds undo_window_minutes int NOT NULL DEFAULT 15 to tenant_decision_class_overrides", () => {
    expect(sql).toMatch(/alter table tenant_decision_class_overrides/i);
    expect(sql).toMatch(/add column if not exists undo_window_minutes\s+int\s+not null\s+default\s+15/i);
  });

  it("defines undo_dispatched_node as a SECURITY DEFINER jsonb RPC", () => {
    expect(sql).toMatch(/create or replace function undo_dispatched_node\s*\(/i);
    expect(sql).toMatch(/p_tenant_id\s+uuid/i);
    expect(sql).toMatch(/p_conductor_run_id\s+uuid/i);
    expect(sql).toMatch(/p_node_id\s+text/i);
    expect(sql).toMatch(/returns jsonb/i);
    expect(sql).toMatch(/language plpgsql security definer set search_path = public/i);
  });

  it("RPC is service_role-only (NOT granted to authenticated or public)", () => {
    expect(sql).toMatch(/revoke all on function undo_dispatched_node\(uuid, uuid, text\) from public/i);
    expect(sql).toMatch(/grant execute on function undo_dispatched_node\(uuid, uuid, text\) to service_role/i);
    expect(sql).not.toMatch(/grant execute on function undo_dispatched_node\([^)]*\) to authenticated/i);
  });

  it("validates tenant ownership of the conductor_run before mutating", () => {
    expect(sql).toMatch(/from conductor_runs[\s\S]*where[\s\S]*id\s*=\s*p_conductor_run_id[\s\S]*and tenant_id\s*=\s*p_tenant_id/i);
  });

  it("rejects undo on non-dispatched nodes (only 'dispatched' is undoable)", () => {
    expect(sql).toMatch(/v_node_status\s*<>\s*'dispatched'/i);
    expect(sql).toMatch(/'reason',\s*'not_dispatched'/i);
  });

  it("enforces the per-class window via tenant_decision_class_overrides.undo_window_minutes (default 15)", () => {
    expect(sql).toMatch(/select undo_window_minutes/i);
    expect(sql).toMatch(/from tenant_decision_class_overrides/i);
    expect(sql).toMatch(/v_window_min\s*:=\s*coalesce\(v_window_min,\s*15\)/i);
    expect(sql).toMatch(/'reason',\s*'window_expired'/i);
  });

  it("UNDO appends a NEW ledger row via append_autopilot_action (NOT an UPDATE/DELETE — WORM-safe)", () => {
    expect(sql).toMatch(/append_autopilot_action\s*\(/i);
    expect(sql).toMatch(/'undo'/);
    expect(sql).not.toMatch(/update autopilot_action_ledger/i);
    expect(sql).not.toMatch(/delete from autopilot_action_ledger/i);
  });

  it("reverts the node's status to 'pending' inside conductor_runs.goal_graph via jsonb_set", () => {
    expect(sql).toMatch(/jsonb_set\s*\(/i);
    expect(sql).toMatch(/to_jsonb\('pending'::text\)/i);
    expect(sql).toMatch(/update conductor_runs/i);
    expect(sql).toMatch(/set goal_graph\s*=\s*v_new_graph/i);
  });

  it("returns {ok:true, ledger_id} on success", () => {
    expect(sql).toMatch(/jsonb_build_object\('ok',\s*true,\s*'ledger_id'/i);
  });
});
