import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260516000002_get_agent_thread_broadcast_allowlist.sql",
  ),
  "utf-8",
);

const sqlBody = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

describe("0083_get_agent_thread_broadcast_allowlist.sql", () => {
  it("drops the 0073 5-arg uuid signature (avoid PostgREST overload ambiguity)", () => {
    expect(sql).toMatch(
      /drop function if exists get_agent_thread\(text, timestamptz, bigint, int, uuid\)\s*;/i,
    );
  });

  it("recreates get_agent_thread with the same 5-arg p_thread_id signature", () => {
    expect(sql).toMatch(
      /create or replace function get_agent_thread\(\s*p_agent_slug text,\s*p_cursor_created_at timestamptz default null,\s*p_cursor_id bigint default null,\s*p_limit int default 200,\s*p_thread_id uuid default null/i,
    );
  });

  it("broadcast lane is an ALLOWLIST: run.trigger IN (cron, manual, scheduled)", () => {
    expect(sql).toMatch(
      /and exists \(\s*select 1 from agent_runs r\s*where r\.id = te\.agent_run_id\s*and r\.tenant_id = v_tenant_id\s*and r\.trigger in \('cron',\s*'manual',\s*'scheduled'\)\s*\)/i,
    );
  });

  it("does NOT reintroduce the leaky denylist in the function body", () => {
    expect(sqlBody).not.toMatch(/not exists \([^;]*r\.trigger = 'chat'/i);
    expect(sqlBody).not.toMatch(/r\.trigger\s*=\s*'chat'/i);
  });

  it("still returns this thread's own rows when p_thread_id is set", () => {
    expect(sql).toMatch(
      /p_thread_id is not null and te\.thread_id = p_thread_id/i,
    );
  });

  it("keeps the thread ownership re-scope (no foreign/guessed thread widening)", () => {
    expect(sql).toMatch(
      /from agent_threads t\s*where t\.id = p_thread_id\s*and t\.tenant_id = v_tenant_id\s*and t\.user_id = v_user_id\s*and t\.agent_slug = p_agent_slug/i,
    );
    expect(sql).toMatch(/raise exception 'thread not found or not owned'/i);
  });

  it("re-scopes the agent_runs probe to the resolved tenant", () => {
    expect(sql).toMatch(/and r\.tenant_id = v_tenant_id/i);
  });

  it("still tenant-scoped + reverse-chronological with stable cursor", () => {
    expect(sql).toMatch(/where te\.tenant_id = v_tenant_id/i);
    expect(sql).toMatch(/and te\.agent_slug = p_agent_slug/i);
    expect(sql).toMatch(
      /\(te\.created_at, te\.id\) < \(p_cursor_created_at, p_cursor_id\)/i,
    );
    expect(sql).toMatch(/order by te\.created_at desc, te\.id desc/i);
  });

  it("is security definer with explicit search_path", () => {
    expect(sql).toMatch(/language plpgsql\s+security definer/i);
    expect(sql).toMatch(/set search_path = public/i);
  });

  it("caps p_limit at 500, floors at 1", () => {
    expect(sql).toMatch(
      /least\(greatest\(coalesce\(p_limit, 200\), 1\), 500\)/i,
    );
  });

  it("revokes public + grants authenticated on the 5-arg uuid signature", () => {
    expect(sql).toMatch(
      /revoke all on function get_agent_thread\(text, timestamptz, bigint, int, uuid\) from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function get_agent_thread\(text, timestamptz, bigint, int, uuid\) to authenticated/i,
    );
  });
});
