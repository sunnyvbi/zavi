import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260604081851_repo_profiles.sql",
);

describe("migration 20260604081851_repo_profiles", () => {
  const sql = readFileSync(MIG_PATH, "utf8");
  const lower = sql.toLowerCase();

  it("creates repo_profiles keyed (tenant_id, repo_full_name) with tenants FK cascade", () => {
    expect(lower).toMatch(
      /create table if not exists repo_profiles \(\s*tenant_id\s+uuid not null references tenants\(id\) on delete cascade/,
    );
    expect(lower).toMatch(/primary key \(tenant_id, repo_full_name\)/);
  });

  it("persists STRUCTURED columns only — NO source/README/prose column (leakage guard)", () => {
    for (const col of [
      "kind",
      "language_stats   jsonb",
      "frameworks       text\\[\\]",
      "topics           text\\[\\]",
      "description      text",
      "default_branch",
      "manifest_paths   text\\[\\]",
      "fingerprint",
      "profile_status",
      "last_error",
      "retry_after",
      "built_at",
    ]) {
      expect(lower).toMatch(new RegExp(col));
    }
    expect(lower).not.toMatch(/\breadme\b/);
    expect(lower).not.toMatch(/\bsource_text\b/);
    expect(lower).not.toMatch(/\bfile_content\b/);
  });

  it("enables RLS + a tenant-member SELECT policy mirroring code_index_state", () => {
    expect(lower).toMatch(/alter table repo_profiles enable row level security/);
    expect(lower).toMatch(
      /create policy repo_profiles_select on repo_profiles for select to authenticated using \(\s*tenant_id in \(select tenant_id from tenant_users where user_id = auth\.uid\(\)\)/,
    );
  });

  it("has NO authenticated INSERT/UPDATE/DELETE policy (RLS denies direct DML)", () => {
    expect(lower).not.toMatch(/create policy[\s\S]*?on repo_profiles for insert/);
    expect(lower).not.toMatch(/create policy[\s\S]*?on repo_profiles for update/);
    expect(lower).not.toMatch(/create policy[\s\S]*?on repo_profiles for delete/);
  });

  it("upsert_repo_profile is security definer, service_role-only, stamps tenant_id from the arg", () => {
    expect(lower).toMatch(/create or replace function upsert_repo_profile\(/);
    expect(lower).toMatch(/language plpgsql security definer set search_path = public/);
    expect(lower).toMatch(/upsert_repo_profile: tenant_id and repo_full_name are required/);
    expect(lower).toMatch(/values\s*\(\s*p_tenant_id, p_repo_full_name/);
    expect(lower).toMatch(/revoke all on function upsert_repo_profile\([\s\S]*?\) from public/);
    expect(lower).toMatch(/grant execute on function upsert_repo_profile\([\s\S]*?\) to service_role/);
  });

  it("seed_repo_profile_pending is security definer, service_role-only, never clobbers a ready row", () => {
    expect(lower).toMatch(/create or replace function seed_repo_profile_pending\(/);
    expect(lower).toMatch(/language plpgsql security definer set search_path = public/);
    expect(lower).toMatch(/on conflict \(tenant_id, repo_full_name\) do nothing/);
    expect(lower).toMatch(/grant execute on function seed_repo_profile_pending\([\s\S]*?\) to service_role/);
  });

  it("is wrapped in a single transaction", () => {
    expect(lower).toContain("begin;");
    expect(lower.trimEnd().endsWith("commit;")).toBe(true);
  });
});
