import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tierFromSubscription } from "@/services/agents/entitlement";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20261007130000_seat_cap_by_billing_tier.sql"),
  "utf8",
);
const fn = sql.slice(sql.indexOf("create or replace function invite_member"));

describe("20261007130000 seat cap by billing tier", () => {
  it("seeds Free 1 / Starter 3 / Growth 3 / Pro 10", () => {
    expect(sql).toMatch(/\('free',\s+1\)/);
    expect(sql).toMatch(/\('starter',\s+3\)/);
    expect(sql).toMatch(/\('growth',\s+3\)/);
    expect(sql).toMatch(/\('pro',\s+10\)/);
    expect(sql).toMatch(/on conflict \(tier\) do update set max_seats = excluded\.max_seats/);
  });

  it("invite_member resolves the tier through _tenant_tier, not tenants.tier", () => {
    expect(fn).toMatch(/v_tier := _tenant_tier\(v_tenant\);/);
    expect(fn).not.toMatch(/select tier into v_tier from tenants/);
    expect(fn).not.toMatch(/'pilot'/);
  });

  it("keeps the security posture and the error marker the web maps", () => {
    expect(fn).toMatch(/security definer set search_path = public, pg_temp/);
    expect(fn).toMatch(/perform _assert_tenant_admin\(v_tenant\)/);
    expect(fn).toMatch(/'seat_cap_exceeded/);
    expect(sql).toMatch(/revoke all on function invite_member\(text, text, text\[\]\) from public, anon, authenticated;/);
  });
});

describe("accept_invite re-checks the cap", () => {
  const acc = sql.slice(sql.indexOf("create or replace function accept_invite"));
  it("resolves the current tier and refuses a new seat past the cap", () => {
    expect(acc).toMatch(/v_tier := _tenant_tier\(v_invite\.tenant_id\);/);
    expect(acc).toMatch(/'seat_cap_exceeded/);
    expect(acc.indexOf("seat_cap_exceeded")).toBeLessThan(acc.indexOf("insert into tenant_users"));
    expect(acc).toMatch(/grant execute on function accept_invite\(uuid\) to authenticated;/);
  });
});

describe("tierFromSubscription", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  it("maps rows the same way as SQL _tenant_tier", () => {
    expect(tierFromSubscription(null)).toBe("free");
    expect(tierFromSubscription({ tier: "pro", status: "active", comp_expires_at: null })).toBe("pro");
    expect(tierFromSubscription({ tier: "growth", status: "canceled", comp_expires_at: null })).toBe("free");
    expect(tierFromSubscription({ tier: "pro", status: "canceled", comp_expires_at: future })).toBe("pro");
    expect(tierFromSubscription({ tier: "pro", status: "active", comp_expires_at: past })).toBe("free");
    expect(tierFromSubscription({ tier: "pilot", status: "active", comp_expires_at: null })).toBe("free");
  });
});
