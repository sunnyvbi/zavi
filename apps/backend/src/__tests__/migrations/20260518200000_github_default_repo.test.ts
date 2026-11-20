import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260518200000_github_default_repo.sql",
);

describe("migration 20260518200000_github_default_repo", () => {
  const sql = readFileSync(MIG_PATH, "utf8");

  it("adds default_repo_full_name column idempotently", () => {
    expect(sql).toMatch(/add column if not exists default_repo_full_name text/i);
  });

  it("adds CHECK that constrains value to repo_full_names membership", () => {
    expect(sql).toMatch(/connector_metadata_default_repo_member_chk/);
    expect(sql).toMatch(/default_repo_full_name = any\(repo_full_names\)/i);
  });

  it("creates btree index scoped to github slug", () => {
    expect(sql).toMatch(/connector_metadata_default_repo_idx/);
    expect(sql).toMatch(/where slug = 'github'/i);
  });

  it("creates tenant_config_audit table with RLS member-select policy", () => {
    expect(sql).toMatch(/create table if not exists tenant_config_audit/i);
    expect(sql).toMatch(/alter table tenant_config_audit enable row level security/i);
    expect(sql).toMatch(/drop policy if exists tenant_config_audit_member_select/);
    expect(sql).toMatch(/create policy tenant_config_audit_member_select/);
  });

  it("defines set_github_default_repo as authenticated-grant + admin-gated", () => {
    expect(sql).toMatch(
      /create or replace function set_github_default_repo\(\s*p_tenant_id\s+uuid,\s*p_repo_full_name\s+text\s*\)/i,
    );
    expect(sql).toMatch(/perform _assert_tenant_admin\(p_tenant_id\)/);
    expect(sql).toMatch(/p_repo_full_name = any\(repo_full_names\)/);
    expect(sql).toMatch(/get diagnostics v_updated = row_count/i);
    expect(sql).toMatch(
      /grant execute on function set_github_default_repo[\s\S]*?to authenticated/i,
    );
  });

  it("defines clear_github_default_repo with no-op-no-audit semantics", () => {
    expect(sql).toMatch(/create or replace function clear_github_default_repo/i);
    expect(sql).toMatch(/perform _assert_tenant_admin\(p_tenant_id\)/);
    expect(sql).toMatch(/if v_updated = 0 then\s*[\s\S]*?return;/i);
    expect(sql).toMatch(
      /grant execute on function clear_github_default_repo[\s\S]*?to authenticated/i,
    );
  });

  it("PATCHES set_github_connection to auto-clear default on repo removal", () => {
    expect(sql).toMatch(/create or replace function set_github_connection/i);
    expect(sql).toMatch(/v_current_default/);
    expect(sql).toMatch(/set_github_connection_refresh/);
    expect(sql).toMatch(/repo_removed_from_connected_list/);
    expect(sql).not.toMatch(
      /grant execute on function set_github_connection[\s\S]*?to authenticated/i,
    );
  });

  it("inserts tenant_config_audit row in set RPC + clear RPC + auto-clear-during-refresh path", () => {
    const matches = sql.match(/insert into tenant_config_audit/gi) ?? [];
    expect(matches.length).toBe(3);
  });

  it("revokes public on new RPCs", () => {
    expect(sql).toMatch(/revoke all on function set_github_default_repo[\s\S]*?from public/i);
    expect(sql).toMatch(/revoke all on function clear_github_default_repo[\s\S]*?from public/i);
  });
});
