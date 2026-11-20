import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260530171000_code_index_insert_dedup.sql",
);

describe("migration 20260530171000_code_index_insert_dedup", () => {
  const sql = readFileSync(MIG_PATH, "utf8");
  const lower = sql.toLowerCase();

  it("re-creates code_index_insert_chunk with the SAME signature", () => {
    expect(lower).toMatch(
      /create or replace function code_index_insert_chunk\(\s*p_tenant_id\s+uuid,\s*p_repo\s+text,\s*p_build_id\s+uuid,\s*p_commit\s+text,\s*p_indexed_at timestamptz,\s*p_symbols\s+jsonb,\s*p_refs\s+jsonb\s*\)/,
    );
  });

  it("PRESERVES statement_timeout = '180s' in the attribute clause (else the 170500 fix is lost)", () => {
    expect(lower).toMatch(
      /language plpgsql security definer set search_path = public set statement_timeout = '180s' as/,
    );
  });

  it("adds on-conflict-do-nothing to the code_symbols insert on the generation-key column set", () => {
    expect(lower).toContain("on conflict");
    expect(lower).toContain("do nothing");
    expect(lower).toMatch(
      /on conflict \(tenant_id, repo_full_name, file_path, symbol_name, start_line, build_id\) do nothing/,
    );
  });

  it("does NOT add on-conflict to the code_symbol_refs insert (refs have no unique constraint)", () => {
    const refsInsert = sql.slice(
      sql.indexOf("insert into code_symbol_refs"),
      sql.indexOf("end $$"),
    );
    expect(refsInsert.toLowerCase()).not.toContain("on conflict");
  });

  it("is INSERT-ONLY (no DELETE) and keeps the trust-boundary null guard + stamping", () => {
    expect(lower).not.toContain("delete from");
    expect(lower).toMatch(/code_index_insert_chunk: tenant_id, repo and build_id are required/);
    expect(sql).toMatch(/insert into code_symbols[\s\S]*?p_tenant_id, p_repo, p_build_id/);
    expect(sql).toMatch(/insert into code_symbol_refs[\s\S]*?p_tenant_id, p_repo, p_build_id/);
  });

  it("re-grants execute to service_role only (revoke from public)", () => {
    expect(lower).toMatch(/revoke all on function code_index_insert_chunk\([\s\S]*?\) from public/);
    expect(lower).toMatch(/grant execute on function code_index_insert_chunk\([\s\S]*?\) to service_role/);
  });

  it("is wrapped in a single transaction", () => {
    expect(lower).toContain("begin;");
    expect(lower.trimEnd().endsWith("commit;")).toBe(true);
  });
});
