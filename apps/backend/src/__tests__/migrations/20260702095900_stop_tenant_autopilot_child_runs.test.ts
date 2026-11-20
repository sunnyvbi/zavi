import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260702095900_stop_tenant_autopilot_child_runs.sql",
  ),
  "utf-8",
);

describe("20260702095900_stop_tenant_autopilot_child_runs.sql", () => {
  it("REBUILDS stop_tenant_autopilot via create-or-replace (same uuid signature)", () => {
    expect(sql).toMatch(/create or replace function stop_tenant_autopilot\(/i);
    expect(sql).toMatch(/p_tenant_id\s+uuid/i);
  });

  it("keeps the original halt semantics intact (active company_goal only + WORM ledger)", () => {
    expect(sql).toMatch(/kind\s*=\s*'company_goal'/i);
    expect(sql).toMatch(/status\s+in\s*\(\s*'active'\s*\)/i);
    expect(sql).toMatch(/append_autopilot_action/i);
    expect(sql).toMatch(/tenant_stop/i);
  });

  it("flags stop_requested=true on child agent_runs", () => {
    expect(sql).toMatch(/update agent_runs[\s\S]*?set stop_requested\s*=\s*true/i);
  });

  it("the child flag is TENANT-scoped and RUNNING-only (never queued/terminal, never another tenant)", () => {
    const childUpdate = sql.slice(sql.search(/update agent_runs/i));
    expect(childUpdate).toMatch(/ar\.tenant_id\s*=\s*p_tenant_id/i);
    expect(childUpdate).toMatch(/ar\.status\s*=\s*'running'/i);
    expect(childUpdate).toMatch(/ar\.stop_requested is distinct from true/i);
  });

  it("children are linked ONLY via the halted runs' goal_graph child_run_id (v_run_ids)", () => {
    const childUpdate = sql.slice(sql.search(/update agent_runs/i));
    expect(childUpdate).toMatch(/node->>'child_run_id'/i);
    expect(childUpdate).toMatch(/jsonb_array_elements/i);
    expect(childUpdate).toMatch(/cr\.id\s*=\s*any\(v_run_ids\)/i);
    expect(childUpdate).toMatch(/cr\.tenant_id\s*=\s*p_tenant_id/i);
  });

  it("hardens the graph walk — non-array goal_graph and non-uuid child ids can't abort the stop", () => {
    const childUpdate = sql.slice(sql.search(/update agent_runs/i));
    expect(childUpdate).toMatch(
      /case when jsonb_typeof\(cr\.goal_graph\)\s*=\s*'array'[\s\S]*?else '\[\]'::jsonb end/i,
    );
    expect(childUpdate).toMatch(/\(node->>'child_run_id'\)[\s\S]*?~\*/i);
  });

  it("returns the additive stopped_child_runs count (backward-compatible shape)", () => {
    expect(sql).toMatch(/'ok',\s*true/i);
    expect(sql).toMatch(/'halted_runs',\s*v_count/i);
    expect(sql).toMatch(/'halted_run_ids'/i);
    expect(sql).toMatch(/get diagnostics v_stopped_children\s*=\s*row_count/i);
    expect(sql).toMatch(/'stopped_child_runs',\s*v_stopped_children/i);
  });

  it("stays service_role-only (route derives tenant from requireAuth)", () => {
    expect(sql).toMatch(/revoke all on function stop_tenant_autopilot\(uuid\) from public/i);
    expect(sql).toMatch(
      /grant execute on function stop_tenant_autopilot\(uuid\) to service_role/i,
    );
    expect(sql).not.toMatch(
      /grant execute on function stop_tenant_autopilot\(uuid\) to authenticated/i,
    );
  });
});
