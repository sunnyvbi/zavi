import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20261016140000_autopilot_refund_to_source_buckets.sql"),
  "utf8",
);
const fnOf = (name: string) => {
  const start = sql.indexOf(`create or replace function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf("$$;", start));
};

describe("20261016140000_autopilot_refund_to_source_buckets", () => {
  it("every function is security definer with a pinned search_path", () => {
    for (const fn of ["_refund_settle_to_source_buckets", "refund_setup_draft_settle", "refund_autopilot_run"]) {
      expect(fnOf(fn)).toMatch(/security definer set search_path = public, pg_temp/);
    }
  });

  it("the entry points are service_role only; the shared helper is grantable to no one", () => {
    expect(sql).toContain("revoke all on function refund_autopilot_run(uuid, uuid) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function refund_autopilot_run(uuid, uuid) to service_role;");
    expect(sql).toContain("revoke all on function refund_setup_draft_settle(uuid, uuid, int) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function refund_setup_draft_settle(uuid, uuid, int) to service_role;");
    expect(sql).toContain(
      "revoke all on function _refund_settle_to_source_buckets(uuid, uuid, int, text) from public, anon, authenticated, service_role;",
    );
    expect(sql).not.toMatch(/grant execute on function _refund_settle_to_source_buckets/);
    expect(fnOf("refund_autopilot_run")).toMatch(/if auth\.uid\(\) is not null then\s+raise exception/);
  });

  it("the autopilot refund never mints purchased credits from the whole debit", () => {
    const f = fnOf("refund_autopilot_run");
    expect(f).not.toMatch(/purchased_balance/);
    expect(f).not.toMatch(/insert into tenant_credit_ledger/);
    expect(f).not.toMatch(/grant_promo_credits/);
    expect(f).toContain("_refund_settle_to_source_buckets(p_tenant_id, p_run_id, v_att, 'autopilot_guarantee')");
  });

  it("both refund paths share one settle refund (no duplicated bucket logic)", () => {
    expect(fnOf("refund_setup_draft_settle")).toContain("_refund_settle_to_source_buckets(p_tenant_id, p_run_id, p_attempt, 'setup_draft')");
    expect(fnOf("refund_setup_draft_settle")).not.toMatch(/purchased_balance/);
  });

  it("each bucket goes back to itself; included and daily only while their window is open", () => {
    const f = fnOf("_refund_settle_to_source_buckets");
    expect(f).toMatch(/v_p := greatest\(v_s\.debited_purchased, 0\);/);
    expect(f).toMatch(/purchased_balance = purchased_balance \+ v_p,/);
    expect(f).toMatch(/included_used\s+= greatest\(included_used - v_i, 0\),/);
    expect(f).toMatch(/daily_used\s+= greatest\(daily_used - v_d, 0\),/);
  });

  it("a settle that records its generations refunds a bucket only while that generation is current", () => {
    const f = fnOf("_refund_settle_to_source_buckets");
    expect(f).toMatch(/period_start,\s+included_gen, daily_gen\s+into v_s/);
    expect(f).toMatch(/if v_s\.included_gen is not null and v_s\.daily_gen is not null then\s+[\s\S]*?if v_bal_ig = v_s\.included_gen then\s+v_i := [\s\S]*?if v_bal_dg = v_s\.daily_gen then\s+v_d := /);
    expect(f.indexOf("perform _credit_balance_touch(p_tenant_id)")).toBeLessThan(f.indexOf("v_bal_ig = v_s.included_gen"));
  });

  it("an older settle without generations keeps the conservative date rule (never more)", () => {
    const f = fnOf("_refund_settle_to_source_buckets");
    const old = f.slice(f.indexOf("  else\n"));
    expect(old).toMatch(/if v_bal_ps = v_s\.period_start\s+and not \(v_bal_pe - v_bal_ps > 1 and v_s\.period_start = v_res_day\) then\s+v_i := /);
    expect(old).toMatch(/if v_bal_dpe is not null and v_bal_dpe = v_res_day \+ 1 then\s+v_d := /);
  });

  it("requires the run's reserve row (every real settle has one)", () => {
    expect(fnOf("_refund_settle_to_source_buckets")).toMatch(
      /select min\(created_at\)::date into v_res_day\s+from tenant_credit_ledger\s+where run_id = p_run_id and tenant_id = p_tenant_id and kind = 'reserve' and coalesce\(attempt, 0\) = p_attempt;/,
    );
  });

  it("never refunds more than was debited: missing debit, buckets or reserve, or overstated buckets, pay nothing", () => {
    const f = fnOf("_refund_settle_to_source_buckets");
    expect(f).toMatch(
      /if v_s\.debited is null or v_s\.debited_daily is null or v_s\.debited_included is null\s+or v_s\.debited_purchased is null or v_total > v_s\.debited or v_res_day is null then/,
    );
    expect(f).toContain("'status', 'untracked', 'credits', 0");
  });

  it("idempotent per (run, attempt) across both paths, and skips what the old purchased path already paid", () => {
    const f = fnOf("_refund_settle_to_source_buckets");
    expect(f).toContain("'setup-draft:' || p_run_id::text || ':' || p_attempt::text");
    expect(f).toContain("'autopilot-guarantee:' || p_run_id::text");
    expect(f).toMatch(/select 1 from setup_draft_refunds where run_id = p_run_id and attempt = p_attempt/);
    expect(f.indexOf("perform _credit_balance_touch(p_tenant_id)")).toBeLessThan(f.indexOf("from setup_draft_refunds"));
    expect(fnOf("refund_autopilot_run")).toContain("'already_refunded'");
    expect(fnOf("refund_autopilot_run")).toMatch(/sum\(refunded_daily \+ refunded_included \+ refunded_purchased\), 0\)[\s\S]*>= v_debited[\s\S]*'already_claimed'/);
  });

  it("still only this tenant's cgo run, and only once every attempt has settled", () => {
    const f = fnOf("refund_autopilot_run");
    expect(f).toMatch(/tenant_id = p_tenant_id and agent_slug = 'cgo'/);
    expect(f.indexOf("'pending'")).toBeGreaterThan(-1);
    expect(f.indexOf("'pending'")).toBeLessThan(f.indexOf("_refund_settle_to_source_buckets("));
    expect(f).toMatch(/r\.kind = 'reserve'[\s\S]*t\.attempt = r\.attempt and t\.kind in \('settle', 'refund'\)/);
  });

  it("the refund record table keeps RLS and gains no client access", () => {
    expect(sql).not.toMatch(/create policy/);
    expect(sql).not.toMatch(/grant [a-z, ]+ on (table )?setup_draft_refunds/);
    expect(sql).toMatch(/check \(reason in \('setup_draft', 'autopilot_guarantee'\)\)/);
  });
});
