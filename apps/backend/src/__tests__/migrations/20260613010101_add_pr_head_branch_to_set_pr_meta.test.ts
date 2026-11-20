import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const NEW_PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260613010101_add_pr_head_branch_to_set_pr_meta.sql",
);
const OLD_PATH = join(
  __dirname,
  "../../../../../supabase/migrations/0045_mark_pr_merged_rpc.sql",
);

describe("migration 20260613010101 — agent_run_set_pr_meta superset", () => {
  const sql = readFileSync(NEW_PATH, "utf8");
  const old = readFileSync(OLD_PATH, "utf8");

  it("declares the new 5-arg signature with p_pr_head_branch defaulting to NULL", () => {
    expect(sql).toMatch(
      /create or replace function agent_run_set_pr_meta\(\s*p_run_id uuid,\s*p_pr_url text,\s*p_pr_repo text,\s*p_pr_number int,\s*p_pr_head_branch text default null\s*\)/i,
    );
  });

  it("DROPs the prior 4-arg signature first (avoids the ambiguous-overload trap)", () => {
    expect(sql).toMatch(/drop function if exists agent_run_set_pr_meta\(uuid, text, text, int\)/i);
  });

  it("keeps the prior pr_url/pr_repo/pr_number write byte-identical (clean superset)", () => {
    const priorWrite = `jsonb_build_object(
                       'pr_url', p_pr_url,
                       'pr_repo', p_pr_repo,
                       'pr_number', p_pr_number
                     )`;
    expect(old).toContain(priorWrite);
    expect(sql).toContain(priorWrite);
  });

  it("writes pr_head_branch ONLY when the param is non-null (non-destructive on old runs)", () => {
    expect(sql).toMatch(/when p_pr_head_branch is not null/i);
    expect(sql).toMatch(/jsonb_build_object\('pr_head_branch', p_pr_head_branch\)/);
  });

  it("keeps security definer + locked search_path", () => {
    expect(sql).toMatch(/language plpgsql security definer set search_path = public/i);
  });

  it("revokes from public + grants execute to service_role on the new signature", () => {
    expect(sql).toMatch(
      /revoke all on function agent_run_set_pr_meta\(uuid, text, text, int, text\) from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function agent_run_set_pr_meta\(uuid, text, text, int, text\) to service_role/i,
    );
  });
});
