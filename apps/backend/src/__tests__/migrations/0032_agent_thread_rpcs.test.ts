import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/0032_agent_thread_rpcs.sql"),
  "utf-8",
);

describe("0032_agent_thread_rpcs.sql", () => {
  it("defines list_agents_for_tenant() RPC", () => {
    expect(sql).toMatch(/create or replace function list_agents_for_tenant\(\)/i);
  });

  it("defines get_agent_thread(text, timestamptz, bigint, int) RPC", () => {
    expect(sql).toMatch(
      /create or replace function get_agent_thread\(\s*p_agent_slug text,\s*p_cursor_created_at timestamptz default null,\s*p_cursor_id bigint default null,\s*p_limit int default 200/i,
    );
  });

  it("both RPCs are security definer (function decl, not comments)", () => {
    const matches = sql.match(/language plpgsql\s+security definer/gi) ?? [];
    expect(matches.length).toBe(2);
  });

  it("both RPCs set search_path explicitly (security hygiene)", () => {
    const matches = sql.match(/set search_path = public/gi) ?? [];
    expect(matches.length).toBe(2);
  });

  it("both RPCs re-derive tenant_id from tenant_users by auth.uid() (Codex C8)", () => {
    expect(sql).toMatch(/v_user_id uuid := auth\.uid\(\)/);
    const tenantLookups = sql.match(
      /from tenant_users tu\s+where tu\.user_id = v_user_id/gi,
    ) ?? [];
    expect(tenantLookups.length).toBe(2);
  });

  it("both RPCs reject unauthenticated callers + non-tenant-members", () => {
    const unauth = sql.match(/raise exception 'unauthenticated'/gi) ?? [];
    expect(unauth.length).toBe(2);
    const unauthorized = sql.match(/raise exception 'unauthorized'/gi) ?? [];
    expect(unauthorized.length).toBe(2);
  });

  it("list_agents_for_tenant returns the 5 expected columns", () => {
    for (const col of [
      "slug text",
      "latest_run_started_at timestamptz",
      "latest_run_status text",
      "latest_event_preview text",
      "pending_decisions_count int",
    ]) {
      expect(sql).toMatch(new RegExp(col.replace(/ /g, "\\s+"), "i"));
    }
  });

  it("list_agents_for_tenant uses DISTINCT ON for latest-run-per-agent (single-query, no N+1)", () => {
    expect(sql).toMatch(/distinct on \(ar\.agent_slug\)/i);
  });

  it("list_agents_for_tenant uses LATERAL JOIN for latest event preview", () => {
    expect(sql).toMatch(/left join lateral/i);
  });

  it("get_agent_thread cursor predicate is a stable (created_at, id) tuple compare", () => {
    expect(sql).toMatch(
      /\(te\.created_at,\s*te\.id\)\s*<\s*\(p_cursor_created_at,\s*p_cursor_id\)/i,
    );
  });

  it("get_agent_thread orders by (created_at desc, id desc) — matches cursor predicate", () => {
    expect(sql).toMatch(
      /order by te\.created_at desc,\s*te\.id desc/i,
    );
  });

  it("get_agent_thread caps p_limit at 500 (and floors at 1)", () => {
    expect(sql).toMatch(
      /least\(greatest\(coalesce\(p_limit, 200\), 1\), 500\)/i,
    );
  });

  it("get_agent_thread rejects half-set cursors (both must be set or both null)", () => {
    expect(sql).toMatch(
      /\(p_cursor_created_at is null\) <> \(p_cursor_id is null\)/i,
    );
    expect(sql).toMatch(/cursor must be both-set or both-null/i);
  });

  it("get_agent_thread rejects empty agent_slug", () => {
    expect(sql).toMatch(/agent_slug required/i);
  });

  it("grants execute on both RPCs to authenticated (revoke public)", () => {
    expect(sql).toMatch(
      /revoke all on function list_agents_for_tenant\(\) from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function list_agents_for_tenant\(\) to authenticated/i,
    );
    expect(sql).toMatch(
      /revoke all on function get_agent_thread\(text, timestamptz, bigint, int\) from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function get_agent_thread\(text, timestamptz, bigint, int\) to authenticated/i,
    );
  });

  it("does NOT trust caller-supplied tenant_id (Codex C8 — no p_tenant_id param)", () => {
    expect(sql).not.toMatch(/p_tenant_id\s+uuid/i);
  });

  it("decisions join goes through agent_runs (agent_slug lives on the run, not the decision)", () => {
    expect(sql).toMatch(/join agent_runs ar on ar\.id = d\.agent_run_id/i);
  });
});
