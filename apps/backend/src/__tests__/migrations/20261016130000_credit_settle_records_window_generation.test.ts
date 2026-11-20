import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(dir, "20261016130000_credit_settle_records_window_generation.sql"), "utf8");
const touchPrev = readFileSync(join(dir, "20260922230100_credit_window_rolls_at_billing_moment.sql"), "utf8");
const finalPrev = readFileSync(join(dir, "20261006120000_tool_side_costs_and_late_charge_refund.sql"), "utf8");
const fn = (s: string, name: string) => {
  const start = s.indexOf(`create or replace function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  return s.slice(start, s.indexOf("end $$;", start));
};

describe("20261016130000_credit_settle_records_window_generation", () => {
  it("adds generation counters to the wallet (not null, 0) and nullable ones to the ledger", () => {
    expect(sql).toContain("alter table tenant_credit_balances add column if not exists included_gen bigint not null default 0;");
    expect(sql).toContain("alter table tenant_credit_balances add column if not exists daily_gen    bigint not null default 0;");
    expect(sql).toContain("alter table tenant_credit_ledger   add column if not exists included_gen bigint;");
    expect(sql).toContain("alter table tenant_credit_ledger   add column if not exists daily_gen    bigint;");
  });

  it("the wallet roll is unchanged except for bumping a generation exactly when usage resets", () => {
    const now = fn(sql, "_credit_balance_touch");
    const gen = /         -- A new usage generation[\s\S]*?then 1 else 0 end,\n(?=         daily_period_end)/;
    expect(now).toMatch(gen);
    expect(now.replace(gen, "")).toBe(fn(touchPrev, "_credit_balance_touch"));
    expect(now).toMatch(/included_gen\s+= included_gen \+ case when v_today >= period_end\s+or \(period_end - period_start = 1\) <> v_free/);
    expect(now).toMatch(/daily_gen\s+= daily_gen \+ case when daily_period_end is null\s+or current_date >= daily_period_end\s+or v_daily = 0/);
  });

  it("finalize charges exactly as before and only also records the generations it debited", () => {
    const now = fn(sql, "finalize_run_credits");
    const strip = (s: string) =>
      s
        .replace("\n  v_ig         bigint;\n  v_dg         bigint;", "")
        .replace(",\n         included_gen, daily_gen\n    into v_ia, v_iu, v_da, v_du, v_pb, v_ig, v_dg", "\n    into v_ia, v_iu, v_da, v_du, v_pb")
        .replace(/  -- included_gen \/ daily_gen \(20261016130000\)[^\n]*\n[^\n]*\n/, "")
        .replace(", debited_purchased, included_gen, daily_gen)", ", debited_purchased)")
        .replace(", v_from_pur, v_ig, v_dg)", ", v_from_pur)");
    expect(strip(now)).toBe(fn(finalPrev, "finalize_run_credits"));
    expect(now).toContain("v_credits := ceil(p_cost_usd / 0.0025)::int;");
  });

  it("keeps both functions' grants and pinned search_path; reserve_run_credits is not touched", () => {
    expect(sql).toContain("revoke all on function _credit_balance_touch(uuid) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function _credit_balance_touch(uuid) to service_role;");
    expect(sql).toContain("revoke all on function finalize_run_credits(uuid, numeric, text) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function finalize_run_credits(uuid, numeric, text) to service_role;");
    expect(fn(sql, "_credit_balance_touch")).toContain("security definer set search_path = public, pg_temp");
    expect(fn(sql, "finalize_run_credits")).toContain("security definer set search_path = public, pg_temp");
    expect(sql).not.toMatch(/function reserve_run_credits/);
  });
});
