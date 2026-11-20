import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const routeSrc = readFileSync(
  join(__dirname, "../../routes/admin/super-users.ts"),
  "utf-8",
);
const mig = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260717185900_staff_users_table.sql",
  ),
  "utf-8",
);

describe("super-users route — safety invariants", () => {
  it("blocks revoking the LAST active staff (409 last_staff)", () => {
    expect(routeSrc).toMatch(/active\.length\s*<=\s*1/);
    expect(routeSrc).toMatch(/"last_staff"/);
    expect(routeSrc).toMatch(/\.status\(409\)/);
  });

  it("validates user_id is a UUID before any write", () => {
    expect(routeSrc).toMatch(/UUID_RE/);
    expect(routeSrc).toMatch(/"bad_user_id"/);
  });

  it("WORM-audits both grant and revoke via writeStaffAudit", () => {
    expect(routeSrc).toMatch(/writeStaffAudit/);
    expect(routeSrc).toMatch(/"staff\.grant"/);
    expect(routeSrc).toMatch(/"staff\.revoke"/);
  });

  it("revoke is a soft-delete (sets revoked_at), never a hard delete", () => {
    expect(routeSrc).toMatch(/revoked_at:\s*new Date\(\)\.toISOString\(\)/);
    expect(routeSrc).not.toMatch(/\.delete\(\)/);
  });

  it("grant requires the target to be a real auth user (404 otherwise)", () => {
    expect(routeSrc).toMatch(/getUserById/);
    expect(routeSrc).toMatch(/"user_not_found"/);
  });

  it("every handler asserts staff (mounted-guard belt)", () => {
    const asserts = routeSrc.match(/assertStaff\(req\)/g) ?? [];
    expect(asserts.length).toBeGreaterThanOrEqual(4);
  });
});

describe("staff_users migration — no-lockout invariants", () => {
  it("creates staff_users with a revoked_at soft-delete column", () => {
    expect(mig).toMatch(/create table if not exists staff_users/i);
    expect(mig).toMatch(/revoked_at\s+timestamptz/i);
  });

  it("enables RLS (default-deny, service-role only)", () => {
    expect(mig).toMatch(/alter table staff_users enable row level security/i);
    expect(mig).not.toMatch(/create policy/i);
  });

  it("seeds from app_metadata.role='staff' UNION ravi@upcar.ai (non-empty start)", () => {
    expect(mig).toMatch(/raw_app_meta_data->>'role'\s*=\s*'staff'/i);
    expect(mig).toMatch(/ravi@upcar\.ai/i);
    expect(mig).toMatch(/on conflict \(user_id\) do nothing/i);
  });
});
