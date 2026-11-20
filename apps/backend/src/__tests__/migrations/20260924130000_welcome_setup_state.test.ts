import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260924130000_welcome_setup_state.sql"),
  "utf8",
);
const fn = sql.slice(
  sql.indexOf("create or replace function mark_first_run_progress"),
  sql.indexOf("revoke all on function mark_first_run_progress"),
);

describe("20260924130000_welcome_setup_state", () => {
  it("adds the setup columns", () => {
    for (const c of [
      "setup_docs_at timestamptz",
      "setup_docs_skipped boolean not null default false",
      "setup_connectors_at timestamptz",
      "setup_connectors_skipped boolean not null default false",
      "setup_done_at timestamptz",
      "setup_home_at timestamptz",
    ]) expect(sql).toContain(`add column if not exists ${c}`);
  });
  it("keeps the security-definer shape, pinned path and membership check before any write", () => {
    expect(fn).toMatch(/security definer\s+set search_path = public, pg_temp/i);
    expect(fn.indexOf("not a member of tenant")).toBeGreaterThan(-1);
    expect(fn.indexOf("not a member of tenant")).toBeLessThan(fn.indexOf("insert into tenant_first_run_progress"));
  });
  it("setup kinds need owner/admin INSIDE the RPC, before any write; legacy kinds stay membership-only", () => {
    expect(fn).toMatch(/p_kind like 'setup\\_%' escape '\\' and not exists \(\s*select 1 from tenant_users\s+where user_id = v_user_id and tenant_id = v_tenant_id and role in \('owner', 'admin'\)/);
    expect(fn.indexOf("owner or admin required")).toBeLessThan(fn.indexOf("insert into tenant_first_run_progress"));
  });
  it("accepts the new kinds and only done|skipped for the two steps", () => {
    expect(fn).toMatch(/'setup_docs', 'setup_connectors', 'setup_done', 'setup_home'/);
    expect(fn).toMatch(/p_key not in \('done', 'skipped'\)/);
  });
  it("first answer wins (coalesce), so a replayed mark cannot move a step", () => {
    expect(fn).toMatch(/setup_docs_at\s*=\s*coalesce\(setup_docs_at, now\(\)\)/);
    expect(fn).toMatch(/setup_connectors_at\s*=\s*coalesce\(setup_connectors_at, now\(\)\)/);
  });
  it("re-issues the grants", () => {
    expect(sql).toMatch(/revoke all on function mark_first_run_progress\(uuid, text, text\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function mark_first_run_progress\(uuid, text, text\) to authenticated, service_role/);
  });
});
