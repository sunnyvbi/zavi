import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260530200260_code_index_build_status.sql",
);

describe("migration 20260530200260_code_index_build_status", () => {
  const sql = readFileSync(MIG_PATH, "utf8");
  const lower = sql.toLowerCase();

  it("adds the 3 status sidecar columns to code_index_state (idempotent)", () => {
    expect(lower).toMatch(
      /alter table code_index_state add column if not exists last_status\s+text/,
    );
    expect(lower).toMatch(
      /alter table code_index_state add column if not exists last_error\s+text/,
    );
    expect(lower).toMatch(
      /alter table code_index_state add column if not exists last_attempt_at timestamptz/,
    );
  });

  it("defines code_index_record_status with the right signature", () => {
    expect(lower).toMatch(
      /create or replace function code_index_record_status\(\s*p_tenant_id uuid,\s*p_repo\s+text,\s*p_status\s+text,\s*p_error\s+text\s*\)/,
    );
  });

  it("is SECURITY DEFINER with a pinned search_path + statement_timeout", () => {
    expect(lower).toMatch(
      /language plpgsql security definer set search_path = public set statement_timeout = '30s' as/,
    );
  });

  it("null-guards tenant_id + repo", () => {
    expect(lower).toMatch(/if p_tenant_id is null or p_repo is null then/);
    expect(lower).toMatch(/code_index_record_status: tenant_id and repo are required/);
  });

  it("truncates the error text defensively (left(p_error, 500))", () => {
    expect(lower).toContain("left(p_error, 500)");
  });

  it("CRITICAL: the on-conflict UPDATE does NOT set current_build_id", () => {
    const onConflictIdx = lower.indexOf("on conflict (tenant_id, repo_full_name) do update");
    expect(onConflictIdx).toBeGreaterThan(-1);
    const updateClause = lower.slice(onConflictIdx, lower.indexOf("end $$", onConflictIdx));
    expect(updateClause).not.toContain("current_build_id");
    expect(updateClause).toMatch(/set last_status\s*=\s*excluded\.last_status/);
    expect(updateClause).toMatch(/last_error\s*=\s*excluded\.last_error/);
    expect(updateClause).toMatch(/last_attempt_at\s*=\s*excluded\.last_attempt_at/);
  });

  it("the recorder's INSERT column list excludes current_build_id (status path is pointer-safe)", () => {
    const insertStmt = lower.slice(
      lower.indexOf("insert into code_index_state (tenant_id, repo_full_name,"),
      lower.indexOf("on conflict"),
    );
    expect(insertStmt.length).toBeGreaterThan(0);
    expect(insertStmt).not.toContain("current_build_id");
    expect(insertStmt).toContain("last_status");
    expect(insertStmt).toContain("last_error");
    expect(insertStmt).toContain("last_attempt_at");
  });

  it("revokes from public and grants execute to service_role only", () => {
    expect(lower).toMatch(/revoke all on function code_index_record_status\([\s\S]*?\) from public/);
    expect(lower).toMatch(
      /grant execute on function code_index_record_status\([\s\S]*?\) to service_role/,
    );
  });

  it("is wrapped in a single transaction", () => {
    expect(lower).toContain("begin;");
    expect(lower.trimEnd().endsWith("commit;")).toBe(true);
  });
});
