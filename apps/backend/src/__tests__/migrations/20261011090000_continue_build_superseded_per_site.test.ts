import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const SQL = readFileSync(join(DIR, "20261011090000_continue_build_superseded_per_site.sql"), "utf-8");
const code = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const fnStart = code.indexOf("create or replace function continue_paused_build(");
const body = code.slice(fnStart, code.indexOf("end $$;", fnStart));
const helper = code.slice(code.indexOf("create or replace function _build_graph_site_id("), fnStart);

describe("continue_paused_build: superseded only by a newer build of the SAME app (20261011090000)", () => {
  it("derives each run's app from its OWN stored graph, never from a parameter", () => {
    expect(body).toMatch(/select me\.created_at, _build_graph_site_id\(me\.goal_graph\)\s+into v_created_at, v_site_id\s+from conductor_runs me\s+where me\.id = p_run_id\s+and me\.tenant_id = p_tenant_id;/);
    expect(body).toMatch(/and _build_graph_site_id\(n\.goal_graph\) is not distinct from v_site_id/);
    expect(body).not.toMatch(/_build_graph_site_id\(p_goal_graph\)/);
  });

  it("still counts only newer FRESH builds of the tenant (refines and republishes never supersede)", () => {
    const sup = body.slice(body.indexOf("if exists ("), body.indexOf("return 'superseded';"));
    expect(sup).toMatch(/n\.tenant_id = p_tenant_id/);
    expect(sup).toMatch(/n\.kind = 'build_app'/);
    expect(sup).toMatch(/n\.created_at > v_created_at/);
    expect(sup).toMatch(/coalesce\(n\.goal_graph->0->'payload'->>'refine_mode', ''\) <> 'true'/);
    expect(sup).toMatch(/coalesce\(n\.objective, ''\) not like '\[refine\]%'/);
  });

  it("the site id helper mirrors siteIdFromGraph: first uuid-shaped payload.site_id, lowercased", () => {
    expect(helper).toMatch(/select lower\(e\.node->'payload'->>'site_id'\)/);
    expect(helper).toMatch(/with ordinality as e\(node, ord\)/);
    expect(helper).toMatch(/order by e\.ord\s+limit 1/);
    expect(helper).toMatch(/~\* '\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$'/);
    expect(helper).toMatch(/immutable set search_path = pg_catalog, pg_temp/);
    expect(SQL).toMatch(/revoke all on function _build_graph_site_id\(jsonb\) from public, anon, authenticated;/);
  });

  it("keeps the per-tenant lock first, one running build per tenant, and the compare-and-set resume", () => {
    const lock = body.indexOf("pg_advisory_xact_lock(hashtextextended('build:' || p_tenant_id::text, 0))");
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(body.indexOf("return 'superseded';"));
    expect(body).toMatch(/status in \('provisioning', 'active'\)\s+\) then\s+return 'another_build_running';/);
    expect(body).toMatch(/and updated_at = p_expected_updated_at/);
    expect(body).toMatch(/not in \('user_cancelled', 'provision_failed', 'coach_precedence'\)/);
    expect(body).not.toMatch(/credits_waived/);
  });

  it("same signature, security definer with a pinned search_path, service_role only", () => {
    expect(body).toMatch(/p_tenant_id\s+uuid,\s+p_run_id\s+uuid,\s+p_expected_updated_at timestamptz,\s+p_goal_graph\s+jsonb\s+\) returns text/);
    expect(body).toMatch(/security definer set search_path = public, pg_temp/);
    expect(SQL).toMatch(/revoke all on function continue_paused_build\(uuid, uuid, timestamptz, jsonb\) from public, anon, authenticated;/);
    expect(SQL).toMatch(/grant execute on function continue_paused_build\(uuid, uuid, timestamptz, jsonb\) to service_role;/);
    expect(code).not.toMatch(/continue_paused_build_with_site/);
  });
});
