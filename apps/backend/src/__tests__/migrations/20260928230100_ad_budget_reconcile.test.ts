import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260928230100_ad_budget_reconcile.sql"),
  "utf8",
);
const core = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260928210000_ad_budget_core.sql"),
  "utf8",
);
const fnOf = (name: string) => {
  const at = sql.indexOf(`create or replace function public.${name}(`);
  return sql.slice(at, sql.indexOf("end $$;", at));
};

describe("20260928230100_ad_budget_reconcile", () => {
  it("both RPCs are security definer, service-role only, and in the tenant-RPC registry", () => {
    for (const sig of ["record_ad_budget_actual(uuid, uuid, numeric)", "release_ad_budget_alarm(uuid, uuid)"]) {
      expect(sql).toContain(`revoke all on function public.${sig} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${sig} to service_role;`);
    }
    expect(sql.match(/security definer set search_path = public, pg_temp/g)).toHaveLength(2);
    const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");
    for (const fn of ["record_ad_budget_actual", "release_ad_budget_alarm"]) {
      expect(registry).toMatch(new RegExp(`\\n\\s*${fn}: "p_tenant_id",`));
    }
  });

  it("every write matches the budget on id AND tenant", () => {
    expect(fnOf("record_ad_budget_actual")).toMatch(
      /from ad_budgets\s+where id = p_budget_id and tenant_id = p_tenant_id\s+for update/,
    );
    expect(fnOf("release_ad_budget_alarm")).toMatch(/where id = p_budget_id and tenant_id = p_tenant_id/);
  });

  it("actual only goes up, and only on an active budget", () => {
    const f = fnOf("record_ad_budget_actual");
    expect(f).toContain("set actual_usd = greatest(actual_usd, ceil(p_actual_usd * 100) / 100)");
    expect(f).toMatch(/if v_budget\.status <> 'active' then\s+return/);
    expect(f.indexOf("status <> 'active'")).toBeLessThan(f.indexOf("set actual_usd"));
  });

  it("the 90% alarm is claimed once, and ending releases nothing", () => {
    const f = fnOf("record_ad_budget_actual");
    expect(f).toMatch(/alarm_90_sent_at is null and v_budget\.actual_usd >= v_budget\.total_usd \* 0\.9/);
    expect(f).toMatch(/if current_date > v_budget\.ends_on then\s+update ad_budgets set status = 'ended'/);
    expect(f).not.toMatch(/committed_usd\s*=/);
    expect(f).not.toMatch(/ad_budget_reservations/);
  });

  it("PR 1's reserve already counts actual spend against the total", () => {
    expect(core).toMatch(/committed_usd \+ greatest\(actual_usd, 0\) \+ v_amt <= total_usd/);
  });
});
