
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "supabase",
  "migrations",
);

const file = readdirSync(MIGRATIONS_DIR).find((f) =>
  /^\d{14}_agent_run_set_postdeploy_verify\.sql$/.test(f),
);

if (!file) {
  throw new Error(
    "agent_run_set_postdeploy_verify migration not found — expected a 14-digit timestamp prefix file",
  );
}

const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");

describe("agent_run_set_postdeploy_verify migration", () => {
  it("defines the RPC with the expected signature (run_id uuid, tenant_id uuid, verify jsonb → int)", () => {
    expect(sql).toMatch(
      /create or replace function agent_run_set_postdeploy_verify\(\s*p_run_id uuid,\s*p_tenant_id uuid,\s*p_verify jsonb\s*\)\s*returns int/i,
    );
  });

  it("is security definer with explicit search_path (Praxis convention)", () => {
    expect(sql).toMatch(/security definer set search_path = public/i);
  });

  it("revokes execute from public + grants to service_role ONLY (no anon/authenticated)", () => {
    expect(sql).toMatch(/revoke all on function agent_run_set_postdeploy_verify\(uuid, uuid, jsonb\) from public/i);
    expect(sql).toMatch(/grant execute on function agent_run_set_postdeploy_verify\(uuid, uuid, jsonb\) to service_role/i);
    expect(sql).not.toMatch(/grant execute on function agent_run_set_postdeploy_verify[^;]*to (anon|authenticated)/i);
  });

  it("enforces tenant_id in the UPDATE predicate (cross-tenant write guard)", () => {
    expect(sql).toMatch(/update agent_runs[\s\S]*?where id = p_run_id\s+and tenant_id = p_tenant_id/i);
  });

  it("stamps parsed.postdeploy_verify via jsonb_build_object (always, regardless of verdict)", () => {
    expect(sql).toMatch(/jsonb_build_object\('postdeploy_verify', p_verify\)/);
  });

  it("only demotes parse_ok on a NON-success verdict (success leaves parse_ok intact)", () => {
    expect(sql).toMatch(/parse_ok = case when v_verdict = 'success' then parse_ok else false end/i);
  });

  it("only writes error on a NON-success verdict (success preserves existing error column)", () => {
    expect(sql).toMatch(/error\s+= case when v_verdict = 'success' then error\s+else v_error end/i);
  });

  it("does NOT change agent_runs.status (the run itself succeeded; only the deploy of its output failed)", () => {
    expect(sql).not.toMatch(/set\s+status\s*=/i);
  });

  it("validates p_verify is a JSON object + verdict is required (defensive guards)", () => {
    expect(sql).toMatch(/jsonb_typeof\(p_verify\) <> 'object'/);
    expect(sql).toMatch(/p_verify->>'verdict'/);
    expect(sql).toMatch(/raise exception.*verdict required/i);
  });

  it("returns the row_count so the caller can detect a no-op (run-id missing / tenant mismatch)", () => {
    expect(sql).toMatch(/get diagnostics v_count = row_count;\s*return v_count;/i);
  });
});
