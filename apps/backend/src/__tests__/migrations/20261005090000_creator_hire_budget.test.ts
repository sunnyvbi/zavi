import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261005090000_creator_hire_budget.sql";
const PRIOR = "20260929010000_ad_budget_monthly.sql";
const sql = readFileSync(join(MIG_DIR, FILE), "utf8");
const prior = readFileSync(join(MIG_DIR, PRIOR), "utf8");
const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");

const fnIn = (text: string, name: string) => {
  const at = text.indexOf(`create or replace function public.${name}(`);
  if (at < 0) throw new Error(`no function ${name}`);
  return text.slice(at, text.indexOf("end $$;", at));
};
const fnOf = (name: string) => fnIn(sql, name);

const RPCS: Array<[string, string]> = [
  ["reserve_creator_hire", "uuid, text, uuid, numeric, uuid"],
  ["settle_creator_hire", "uuid, text, text"],
  ["refund_creator_hire", "uuid, uuid, numeric"],
  ["record_cgo_creator_caps", "uuid, numeric, numeric, text, uuid"],
];

describe("20261005090000_creator_hire_budget", () => {
  it("sorts after every earlier migration", () => {
    const all = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(all).toContain(FILE);
    expect(FILE > "20261004140000_memory_write_proposals.sql").toBe(true);
  });

  it("no later migration redefines what this one rebuilds", () => {
    const REBUILT_LATER: Record<string, string[]> = {
      "20261005140000_autopilot_tracking_links.sql": ["reserve_ad_spend"],
      "20261012110000_cgo_spend_pace_holds.sql": ["reserve_ad_spend", "ad_budget_month_view", "_ad_budget_held_usd"],
      "20261022140000_ad_budget_raise_holds_increase.sql": ["reserve_ad_spend"],
      "20261023125328_chatgpt_growth_autopilot.sql": ["reserve_ad_spend"],
      "20261107110000_ad_holds_bounded_by_object.sql": ["reserve_ad_spend", "_ad_budget_held_usd"],
    };
    const later = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql") && f > FILE);
    for (const f of later) {
      const t = readFileSync(join(MIG_DIR, f), "utf8");
      for (const name of ["reserve_ad_spend", "ad_budget_month_view", "_ad_budget_held_usd", "create_ad_budget", "update_ad_budget"]) {
        if (REBUILT_LATER[f]?.includes(name)) continue;
        expect(t, `${f} redefines ${name}; rebuild it from this file`).not.toContain(`function public.${name}(`);
      }
    }
  });

  it("the rebuilt functions' latest prior definition is 20260929010000", () => {
    const between = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql") && f > PRIOR && f < FILE);
    for (const f of between) {
      const t = readFileSync(join(MIG_DIR, f), "utf8");
      expect(t, `${f} redefines reserve_ad_spend`).not.toContain("function public.reserve_ad_spend(");
      expect(t, `${f} redefines ad_budget_month_view`).not.toContain("function public.ad_budget_month_view(");
    }
  });

  it("every RPC: security definer, pinned search_path, execute revoked from public/anon/authenticated, service-role only, in the tenant-RPC registry", () => {
    for (const [name, sig] of RPCS) {
      expect(fnOf(name)).toMatch(/security definer set search_path = public, pg_temp/);
      expect(sql).toContain(`revoke all on function public.${name}(${sig}) from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${name}(${sig}) to service_role;`);
      expect(registry).toMatch(new RegExp(`\\n\\s*${name}: "p_tenant_id",`));
    }
    for (const [name, sig] of [
      ["_creator_hire_used_usd", "uuid, date"],
      ["reserve_ad_spend", "uuid, text, text, text, text, numeric"],
      ["ad_budget_month_view", "uuid"],
    ]) {
      expect(sql).toContain(`revoke all on function public.${name}(${sig}) from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${name}(${sig}) to service_role;`);
    }
    expect(sql).not.toMatch(/grant execute[^;]*to (authenticated|anon|public)/);
  });

  it("both tables: RLS on, member + active-tenant select only, no client writes, service role reads only", () => {
    for (const t of ["cgo_creator_caps", "creator_hire_spend"]) {
      expect(sql).toContain(`alter table public.${t} enable row level security;`);
      expect(sql).toContain(`create policy ${t}_member_select on public.${t}\n  for select using (`);
      expect(sql).toMatch(new RegExp(`create policy ${t}_active_tenant_restrict\\s+on public\\.${t} as restrictive for select\\s+using \\(tenant_id = \\(select public\\.app_active_tenant\\(\\)\\)\\);`));
      expect(registry).toMatch(new RegExp(`\\n\\s*${t}: "tenant_id",`));
    }
    expect(sql).not.toMatch(/create policy[^;]*for (insert|update|delete|all)/i);
    expect(sql).toContain("revoke insert, update, delete, truncate on public.cgo_creator_caps, public.creator_hire_spend from authenticated;");
    expect(sql).toContain("revoke all on public.cgo_creator_caps, public.creator_hire_spend from service_role;");
    expect(sql).toContain("grant select on public.cgo_creator_caps, public.creator_hire_spend to service_role;");
  });

  it("the ledger: positive amounts, a bounded state set, one key per budget, one live row per order", () => {
    expect(sql).toContain("amount_usd   numeric(12,2) not null check (amount_usd > 0),");
    expect(sql).toContain("check (refunded_usd >= 0 and refunded_usd <= amount_usd)");
    expect(sql).toContain("check (state in ('held', 'spent', 'released', 'refunded'))");
    expect(sql).toContain("unique (budget_id, idem_key)");
    expect(sql).toMatch(/on public\.creator_hire_spend \(order_id\) where state in \('held', 'spent', 'refunded'\);/);
    expect(sql).toContain("per_hire_usd numeric(12,2) not null check (per_hire_usd > 0");
    expect(sql).toContain("per_week_usd numeric(12,2) not null check (per_week_usd > 0");
    expect(sql).toContain("why          text not null check (char_length(btrim(why)) between 1 and 300)");
  });

  it("reserve: the ad budget lock first, then the idempotent retry, then caps, week, month, in that order", () => {
    const fn = fnOf("reserve_creator_hire");
    const lock = fn.indexOf("where tenant_id = p_tenant_id and status = 'active'\n   for update;");
    const order = fn.indexOf("from creator_orders where id = p_order_id and tenant_id = p_tenant_id");
    const retry = fn.indexOf("'already_held'");
    const caps = fn.indexOf("where id = p_caps_id and tenant_id = p_tenant_id");
    const hire = fn.indexOf("'over_hire_cap'");
    const week = fn.indexOf("'over_week_cap'");
    const month = fn.indexOf("'over_budget'");
    const write = fn.indexOf("insert into creator_hire_spend");
    expect(lock).toBeGreaterThan(0);
    expect(order).toBeGreaterThan(lock);
    expect(retry).toBeGreaterThan(order);
    expect(caps).toBeGreaterThan(retry);
    expect(hire).toBeGreaterThan(caps);
    expect(week).toBeGreaterThan(hire);
    expect(month).toBeGreaterThan(week);
    expect(write).toBeGreaterThan(month);
    expect(fn).toContain("_ad_budget_month_cap(v_budget.monthly_usd, v_budget.started_on, v_today)");
    expect(fn).toContain("_ad_budget_spent_usd(v_budget.spent_usd, v_budget.month_start, v_today)");
    expect(fn).toContain("_ad_budget_held_usd(v_budget.id, v_today, v_budget.margin)");
    expect(fn).toContain("_creator_hire_used_usd(v_budget.id, v_today)");
    expect(fn).toMatch(/where s\.tenant_id = p_tenant_id\s+and s\.state in \('held', 'spent'\)\s+and s\.reserved_on > v_today - 7;/);
  });

  it("settle and refund: same lock order, spent never goes back to released, refunds cumulative and capped", () => {
    const settle = fnOf("settle_creator_hire");
    expect(settle.indexOf("from ad_budgets where id = v_budget_id and tenant_id = p_tenant_id for update")).toBeLessThan(
      settle.indexOf("from creator_hire_spend\n   where budget_id = v_budget_id and idem_key = p_idem_key and tenant_id = p_tenant_id\n   for update"),
    );
    expect(settle).toContain("(v_row.state = 'spent' and p_outcome = 'released')");
    const refund = fnOf("refund_creator_hire");
    expect(refund).toContain("from ad_budgets where id = v_budget_id and tenant_id = p_tenant_id for update");
    expect(refund).toContain("least(v_row.amount_usd, greatest(v_row.refunded_usd, floor(p_amount_usd * 100) / 100))");
    expect(refund).toContain("state in ('spent', 'refunded')");
  });

  it("the caps write: a run must be the tenant's own", () => {
    const fn = fnOf("record_cgo_creator_caps");
    expect(fn).toContain("select 1 from agent_runs where id = p_run_id and tenant_id = p_tenant_id");
    expect(fn).toContain("insert into cgo_creator_caps (tenant_id,");
  });

  it("reserve_ad_spend is a strict superset of its 20260929010000 body, and its month check sees creator used", () => {
    const before = fnIn(prior, "reserve_ad_spend");
    const after = fnOf("reserve_ad_spend");
    const clauses = [
      "if p_platform is null or p_platform not in ('meta', 'google') then",
      "if p_op is null or p_op not in ('raise', 'resume', 'create') then",
      "where tenant_id = p_tenant_id and status = 'active'\n   for update;",
      "return jsonb_build_object('status', 'refused', 'amount_usd', 0, 'reason', 'object_busy');",
      "and not pause_due",
      "v_amt := ceil(v_delta * _ad_budget_days_left(v_today) * v_budget.margin * 100) / 100;",
      "on conflict (budget_id, idem_key) do nothing",
      "if v_delta = 0 then",
      "+ _ad_budget_held_usd(v_budget.id, v_today, margin, v_res.id)",
      "then 'over_daily_limit'",
    ];
    for (const c of clauses) {
      expect(before, `prior body lost clause: ${c}`).toContain(c);
      expect(after, `rebuilt body lost clause: ${c}`).toContain(c);
    }
    const afterLines = new Set(after.split("\n"));
    const lost = before.split("\n").filter((l) => !afterLines.has(l) && !l.trim().startsWith("--"));
    expect(lost).toEqual([]);
    const beforeLines = new Set(before.split("\n"));
    const added = after.split("\n").filter((l) => !beforeLines.has(l) && !l.trim().startsWith("--"));
    expect(added).toEqual(["         + _creator_hire_used_usd(v_budget.id, v_today)"]);
  });

  it("ad_budget_month_view is a strict superset of its 20260929010000 body, and left subtracts creator held + spent", () => {
    const before = fnIn(prior, "ad_budget_month_view");
    const after = fnOf("ad_budget_month_view");
    const clauses = [
      "language plpgsql stable security definer set search_path = public, pg_temp",
      "order by (status = 'active') desc, created_at desc",
      "v_cap   := _ad_budget_month_cap(v_budget.monthly_usd, v_budget.started_on, v_today);",
      "v_spent := _ad_budget_spent_usd(v_budget.spent_usd, v_budget.month_start, v_today);",
      "v_held  := _ad_budget_held_usd(v_budget.id, v_today, v_budget.margin);",
      "'held_usd', v_held,",
      "'days_left', _ad_budget_days_left(v_today),",
    ];
    for (const c of clauses) {
      expect(before, `prior body lost clause: ${c}`).toContain(c);
      expect(after, `rebuilt body lost clause: ${c}`).toContain(c);
    }
    const afterLines = new Set(after.split("\n"));
    const lost = before.split("\n").filter((l) => !afterLines.has(l));
    expect(lost).toEqual(["    'left_usd', greatest(v_cap - v_spent - v_held, 0));"]);
    expect(after).toContain("'left_usd', greatest(v_cap - v_spent - v_held - v_cr_held - v_cr_spent, 0));");
    expect(after).toContain("'creator_held_usd', v_cr_held,");
    expect(after).toContain("'creator_spent_usd', v_cr_spent,");
  });

  it("create_ad_budget and update_ad_budget are strict supersets of their 20260929210000 bodies", () => {
    const events = readFileSync(join(MIG_DIR, "20260929210000_ad_budget_events.sql"), "utf8");
    for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith(".sql") && x > "20260929210000_ad_budget_events.sql" && x < FILE)) {
      const t = readFileSync(join(MIG_DIR, f), "utf8");
      expect(t, `${f} redefines create_ad_budget`).not.toContain("function public.create_ad_budget(");
      expect(t, `${f} redefines update_ad_budget`).not.toContain("function public.update_ad_budget(");
    }
    const code = (t: string) => t.split("\n").filter((l) => !l.trim().startsWith("--"));

    const cBefore = fnIn(events, "create_ad_budget");
    const cAfter = fnOf("create_ad_budget");
    const cAfterLines = new Set(cAfter.split("\n"));
    expect(code(cBefore).filter((l) => !cAfterLines.has(l))).toEqual([]);
    for (const c of [
      "perform _ad_budget_assert_manager(p_tenant_id, p_actor);",
      "if _tenant_tier(p_tenant_id) <> 'pro' then",
      "and r.status in ('reserved', 'committed') and r.object_id is not null",
      "exception when unique_violation then",
      "values (p_tenant_id, v_id, 'setup', round(p_monthly_usd, 2), round(p_daily_limit_usd, 2), p_actor);",
    ]) expect(cAfter).toContain(c);
    expect(cAfter).toMatch(/join creator_hire_spend s on s\.budget_id = b\.id\s+where b\.tenant_id = p_tenant_id and b\.status = 'stopped'\s+and s\.state = 'held'/);

    const uBefore = fnIn(events, "update_ad_budget");
    const uAfter = fnOf("update_ad_budget");
    const uAfterLines = new Set(uAfter.split("\n"));
    expect(code(uBefore).filter((l) => !uAfterLines.has(l))).toEqual([
      "          + _ad_budget_held_usd(v_budget.id, v_today, v_budget.margin);",
    ]);
    const uBeforeLines = new Set(uBefore.split("\n"));
    expect(code(uAfter).filter((l) => !uBeforeLines.has(l))).toEqual([
      "          + _ad_budget_held_usd(v_budget.id, v_today, v_budget.margin)",
      "          + _creator_hire_used_usd(v_budget.id, v_today);",
    ]);
    for (const c of [
      "return jsonb_build_object('status', 'below_used', 'used_usd', v_used, 'month_cap_usd', v_cap);",
      "'daily_below_live'",
      "values (p_tenant_id, v_budget.id, 'edit', v_monthly, round(p_daily_limit_usd, 2), p_actor);",
      "where budget_id = v_budget.id and status in ('reserved', 'committed') and pause_due;",
    ]) expect(uAfter).toContain(c);
    for (const [name, sig] of [["create_ad_budget", "uuid, uuid, numeric, numeric"], ["update_ad_budget", "uuid, uuid, uuid, numeric, numeric"]]) {
      expect(sql).toContain(`revoke all on function public.${name}(${sig}) from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${name}(${sig}) to service_role;`);
    }
  });

  it("_ad_budget_held_usd is NOT rebuilt: held_usd stays the ads' own number", () => {
    expect(sql).not.toContain("function public._ad_budget_held_usd(");
  });
});
