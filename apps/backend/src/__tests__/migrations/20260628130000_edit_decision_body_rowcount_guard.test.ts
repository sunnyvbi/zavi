import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260628130000_edit_decision_body_rowcount_guard.sql"),
  "utf-8",
);
const ddl = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("20260628130000_edit_decision_body_rowcount_guard.sql", () => {
  it("CREATE OR REPLACEs the same function signature, security definer", () => {
    expect(ddl).toMatch(/create or replace function edit_decision_body_if_proposed\(/i);
    expect(ddl).toMatch(/p_decision_id\s+uuid/i);
    expect(ddl).toMatch(/p_body\s+jsonb/i);
    expect(ddl).toMatch(/security definer/i);
  });

  it("KEEPS all prior gates (superset): not_found, cross_tenant, not_member, proposed-only", () => {
    expect(ddl).toMatch(/'reason',\s*'not_found'/);
    expect(ddl).toMatch(/'reason',\s*'cross_tenant'/);
    expect(ddl).toMatch(/'reason',\s*'not_member'/);
    expect(ddl).toMatch(/v_status <> 'proposed'/);
    expect(ddl).toMatch(/from tenant_users/i);
    expect(ddl).toMatch(/update decisions\s+set body = p_body\s+where id = p_decision_id and status = 'proposed'/i);
  });

  it("ADDS the ROW_COUNT guard → not_proposed when zero rows changed (TOCTOU fix)", () => {
    expect(ddl).toMatch(/get diagnostics\s+\w+\s*=\s*row_count/i);
    expect(ddl).toMatch(/if v_rows = 0 then/i);
    const afterUpdate = ddl.slice(ddl.search(/get diagnostics/i));
    expect(afterUpdate).toMatch(/'reason',\s*'not_proposed'/);
  });

  it("stays service_role-only (revoked from public/authenticated/anon)", () => {
    expect(ddl).toMatch(/revoke all on function edit_decision_body_if_proposed.* from public, authenticated, anon/i);
    expect(ddl).toMatch(/grant execute on function edit_decision_body_if_proposed.* to service_role/i);
  });
});
