
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20261013090000_creator_invite_messages.sql"),
  "utf8",
).toLowerCase();

const claim = (() => {
  const start = sql.indexOf("function public.creator_invite_message_claim_email(");
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf("$$;", start));
})();

describe("creator_invite_messages migration", () => {
  it("is service-role only: RLS on, no policies, RPC revoked from browser roles", () => {
    expect(sql).toMatch(/alter table public\.creator_invite_messages enable row level security/);
    expect(sql).not.toMatch(/create policy/);
    expect(sql).toMatch(/revoke all on public\.creator_invite_messages from public, anon, authenticated/);
    expect(sql).toMatch(/revoke all on function public\.creator_invite_message_claim_email\(uuid\) from public, anon, authenticated/);
  });

  it("the claim refuses every suppressed or held invite", () => {
    for (const col of ["unsubscribed_at", "bounced_at", "human_member_id", "claimed_at", "member_deleted_at", "send_failed_at", "hold_reason"]) {
      expect(claim).toContain(`ci.${col} is null`);
    }
  });

  it("caps per business across invitees, under a business lock taken before the invite lock", () => {
    const tenantLock = claim.indexOf("'creator_invite_message_tenant:'");
    const inviteLock = claim.indexOf("'creator_invite_message:'");
    expect(tenantLock).toBeGreaterThan(-1);
    expect(inviteLock).toBeGreaterThan(tenantLock);
    expect(claim).toMatch(/where tenant_id = v_tenant and emailed_at > now\(\) - interval '24 hours'\s*\)\s*>= 10/);
  });
});
