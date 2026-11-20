import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/0072_get_agent_thread_broadcasts_only.sql",
  ),
  "utf-8",
);

describe("0072_get_agent_thread_broadcasts_only.sql", () => {
  it("drops the old 4-arg signature (avoid PostgREST overload ambiguity)", () => {
    expect(sql).toMatch(
      /drop function if exists get_agent_thread\(text, timestamptz, bigint, int\)\s*;/i,
    );
  });

  it("recreates get_agent_thread with opt-in p_broadcasts_only (default false)", () => {
    expect(sql).toMatch(
      /create or replace function get_agent_thread\(\s*p_agent_slug text,\s*p_cursor_created_at timestamptz default null,\s*p_cursor_id bigint default null,\s*p_limit int default 200,\s*p_broadcasts_only boolean default false/i,
    );
  });

  it("default false → existing behavior unchanged (back-compat for the lone caller)", () => {
    expect(sql).toMatch(/p_broadcasts_only boolean default false/i);
  });

  it("excludes chat-trigger chat_assistant rows when broadcasts-only", () => {
    expect(sql).toMatch(/not coalesce\(p_broadcasts_only, false\)/i);
    expect(sql).toMatch(/or te\.kind <> 'chat_assistant'/i);
    expect(sql).toMatch(/r\.trigger = 'chat'/i);
  });

  it("re-scopes the agent_runs probe to the resolved tenant (no cross-tenant widening)", () => {
    expect(sql).toMatch(
      /from agent_runs r\s*where r\.id = te\.agent_run_id\s*and r\.tenant_id = v_tenant_id\s*and r\.trigger = 'chat'/i,
    );
  });

  it("still tenant-scoped and reverse-chronological with stable cursor", () => {
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

  it("caps p_limit at 500 and floors at 1", () => {
    expect(sql).toMatch(
      /least\(greatest\(coalesce\(p_limit, 200\), 1\), 500\)/i,
    );
  });

  it("revokes public + grants authenticated on the NEW 5-arg signature", () => {
    expect(sql).toMatch(
      /revoke all on function get_agent_thread\(text, timestamptz, bigint, int, boolean\) from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function get_agent_thread\(text, timestamptz, bigint, int, boolean\) to authenticated/i,
    );
  });
});
