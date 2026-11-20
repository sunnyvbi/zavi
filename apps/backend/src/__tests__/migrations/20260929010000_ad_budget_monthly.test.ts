import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260929010000_ad_budget_monthly.sql"),
  "utf8",
);
const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");
const fnOf = (name: string) => {
  const at = sql.indexOf(`create or replace function public.${name}(`);
  if (at < 0) throw new Error(`no function ${name}`);
  return sql.slice(at, sql.indexOf("$$;", sql.indexOf("$$", at) + 2));
};

const RPCS = [
  "reserve_ad_spend(uuid, text, text, text, text, numeric)",
  "settle_ad_spend(uuid, text, text, text)",
  "release_ad_spend_for_object(uuid, text, text, uuid)",
  "create_ad_budget(uuid, uuid, numeric, numeric)",
  "update_ad_budget(uuid, uuid, uuid, numeric, numeric)",
  "start_ad_budget_month(uuid, uuid)",
  "claim_ad_budget_month_note(uuid, uuid)",
  "release_ad_budget_month_note(uuid, uuid)",
  "record_ad_budget_actual(uuid, uuid, numeric, date)",
  "ad_budget_month_view(uuid)",
];
const HELPERS = [
  "_ad_budget_today()",
  "_ad_budget_days_left(date)",
  "_ad_budget_days_in_month(date)",
  "_ad_budget_month_cap(numeric, date, date)",
  "_ad_budget_held_usd(uuid, date, numeric, uuid)",
  "_ad_budget_spent_usd(numeric, date, date)",
];

describe("20260929010000_ad_budget_monthly", () => {
  it("every function is revoked from public/anon/authenticated and granted to service_role only", () => {
    for (const sig of [...RPCS, ...HELPERS]) {
      expect(sql).toContain(`revoke all on function public.${sig} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${sig} to service_role;`);
    }
    expect(sql).not.toMatch(/grant execute[^;]*to (anon|authenticated|public)/);
  });

  it("every tenant-facing RPC is in the tenant-RPC registry; the dead ones are not", () => {
    for (const fn of ["start_ad_budget_month", "claim_ad_budget_month_note", "release_ad_budget_month_note", "ad_budget_month_view"]) {
      expect(registry).toMatch(new RegExp(`\\n\\s*${fn}: "p_tenant_id",`));
    }
    for (const fn of ["ended_ad_budget_holds", "claim_ad_budget_end_note", "release_ad_budget_end_note"]) {
      expect(registry).not.toContain(fn);
      expect(sql).toContain(`drop function if exists public.${fn}(uuid, uuid);`);
    }
  });

  it("the end-date model is gone from the schema", () => {
    for (const col of ["ends_on", "committed_usd", "end_note_sent_at", "closed_at"]) {
      expect(sql).toContain(`drop column if exists ${col}`);
    }
    expect(sql).toContain("check (status in ('active', 'stopped'))");
    expect(sql).toMatch(/set status = 'stopped'[^;]*where status = 'ended'/);
  });

  it("reserve: one statement under the budget row lock checks spent + held + this hold against this month's cap", () => {
    const f = fnOf("reserve_ad_spend");
    expect(f).toMatch(/where tenant_id = p_tenant_id and status = 'active'\s+for update;/);
    expect(f).toMatch(
      /_ad_budget_spent_usd\(spent_usd, month_start, v_today\)\s+\+ _ad_budget_held_usd\(v_budget\.id, v_today, margin, v_res\.id\)\s+\+ v_amt <= v_cap/,
    );
    expect(f).toContain("v_amt := ceil(v_delta * _ad_budget_days_left(v_today) * v_budget.margin * 100) / 100;");
    expect(f.indexOf("if v_delta = 0 then")).toBeGreaterThan(0);
    expect(f.indexOf("if v_delta = 0 then")).toBeLessThan(f.indexOf("update ad_budgets"));
    expect(f).toContain("if p_op in ('raise', 'resume') then");
    expect(f).toMatch(/status = 'reserved' and idem_key <> p_idem_key\)/);
    expect(f.indexOf("'object_busy'")).toBeGreaterThan(0);
    expect(f.indexOf("'object_busy'")).toBeLessThan(f.indexOf("insert into ad_budget_reservations"));
    expect(f).toMatch(/status in \('reserved', 'committed'\)\s+and not pause_due/);
    expect(f).not.toContain("ends_on");
  });

  it("held for the rest of the month is computed from live daily deltas, never stored", () => {
    const f = fnOf("_ad_budget_held_usd");
    expect(f).toContain("when r.status in ('reserved', 'committed') then r.daily_delta_usd * _ad_budget_days_left(p_today)");
    expect(f).toContain("when r.status = 'released' and r.released_on = p_today then r.daily_delta_usd");
    expect(sql).not.toMatch(/committed_usd\s*=/);
  });

  it("the first month is prorated and rounded DOWN; after it the full amount", () => {
    const f = fnOf("_ad_budget_month_cap");
    expect(f).toContain("floor(p_monthly * _ad_budget_days_left(p_started_on) / _ad_budget_days_in_month(p_started_on) * 100) / 100");
    expect(f).toContain("else p_monthly");
  });

  it("the rollover resets the month, re-arms the alarm, and marks the largest rates first", () => {
    const f = fnOf("start_ad_budget_month");
    expect(f).toMatch(/where id = p_budget_id and tenant_id = p_tenant_id\s+for update;/);
    expect(f).toMatch(/if v_budget\.month_start < v_month then\s+update ad_budgets\s+set month_start = v_month, spent_usd = 0, alarm_90_sent_at = null/);
    expect(f).toContain("order by sum(daily_delta_usd) desc, platform, object_id");
    expect(f).toContain("v_need := ceil(v_rate * _ad_budget_days_in_month(v_today) * v_budget.margin * 100) / 100;");
    expect(f).toContain("set pause_due = true");
  });

  it("record: only this month's reading, only up, the alarm against this month's cap", () => {
    const f = fnOf("record_ad_budget_actual");
    expect(f).toContain("if p_actual_usd is not null and p_month = v_budget.month_start then");
    expect(f).toContain("set spent_usd = greatest(spent_usd, ceil(p_actual_usd * 100) / 100)");
    expect(f).toContain("v_budget.alarm_90_sent_at is null and v_budget.spent_usd >= v_cap * 0.9");
    expect(sql).toContain("drop function if exists public.record_ad_budget_actual(uuid, uuid, numeric);");
  });

  it("an edit below spent + held is refused; the old signatures are dropped", () => {
    const f = fnOf("update_ad_budget");
    expect(f).toContain("if v_cap < v_used then");
    expect(f).toContain("'below_used'");
    expect(f).toContain("if p_daily_limit_usd is not null and round(p_daily_limit_usd, 2) < v_live_daily then");
    expect(f.indexOf("set pause_due = false")).toBeGreaterThan(f.indexOf("set monthly_usd = v_monthly"));
    expect(sql).toContain("drop function if exists public.create_ad_budget(uuid, uuid, numeric, numeric, date);");
    expect(sql).toContain("drop function if exists public.update_ad_budget(uuid, uuid, uuid, numeric, numeric, date);");
  });
});
