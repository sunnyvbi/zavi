import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260928210000_ad_budget_core.sql"),
  "utf8",
);
const fnOf = (name: string) => {
  const at = sql.indexOf(`create or replace function public.${name}(`);
  return sql.slice(at, sql.indexOf("end $$;", at));
};

describe("20260928210000_ad_budget_core", () => {
  it("every new RPC is in the tenant-RPC registry and both tables are classified", () => {
    const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");
    for (const fn of ["reserve_ad_spend", "settle_ad_spend", "release_ad_spend_for_object"]) {
      expect(registry).toMatch(new RegExp(`\\n\\s*${fn}: "p_tenant_id",`));
    }
    for (const t of ["ad_budgets", "ad_budget_reservations"]) {
      expect(registry).toMatch(new RegExp(`\\n\\s*${t}: "tenant_id",`));
    }
  });

  it("the RPCs are security definer, service-role only", () => {
    for (const sig of [
      "reserve_ad_spend(uuid, text, text, text, text, numeric)",
      "settle_ad_spend(uuid, text, text, text)",
      "release_ad_spend_for_object(uuid, text, text)",
    ]) {
      expect(sql).toContain(`revoke all on function public.${sig} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${sig} to service_role;`);
    }
    expect(sql.match(/security definer set search_path = public, pg_temp/g)).toHaveLength(3);
  });

  it("RLS on, members read only, no tenant write policy", () => {
    expect(sql).toContain("alter table public.ad_budgets enable row level security;");
    expect(sql).toContain("alter table public.ad_budget_reservations enable row level security;");
    expect(sql).not.toMatch(/create policy[^;]*for (insert|update|delete|all)/i);
    expect(sql).toContain("revoke insert, update, delete, truncate on public.ad_budgets, public.ad_budget_reservations from authenticated;");
  });

  it("one active budget per tenant, one reservation per (budget, idem_key)", () => {
    expect(sql).toMatch(/unique index[\s\S]*ad_budgets \(tenant_id\) where status = 'active'/);
    expect(sql).toContain("unique (budget_id, idem_key)");
  });

  it("reserve locks the budget row first, then takes the hold in one guarded UPDATE", () => {
    const f = fnOf("reserve_ad_spend");
    const lock = f.search(/from ad_budgets\s+where tenant_id = p_tenant_id and status = 'active'\s+for update/);
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(f.indexOf("insert into ad_budget_reservations"));
    expect(f).toContain("on conflict (budget_id, idem_key) do nothing");
    expect(f).toMatch(/set committed_usd = committed_usd \+ v_amt[\s\S]*committed_usd \+ greatest\(actual_usd, 0\) \+ v_amt <= total_usd/);
    expect(f).toMatch(/daily_limit_usd is null or[\s\S]*\+ v_delta <= daily_limit_usd/);
    expect(f).not.toMatch(/p_amount/);
    expect(f).toMatch(/v_amt\s+:= ceil\(v_delta \* v_days \* v_budget\.margin \* 100\) \/ 100/);
  });

  it("settle and release take the same lock order: budget, then reservation", () => {
    for (const name of ["settle_ad_spend", "release_ad_spend_for_object"]) {
      const f = fnOf(name);
      const budgetLock = f.search(/from ad_budgets[^;]*for update/);
      const resLock = f.search(/from ad_budget_reservations[^;]*for update/);
      expect(budgetLock, name).toBeGreaterThan(0);
      expect(budgetLock, name).toBeLessThan(resLock);
    }
  });

  it("settle only moves a 'reserved' hold, so a replay is a no-op", () => {
    expect(fnOf("settle_ad_spend")).toMatch(/if v_res\.status <> 'reserved' then\s+return/);
  });

  it("a pause releases committed holds only, never more than is still held, and not today", () => {
    const f = fnOf("release_ad_spend_for_object");
    expect(f).toContain("status = 'committed'");
    expect(f).toContain("v_left := greatest(v_budget.ends_on - current_date, 0)");
    expect(f).toMatch(/least\(\s*v_res\.amount_usd - v_res\.released_usd,/);
  });
});
