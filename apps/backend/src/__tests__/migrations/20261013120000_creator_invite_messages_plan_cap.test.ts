
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(DIR, "20261013120000_creator_invite_messages_plan_cap.sql"), "utf8").toLowerCase();

const claim = (() => {
  const start = sql.indexOf("function public.creator_invite_message_claim_email(p_message_id uuid, p_daily_cap integer)");
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf("$$;", start));
})();

describe("creator_invite_messages plan-cap migration", () => {
  it("has a unique version", () => {
    expect(readdirSync(DIR).filter((f) => f.startsWith("20261013120000_"))).toHaveLength(1);
  });

  it("drops the one-argument draft so no caller can skip the cap", () => {
    expect(sql).toMatch(/drop function if exists public\.creator_invite_message_claim_email\(uuid\);/);
    expect(sql.indexOf("drop function if exists")).toBeLessThan(sql.indexOf("create or replace function"));
  });

  it("refuses a cap that is null or outside 0..1000 before reading anything", () => {
    expect(claim).toMatch(/if p_daily_cap is null or p_daily_cap < 0 or p_daily_cap > 1000 then\s+raise exception/);
    expect(claim.indexOf("p_daily_cap > 1000")).toBeLessThan(claim.indexOf("from public.creator_invite_messages"));
  });

  it("is service-role only", () => {
    expect(sql).toMatch(
      /revoke all on function public\.creator_invite_message_claim_email\(uuid, integer\) from public, anon, authenticated/,
    );
    expect(sql).toMatch(/grant execute on function public\.creator_invite_message_claim_email\(uuid, integer\) to service_role/);
    expect(claim).toContain("security definer");
    expect(claim).toContain("set search_path = public, pg_temp");
  });

  it("refuses every suppressed or held invite", () => {
    for (const col of ["unsubscribed_at", "bounced_at", "human_member_id", "claimed_at", "member_deleted_at", "send_failed_at", "hold_reason"]) {
      expect(claim).toContain(`ci.${col} is null`);
    }
  });

  it("keeps the per-invitee caps and enforces the passed plan cap under the business lock", () => {
    const tenantLock = claim.indexOf("'creator_invite_message_tenant:'");
    const inviteLock = claim.indexOf("'creator_invite_message:'");
    expect(tenantLock).toBeGreaterThan(-1);
    expect(inviteLock).toBeGreaterThan(tenantLock);
    expect(claim).toMatch(/where invite_id = v_invite and tenant_id = v_tenant and emailed_at is not null/);
    expect(claim).toMatch(/where invite_id = v_invite and emailed_at > now\(\) - interval '7 days'\s*\)\s*>= 3/);
    expect(claim).toMatch(/where tenant_id = v_tenant and emailed_at > now\(\) - interval '24 hours'\s*\)\s*>= p_daily_cap\s+then\s+return 'business_daily_cap'/);
    expect(claim.indexOf("'business_daily_cap'")).toBeGreaterThan(inviteLock);
    expect(claim).not.toMatch(/>= 10\b/);
  });

  it("holds the yopmail test invites, idempotently, with the check constraint widened first", () => {
    expect(sql).toMatch(/'email_conflict', 'test_address'\)\)/);
    expect(sql.indexOf("add constraint creator_invites_hold_reason_check")).toBeLessThan(sql.indexOf("set hold_reason = 'test_address'"));
    expect(sql).toMatch(/where lower\(email\) like '%@yopmail\.com'\s+and hold_reason is null/);
  });
});
