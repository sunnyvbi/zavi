import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/0034_get_agent_fleet_graph_rpc.sql",
  ),
  "utf-8",
);

describe("0034_get_agent_fleet_graph_rpc.sql", () => {
  it("defines get_agent_fleet_graph() returning jsonb", () => {
    expect(sql).toMatch(
      /create or replace function get_agent_fleet_graph\(\)\s+returns jsonb/i,
    );
  });

  it("is security definer with explicit set search_path = public", () => {
    expect(sql).toMatch(/language plpgsql\s+security definer/i);
    expect(sql).toMatch(/set search_path = public/i);
  });

  it("re-derives tenant_id from tenant_users by auth.uid() (Codex C8)", () => {
    expect(sql).toMatch(/v_user_id uuid := auth\.uid\(\)/);
    expect(sql).toMatch(
      /from tenant_users tu\s+where tu\.user_id = v_user_id/i,
    );
  });

  it("rejects unauthenticated callers + non-tenant-members", () => {
    expect(sql).toMatch(/raise exception 'unauthenticated'/);
    expect(sql).toMatch(/raise exception 'unauthorized'/);
  });

  it("does NOT trust caller-supplied tenant_id (no p_tenant_id param)", () => {
    expect(sql).not.toMatch(/p_tenant_id\s+uuid/i);
  });

  it("nodes aggregate from agent_runs with the expected fields", () => {
    expect(sql).toMatch(/jsonb_build_object\([\s\S]+'slug',/);
    expect(sql).toMatch(/'last_run_at',\s+rs\.last_run_at/);
    expect(sql).toMatch(/'runs_total',\s+rs\.runs_total/);
    expect(sql).toMatch(/'pending_decisions',\s+coalesce\(dp\.pending_decisions, 0\)/);
  });

  it("edges aggregate from dispatch_history with the expected fields", () => {
    expect(sql).toMatch(/from dispatch_history dh/);
    expect(sql).toMatch(/group by dh\.source_agent_slug, dh\.target_agent_slug/);
    expect(sql).toMatch(/'source_slug',/);
    expect(sql).toMatch(/'target_slug',/);
    expect(sql).toMatch(/'dispatch_count',/);
    expect(sql).toMatch(/'last_dispatch_at',/);
  });

  it("edges + nodes both fall back to empty array for new tenants", () => {
    const coalesces = sql.match(/coalesce\(\s*jsonb_agg/gi) ?? [];
    expect(coalesces.length).toBe(2);
    const emptyDefaults = sql.match(/'\[\]'::jsonb/gi) ?? [];
    expect(emptyDefaults.length).toBe(2);
  });

  it("returns {nodes, edges} jsonb object", () => {
    expect(sql).toMatch(
      /return jsonb_build_object\(\s*'nodes', v_nodes,\s*'edges', v_edges\s*\)/i,
    );
  });

  it("decisions join goes through agent_runs (agent_slug lives on the run)", () => {
    expect(sql).toMatch(/join agent_runs ar on ar\.id = d\.agent_run_id/i);
    expect(sql).toMatch(/d\.status = 'proposed'/);
  });

  it("uses dispatch_history (NOT agent_run_events) for edges", () => {
    expect(sql).toMatch(/from dispatch_history dh\s+where dh\.tenant_id = v_tenant_id/i);
    expect(sql).not.toMatch(/from agent_run_events.*group by.*source/i);
  });

  it("revokes from public + grants execute to authenticated", () => {
    expect(sql).toMatch(/revoke all on function get_agent_fleet_graph\(\) from public/i);
    expect(sql).toMatch(
      /grant execute on function get_agent_fleet_graph\(\) to authenticated/i,
    );
  });
});
