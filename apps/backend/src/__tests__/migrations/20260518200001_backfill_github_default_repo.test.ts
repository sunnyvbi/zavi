import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260518200001_backfill_github_default_repo.sql",
);

describe("migration 20260518200001_backfill_github_default_repo", () => {
  const sql = readFileSync(MIG_PATH, "utf8");

  it("uses CTE+RETURNING to tie audit rows to actually-updated tenants", () => {
    expect(sql).toMatch(/with updated as[\s\S]*?returning tenant_id, default_repo_full_name/i);
    expect(sql).toMatch(/insert into tenant_config_audit[\s\S]*?from updated/i);
  });

  it("only updates null default_repo_full_name (idempotent)", () => {
    expect(sql).toMatch(/default_repo_full_name is null/i);
  });

  it("only updates tenants with exactly one connected repo", () => {
    expect(sql).toMatch(/array_length\(repo_full_names, 1\) = 1/i);
  });

  it("uses system actor UUID for backfill source", () => {
    expect(sql).toMatch(/00000000-0000-0000-0000-000000000000/);
    expect(sql).toMatch(/backfill_20260518200001/);
  });
});
