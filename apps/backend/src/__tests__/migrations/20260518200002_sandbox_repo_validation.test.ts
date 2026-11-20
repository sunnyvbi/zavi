import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260518200002_sandbox_repo_validation.sql",
);

describe("migration 20260518200002_sandbox_repo_validation", () => {
  const sql = readFileSync(MIG_PATH, "utf8");

  it("validates repo membership inside get_or_create_tenant_sandbox", () => {
    expect(sql).toMatch(/create or replace function get_or_create_tenant_sandbox/i);
    expect(sql).toMatch(
      /select exists\(\s*select 1\s*from connector_metadata[\s\S]*?p_repo_full_name = any\(repo_full_names\)/i,
    );
    expect(sql).toMatch(
      /raise exception 'get_or_create_tenant_sandbox: repo % not in tenant connected repos'/,
    );
  });

  it("preserves the original 'creating' insert path", () => {
    expect(sql).toMatch(
      /insert into public\.tenant_sandbox \(tenant_id, repo_full_name, status\)[\s\S]*?'creating'/i,
    );
  });
});
