import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "supabase",
  "migrations",
  "20260609082516_selfimprove_ci_scoped_role.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");
const code = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("self_improve_ci scoped role", () => {
  it("creates the role idempotently as a nologin switch-target", () => {
    expect(code).toMatch(/if not exists \(select 1 from pg_roles where rolname = 'self_improve_ci'\)/);
    expect(code).toMatch(/create role self_improve_ci nologin/);
  });

  it("grants the role to authenticator (so PostgREST can SET ROLE into it)", () => {
    expect(code).toMatch(/grant self_improve_ci to authenticator/);
  });

  it("grants execute on EXACTLY the 3 queue RPCs", () => {
    expect(code).toMatch(
      /grant execute on function list_pending_improvement_requests\(int\)\s+to self_improve_ci/,
    );
    expect(code).toMatch(
      /grant execute on function finalize_improvement_request\(bigint, text\)\s+to self_improve_ci/,
    );
    expect(code).toMatch(
      /grant execute on function reap_stale_improvement_leases\(int\)\s+to self_improve_ci/,
    );
    const grants = code.match(/grant execute on function [^;]+ to self_improve_ci/g) || [];
    expect(grants.length).toBe(3);
  });

  it("never grants table privileges or elevates the role (no RLS bypass)", () => {
    expect(code).not.toMatch(/grant\s+(select|insert|update|delete|all)[^;]*\bon\b[^;]*to self_improve_ci/i);
    expect(code).not.toMatch(/grant (authenticated|service_role) to self_improve_ci/);
    expect(code).not.toMatch(/self_improve_ci\s+(superuser|bypassrls|createrole|createdb)/i);
  });
});
