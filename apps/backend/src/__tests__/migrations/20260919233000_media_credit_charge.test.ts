import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations", "20260919233000_media_credit_charge.sql"), "utf8");

describe("20260919233000_media_credit_charge", () => {
  it("kind check lists every written kind including media and topup_revoke", () => {
    const m = sql.match(/check \(kind in \(([^)]*)\)\)/);
    expect(m).not.toBeNull();
    for (const k of ["reserve", "settle", "refund", "topup", "topup_revoke", "grant", "media"]) expect(m![1]).toContain(`'${k}'`);
  });
  it("charge is idempotent on media_key", () => {
    expect(sql).toMatch(/create unique index if not exists tenant_credit_ledger_media_key_uq[\s\S]*where kind = 'media'/);
    expect(sql).toMatch(/on conflict \(media_key\) where kind = 'media' and media_key is not null\s+do nothing/);
  });
  it("never draws purchased credits below zero", () => {
    expect(sql).toMatch(/v_from_pur\s*:=\s*least\(v_rem - v_from_inc, greatest\(coalesce\(v_pb, 0\), 0\)\)/);
  });
  it("rejects a run that belongs to another tenant", () => {
    expect(sql).toMatch(/raise exception 'tenant_mismatch'/);
  });
  it("affordability mirrors reserve_run_credits and honours unlimited", () => {
    expect(sql).toMatch(/\(included_allowance - included_used\)\s*\+ greatest\(daily_allowance - daily_used, 0\)\s*\+ purchased_balance - reserved/);
    expect(sql).toMatch(/_credits_unlimited\(p_tenant_id\)/);
  });
  it("both functions are service_role only with a pinned search_path", () => {
    expect((sql.match(/security definer set search_path = public, pg_temp/g) ?? []).length).toBe(2);
    expect(sql).toMatch(/revoke all on function charge_media_credits\(uuid, text, numeric, text, text, uuid\) from public, anon, authenticated;/);
    expect(sql).toMatch(/grant execute on function charge_media_credits\(uuid, text, numeric, text, text, uuid\) to service_role;/);
    expect(sql).toMatch(/revoke all on function media_credits_affordable\(uuid, numeric\) from public, anon, authenticated;/);
    expect(sql).toMatch(/grant execute on function media_credits_affordable\(uuid, numeric\) to service_role;/);
  });
});
