import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20261013100000_setup_draft_refund_to_source_buckets.sql"),
  "utf8",
);
const fn = sql.slice(sql.indexOf("create or replace function refund_setup_draft_settle("), sql.indexOf("$$;"));

describe("20261013100000_setup_draft_refund_to_source_buckets", () => {
  it("is service_role only with a pinned search_path", () => {
    expect(fn).toMatch(/security definer set search_path = public, pg_temp/);
    expect(sql).toContain("revoke all on function refund_setup_draft_settle(uuid, uuid, int) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function refund_setup_draft_settle(uuid, uuid, int) to service_role;");
  });

  it("the refund table has RLS on and no client privileges", () => {
    expect(sql).toContain("alter table setup_draft_refunds enable row level security;");
    expect(sql).toContain("revoke all on table setup_draft_refunds from anon, authenticated;");
    expect(sql).not.toMatch(/create policy [a-z_]+ on setup_draft_refunds/);
  });

  it("never grants promo credits and only gives purchased back what was purchased", () => {
    expect(fn).not.toMatch(/grant_promo_credits/);
    expect(fn).toMatch(/v_p := greatest\(v_s\.debited_purchased, 0\);/);
    expect(fn).toMatch(/purchased_balance = purchased_balance \+ v_p,/);
  });

  it("included and daily come back only while their window is still open", () => {
    expect(fn).toMatch(/if v_bal_ps = v_s\.period_start then\s+v_i := /);
    expect(fn).toMatch(/if v_bal_dpe is not null and v_res_day is not null and v_bal_dpe = v_res_day \+ 1 then\s+v_d := /);
  });

  it("keys the daily window on the RESERVE's day, not the settle's (a run settled after midnight is not refunded out of today's grant)", () => {
    expect(fn).toMatch(/select min\(created_at\)::date into v_res_day\s+from tenant_credit_ledger\s+where run_id = p_run_id and tenant_id = p_tenant_id and kind = 'reserve' and coalesce\(attempt, 0\) = p_attempt;/);
    expect(fn).not.toMatch(/settle_day/);
  });

  it("is idempotent and skips a settle the old path already granted", () => {
    expect(sql).toMatch(/primary key \(run_id, attempt\)/);
    expect(fn).toContain("'setup-draft:' || p_run_id::text || ':' || p_attempt::text");
  });
});
