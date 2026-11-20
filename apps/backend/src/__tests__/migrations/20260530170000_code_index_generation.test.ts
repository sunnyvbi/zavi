import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260530170000_code_index_generation.sql",
);

describe("migration 20260530170000_code_index_generation", () => {
  const sql = readFileSync(MIG_PATH, "utf8");
  const lower = sql.toLowerCase();

  it("step 1 — adds build_id to both tables + a per-generation index on each", () => {
    expect(lower).toMatch(/alter table code_symbols\s+add column if not exists build_id uuid/);
    expect(lower).toMatch(/alter table code_symbol_refs\s+add column if not exists build_id uuid/);
    expect(lower).toMatch(/create index if not exists code_symbols_build_idx[\s\S]*?tenant_id, repo_full_name, build_id/);
    expect(lower).toMatch(/create index if not exists code_symbol_refs_build_idx[\s\S]*?tenant_id, repo_full_name, build_id/);
  });

  it("step 2 — drops the old unique constraint by column-set and recreates it WITH build_id", () => {
    expect(lower).toMatch(/from pg_constraint[\s\S]*?contype = 'u'/);
    expect(lower).toMatch(/alter table code_symbols drop constraint %i/i);
    expect(lower).toMatch(
      /add constraint code_symbols_generation_key\s+unique \(tenant_id, repo_full_name, file_path, symbol_name, start_line, build_id\)/,
    );
  });

  it("step 3 — code_index_state table with RLS + tenant-scoped SELECT policy mirroring code_symbols", () => {
    expect(lower).toMatch(
      /create table if not exists code_index_state \(\s*tenant_id\s+uuid not null references tenants\(id\) on delete cascade/,
    );
    expect(lower).toMatch(/current_build_id uuid/);
    expect(lower).toMatch(/primary key \(tenant_id, repo_full_name\)/);
    expect(lower).toMatch(/alter table code_index_state enable row level security/);
    expect(lower).toMatch(
      /create policy code_index_state_select on code_index_state for select to authenticated using \(\s*tenant_id in \(select tenant_id from tenant_users where user_id = auth\.uid\(\)\)/,
    );
  });

  it("step 3b — code_index_builds append-only build-log table with RLS + tenant-scoped SELECT + (tenant,built_at) index", () => {
    expect(lower).toMatch(
      /create table if not exists code_index_builds \([\s\S]*?tenant_id\s+uuid not null references tenants\(id\) on delete cascade/,
    );
    expect(lower).toMatch(/built_at\s+timestamptz default now\(\)/);
    expect(lower).toMatch(
      /create index if not exists code_index_builds_tenant_built_idx[\s\S]*?tenant_id, built_at/,
    );
    expect(lower).toMatch(/alter table code_index_builds enable row level security/);
    expect(lower).toMatch(
      /create policy code_index_builds_select on code_index_builds for select to authenticated using \(\s*tenant_id in \(select tenant_id from tenant_users where user_id = auth\.uid\(\)\)/,
    );
  });

  it("step 4 — code_index_insert_chunk is INSERT-ONLY, security definer, service_role-only, stamps tenant_id+build_id", () => {
    expect(lower).toMatch(/create or replace function code_index_insert_chunk\(/);
    expect(lower).toMatch(/language plpgsql security definer set search_path = public/);
    expect(lower).toMatch(/code_index_insert_chunk: tenant_id, repo and build_id are required/);
    const chunkBody = sql.slice(
      sql.indexOf("function code_index_insert_chunk"),
      sql.indexOf("revoke all on function code_index_insert_chunk"),
    );
    expect(chunkBody.toLowerCase()).not.toContain("delete from");
    expect(chunkBody).toMatch(/insert into code_symbols[\s\S]*?p_tenant_id, p_repo, p_build_id/);
    expect(chunkBody).toMatch(/insert into code_symbol_refs[\s\S]*?p_tenant_id, p_repo, p_build_id/);
    expect(lower).toMatch(/revoke all on function code_index_insert_chunk\([\s\S]*?\) from public/);
    expect(lower).toMatch(/grant execute on function code_index_insert_chunk\([\s\S]*?\) to service_role/);
  });

  it("step 5 — code_index_commit upserts the pointer then prunes every other generation (incl NULL build_id)", () => {
    expect(lower).toMatch(/create or replace function code_index_commit\(/);
    expect(lower).toMatch(/language plpgsql security definer set search_path = public/);
    expect(lower).toMatch(/code_index_commit: tenant_id, repo and build_id are required/);
    expect(lower).toMatch(/pg_advisory_xact_lock\(/);
    expect(lower).toMatch(
      /insert into code_index_state \(tenant_id, repo_full_name, current_build_id, indexed_at\)[\s\S]*?on conflict \(tenant_id, repo_full_name\) do update[\s\S]*?current_build_id = excluded\.current_build_id/,
    );
    expect(lower).toMatch(
      /insert into code_index_builds \(tenant_id, repo_full_name, built_at\)\s*values \(p_tenant_id, p_repo, now\(\)\)/,
    );
    expect(lower).toMatch(/delete from code_symbols\s+where tenant_id = p_tenant_id[\s\S]*?build_id is distinct from p_build_id/);
    expect(lower).toMatch(/delete from code_symbol_refs\s+where tenant_id = p_tenant_id[\s\S]*?build_id is distinct from p_build_id/);
    const commitBody = sql.slice(
      sql.indexOf("function code_index_commit"),
      sql.indexOf("revoke all on function code_index_commit"),
    );
    expect(commitBody.toLowerCase()).not.toContain("delete from code_index_builds");
    expect(lower).toMatch(/grant execute on function code_index_commit\([\s\S]*?\) to service_role/);
  });

  it("step 6 — code_symbol_query keeps its 5-arg signature and filters EVERY branch on the committed generation (P1 empty-window contract)", () => {
    expect(lower).toMatch(
      /create or replace function code_symbol_query\(\s*p_tenant_id\s+uuid,\s*p_repo\s+text,\s*p_symbol_name\s+text,\s*p_query_embedding vector\(1024\),\s*p_mode\s+text\s*\)/,
    );
    const defBranchHasGate = /from code_symbols cs[\s\S]*?cs\.build_id = \(\s*select s\.current_build_id from code_index_state s\s*where s\.tenant_id = p_tenant_id and s\.repo_full_name = p_repo\s*\)/i;
    const refBranchHasGate = /from code_symbol_refs cr[\s\S]*?cr\.build_id = \(\s*select s\.current_build_id from code_index_state s\s*where s\.tenant_id = p_tenant_id and s\.repo_full_name = p_repo\s*\)/i;
    expect(sql).toMatch(defBranchHasGate);
    expect(sql).toMatch(refBranchHasGate);
  });

  it("step 7 — drops the old build_id-unaware upsert_code_symbols RPC", () => {
    expect(lower).toMatch(/drop function if exists upsert_code_symbols\(uuid, text, text, jsonb, jsonb\)/);
  });

  it("is wrapped in a single transaction", () => {
    expect(lower.trimStart().startsWith("--") || lower.includes("begin;")).toBe(true);
    expect(lower).toContain("begin;");
    expect(lower.trimEnd().endsWith("commit;")).toBe(true);
  });
});
