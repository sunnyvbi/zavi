
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "..", "..", "..", "..", "..", "..", "supabase", "migrations");

function newestDefining(fn: string): string {
  const files = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => new RegExp(`function\\s+${fn}\\b`, "i").test(readFileSync(join(MIG_DIR, f), "utf8")))
    .sort();
  const file = files.at(-1);
  if (!file) throw new Error(`no migration defines ${fn}`);
  return readFileSync(join(MIG_DIR, file), "utf8");
}

function bodyOf(sql: string, fn: string): string {
  const start = sql.indexOf(`create or replace function ${fn}`);
  expect(start, `${fn} not found`).toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", start);
  return sql.slice(start, end);
}

describe("the daily grant survives an upgrade", () => {
  const touch = bodyOf(newestDefining("_credit_balance_touch"), "_credit_balance_touch");

  it("PAID tenants are granted the daily allowance", () => {
    expect(touch).toMatch(/v_daily\s*:=\s*_free_daily_credits\(\)/);
  });

  it("FREE tenants get ZERO daily allowance — their grant already lives in included_*", () => {
    expect(touch).toMatch(/v_daily\s*:=\s*0/);
  });

  it("the daily window rolls on its own clock, not the monthly one", () => {
    expect(touch).toMatch(/daily_period_end/);
    expect(touch).toMatch(/current_date\s*>=\s*daily_period_end/);
  });
});

describe("availability counts both pools", () => {
  const reserve = bodyOf(newestDefining("reserve_run_credits"), "reserve_run_credits");

  it("reserve adds the daily room to spendable", () => {
    expect(reserve).toMatch(/greatest\(daily_allowance\s*-\s*daily_used,\s*0\)/);
  });

  it("reserve floors the monthly room too, so an overdrawn pool cannot eat daily or bought credits", () => {
    expect(reserve).toMatch(/greatest\(included_allowance\s*-\s*included_used,\s*0\)/);
  });

  it("the media pre-check floors the monthly room the same way", () => {
    const media = bodyOf(newestDefining("media_credits_affordable"), "media_credits_affordable");
    expect(media).toMatch(/greatest\(included_allowance\s*-\s*included_used,\s*0\)/);
  });

  it("reserve still rejects when the COMBINED pools are short", () => {
    expect(reserve).toMatch(/insufficient_credits/);
  });

  it("the unlimited bypass is preserved, not dropped in the rewrite", () => {
    expect(reserve).toMatch(/_credits_unlimited\(p_tenant_id\)/);
  });

  it("attempt-keyed idempotency is preserved", () => {
    expect(reserve).toMatch(/attempt\s*=\s*p_attempt/);
  });
});

describe("the perishable pool is spent first", () => {
  const finalize = bodyOf(newestDefining("finalize_run_credits"), "finalize_run_credits");

  it("daily is drawn before included", () => {
    const day = finalize.indexOf("v_from_day   := least");
    const inc = finalize.indexOf("v_from_inc   := least");
    expect(day).toBeGreaterThan(-1);
    expect(inc).toBeGreaterThan(-1);
    expect(day).toBeLessThan(inc);
  });

  it("included is drawn before purchased", () => {
    expect(finalize).toMatch(/v_from_pur\s*:=\s*least\(v_rem\s*-\s*v_from_inc,/);
  });

  it("the purchased draw is capped at what the tenant holds (never overdrafts)", () => {
    expect(finalize).toMatch(
      /v_from_pur\s*:=\s*least\(v_rem\s*-\s*v_from_inc,\s*greatest\(coalesce\(v_pb,\s*0\),\s*0\)\)/,
    );
    expect(finalize).toMatch(/purchased_balance\s*=\s*purchased_balance\s*-\s*v_from_pur\s*,/);
    expect(finalize).not.toMatch(/purchased_balance\s*=\s*greatest\(purchased_balance\s*-\s*v_from_pur/);
  });

  it("the row lock is still taken BEFORE the balance is read", () => {
    const lock = finalize.indexOf("for update");
    const read = finalize.indexOf("into v_ia, v_iu, v_da, v_du, v_pb");
    expect(lock).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(lock);
  });

  it("the settle ledger row still records the full metered cost", () => {
    expect(finalize).toMatch(/'settle', v_credits,/);
  });

  it("daily spend is recorded as a GRANT, never as 'purchased'", () => {
    expect(finalize).toMatch(/when \(v_from_day \+ v_from_inc\) = 0 then 'purchased'/);
  });

  it("attempt-keyed settle/refund idempotency is preserved", () => {
    expect(finalize).toMatch(/on conflict \(run_id, attempt\)/);
    expect(finalize).toMatch(/returning 1 into v_inserted/);
  });

  it("the zero-cost refund path is untouched", () => {
    expect(finalize).toMatch(/p_cost_usd is null or p_cost_usd <= 0/);
    expect(finalize).toMatch(/return 'refunded'/);
  });
});

describe("a cancelled subscription is the free tier", () => {
  const allowance = bodyOf(newestDefining("_credit_allowance_for_tenant"), "_credit_allowance_for_tenant");
  const cadence = bodyOf(newestDefining("_is_free_daily_tenant"), "_is_free_daily_tenant");

  it("allowance: canceled resolves to the free daily grant", () => {
    expect(allowance).toMatch(/when s\.status = 'canceled' then _free_daily_credits\(\)/);
  });

  it("allowance: canceled sits BELOW the grandfather + refund-block branches and ABOVE every paid branch", () => {
    const idx = (re: RegExp) => allowance.search(re);
    const grand = idx(/when s\.grandfathered/);
    const revoked = idx(/when s\.credits_revoked_at is not null/);
    const canceled = idx(/when s\.status = 'canceled'/);
    const tier = idx(/when s\.monthly_usd is not null/);
    const team = idx(/when s\.plan = 'team'/);
    expect(grand).toBeGreaterThan(-1);
    expect(grand).toBeLessThan(revoked);
    expect(revoked).toBeLessThan(canceled);
    expect(canceled).toBeLessThan(tier);
    expect(tier).toBeLessThan(team);
  });

  it("allowance: an unpaid first checkout ('incomplete') is the free daily grant, above every paid branch", () => {
    expect(allowance).toMatch(/when s\.status = 'incomplete' then _free_daily_credits\(\)/);
    expect(allowance.search(/when s\.status = 'incomplete'/)).toBeLessThan(allowance.search(/when s\.plan = 'team'/));
    expect(cadence).toMatch(/s\.status = 'incomplete'\s+and s\.credits_revoked_at is null/);
  });

  it("cadence: a canceled, non-refund-blocked tenant is on the free DAILY window", () => {
    expect(cadence).toMatch(/s\.status = 'canceled'\s+and s\.credits_revoked_at is null/);
    expect(cadence).toMatch(/not s\.grandfathered/);
  });
});

describe("the daily grant config cannot take the wallet down", () => {
  const daily = bodyOf(newestDefining("_free_daily_credits"), "_free_daily_credits");

  it("casts only after a digits-only check, with the 2,000 fallback", () => {
    expect(daily).toMatch(/free_daily_credits'\s*~\s*'\^\[0-9\]/);
    expect(daily).toMatch(/2000\s*\)/);
  });
});

describe("search_path hardening", () => {
  for (const fn of [
    "_credit_balance_touch", "reserve_run_credits", "finalize_run_credits",
    "_credit_allowance_for_tenant", "_is_free_daily_tenant", "_free_daily_credits",
  ]) {
    it(`${fn} pins search_path with pg_temp`, () => {
      expect(bodyOf(newestDefining(fn), fn)).toMatch(/set search_path = public, pg_temp/);
    });
  }
});
