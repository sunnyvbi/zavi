import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260529215942_buildapp_sandbox_provisioned_repo.sql",
);

describe("migration 20260529215942_buildapp_sandbox_provisioned_repo", () => {
  const sql = readFileSync(MIG_PATH, "utf8");

  it("preserves the connected-repo acceptance path (failsafe)", () => {
    expect(sql).toMatch(/create or replace function get_or_create_tenant_sandbox/i);
    expect(sql).toMatch(
      /select exists\(\s*select 1\s*from connector_metadata[\s\S]*?and\s+slug\s*=\s*'github'[\s\S]*?p_repo_full_name\s*=\s*any\(repo_full_names\)/i,
    );
  });

  it("rejects non-connected non-provisioned repos with the same message (failsafe)", () => {
    expect(sql).toMatch(
      /raise exception 'get_or_create_tenant_sandbox: repo % not in tenant connected repos'/,
    );
    expect(sql).toMatch(/using errcode = '22023'/);
    expect(sql).toMatch(/if\s+not\s*\(\s*v_connected\s+or\s+v_provisioned\s*\)\s+then/i);
  });

  it("adds the provisioned-product-builder-repo acceptance path (NEW)", () => {
    expect(sql).toMatch(
      /select exists\(\s*select 1\s*from tenant_resources[\s\S]*?tenant_id\s*=\s*p_tenant_id[\s\S]*?resource_kind\s*=\s*'repo'[\s\S]*?mode\s*=\s*'provisioned'[\s\S]*?external_ref->>'github_full_name'\s*=\s*p_repo_full_name/i,
    );
  });

  it("leaves the 'creating' insert path intact", () => {
    expect(sql).toMatch(
      /insert into public\.tenant_sandbox \(tenant_id, repo_full_name, status\)[\s\S]*?'creating'/i,
    );
  });

  it("does not change the function signature or grants", () => {
    expect(sql).toMatch(
      /create or replace function get_or_create_tenant_sandbox\(\s*p_tenant_id uuid,\s*p_repo_full_name text\s*\) returns public\.tenant_sandbox/i,
    );
    expect(sql).not.toMatch(/^\s*grant\s+execute/im);
    expect(sql).not.toMatch(/^\s*revoke\s+all/im);
  });
});
