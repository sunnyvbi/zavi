import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(
  join(MIG_DIR, "20260714053157_engineer_preview_expire_and_restart.sql"),
  "utf-8",
);

describe("20260714053157_engineer_preview_expire_and_restart.sql", () => {
  it("defines expire_engineer_sandbox_preview as security-definer", () => {
    expect(sql).toMatch(
      /create or replace function expire_engineer_sandbox_preview\(\s*p_id uuid,\s*p_reason text default null\s*\) returns void/i,
    );
    expect(sql).toMatch(
      /function expire_engineer_sandbox_preview[\s\S]*?language plpgsql security definer set search_path = public/i,
    );
  });

  it("revokes expire_engineer_sandbox_preview from public and grants only to service_role", () => {
    expect(sql).toMatch(
      /revoke all on function expire_engineer_sandbox_preview\(uuid, text\) from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function expire_engineer_sandbox_preview\(uuid, text\) to service_role/i,
    );
  });

  it("expire_engineer_sandbox_preview RETAINS preview_run_id (the whole point)", () => {
    const body = sql.slice(
      sql.search(/create or replace function expire_engineer_sandbox_preview/i),
      sql.search(/create or replace function set_engineer_sandbox_preview/i),
    );
    expect(body).toMatch(/preview_status\s*=\s*'dead'/i);
    expect(body).toMatch(/preview_url\s*=\s*null/i);
    expect(body).toMatch(/preview_ended_at\s*=\s*now\(\)/i);
    expect(body).not.toMatch(/preview_run_id\s*=\s*null/i);
    expect(body).not.toMatch(/preview_port\s*=\s*null/i);
  });

  it("bounds p_reason to 500 chars (preview_error is a whitelisted token, never raw logs)", () => {
    expect(sql).toMatch(/left\(p_reason, 500\)/i);
  });

  it("keeps set_engineer_sandbox_preview's signature and grants (strict superset)", () => {
    expect(sql).toMatch(
      /create or replace function set_engineer_sandbox_preview\(\s*p_id uuid,\s*p_url text,\s*p_port int,\s*p_status text,\s*p_run_id text\s*\) returns void/i,
    );
    expect(sql).toMatch(
      /revoke all on function set_engineer_sandbox_preview\(uuid, text, int, text, text\) from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function set_engineer_sandbox_preview\(uuid, text, int, text, text\) to service_role/i,
    );
  });

  it("resets preview_started_at + preview_last_viewed_at on EVERY transition into 'starting'", () => {
    const body = sql.slice(
      sql.search(/create or replace function set_engineer_sandbox_preview/i),
    );
    expect(body).toMatch(
      /preview_started_at\s*=\s*case\s*when p_status = 'starting' then now\(\)/i,
    );
    expect(body).toMatch(
      /preview_last_viewed_at\s*=\s*case\s*when p_status = 'starting' then now\(\)/i,
    );
  });

  it("preserves the prior preview_error reset on starting/live", () => {
    expect(sql).toMatch(/when p_status in \('starting','live'\) then null/i);
  });

  it("does NOT redefine the shared clear_sandbox_preview", () => {
    expect(sql).not.toMatch(/create or replace function clear_sandbox_preview/i);
    expect(sql).not.toMatch(/drop function if exists clear_sandbox_preview/i);
  });

  it("pins pg_temp in search_path on BOTH functions (does not revert the 20260711090514 hardening)", () => {
    const defs = sql.match(/language plpgsql security definer set search_path = [^\n]*/gi) ?? [];
    expect(defs).toHaveLength(2);
    for (const d of defs) expect(d).toMatch(/pg_temp/i);
  });

  it("adds preview_ended_at additively", () => {
    expect(sql).toMatch(
      /alter table public\.tenant_sandbox\s*add column if not exists preview_ended_at timestamptz/i,
    );
  });
});
