import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260707183000_staff_audit_log_worm_and_rls.sql",
  ),
  "utf-8",
);

describe("20260707183000_staff_audit_log_worm_and_rls.sql", () => {
  it("is WORM: a BEFORE UPDATE OR DELETE trigger raises (blocks even service-role)", () => {
    expect(sql).toMatch(/create or replace function staff_audit_log_worm_guard\(\)/i);
    expect(sql).toMatch(/raise exception 'staff_audit_log is append-only/i);
    expect(sql).toMatch(/before update or delete on staff_audit_log/i);
    expect(sql).toMatch(/create trigger staff_audit_log_worm/i);
  });

  it("enables RLS (default-deny) on staff_audit_log", () => {
    expect(sql).toMatch(/alter table staff_audit_log enable row level security/i);
  });

  it("does NOT add a tenant-member SELECT policy (cross-tenant staff log stays service-role-only)", () => {
    expect(sql).not.toMatch(/create policy .* on staff_audit_log/i);
  });

  it("does not weaken the guard: never UPDATEs or DELETEs staff_audit_log itself", () => {
    expect(sql).not.toMatch(/delete from staff_audit_log/i);
    expect(sql).not.toMatch(/update staff_audit_log\b/i);
  });
});
