import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations");
const FILE = join(MIGRATIONS_DIR, "20260605073741_invite_land_in_tenant.sql");

describe("20260605073741_invite_land_in_tenant", () => {
  const sql = readFileSync(FILE, "utf8");

  it("re-defines accept_invite as security-definer with pinned search_path", () => {
    expect(sql).toMatch(
      /create or replace function accept_invite\(p_invite_id uuid\)[\s\S]{0,400}security definer set search_path = public/i,
    );
  });

  it("keeps the open-invite + email-match guards (not accepted, not revoked, email match)", () => {
    expect(sql).toMatch(/invite already accepted[\s\S]{0,80}42501/i);
    expect(sql).toMatch(/invite revoked[\s\S]{0,80}42501/i);
    expect(sql).toMatch(/invite is for a different email[\s\S]{0,80}42501/i);
  });

  it("sets active_tenant_id UNCONDITIONALLY (no null-guard) to the invited tenant", () => {
    expect(sql).not.toMatch(/if\s+v_existing_profile\s+is\s+null/i);
    expect(sql).toMatch(
      /insert into profiles \(user_id, active_tenant_id\)[\s\S]{0,200}on conflict \(user_id\) do update[\s\S]{0,80}active_tenant_id = excluded\.active_tenant_id/i,
    );
  });

  it("re-asserts revoke-public + grant-authenticated", () => {
    expect(sql).toMatch(/revoke all on function accept_invite\(uuid\) from public/i);
    expect(sql).toMatch(/grant execute on function accept_invite\(uuid\) to authenticated/i);
  });
});
