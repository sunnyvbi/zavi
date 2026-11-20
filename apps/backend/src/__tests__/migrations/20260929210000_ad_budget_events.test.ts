import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20260929210000_ad_budget_events.sql";
const sql = readFileSync(join(MIG_DIR, FILE), "utf8");
const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");
const fnOf = (name: string) => {
  const at = sql.indexOf(`create or replace function public.${name}(`);
  if (at < 0) throw new Error(`no function ${name}`);
  return sql.slice(at, sql.indexOf("$$;", sql.indexOf("$$", at) + 2));
};

const RPCS: Array<[string, string]> = [
  ["create_ad_budget", "uuid, uuid, numeric, numeric"],
  ["update_ad_budget", "uuid, uuid, uuid, numeric, numeric"],
  ["stop_ad_budget", "uuid, uuid, uuid"],
];

describe("20260929210000_ad_budget_events", () => {
  it("the events table: RLS on, members of the tenant read, nobody writes but the RPCs", () => {
    expect(sql).toContain("alter table public.ad_budget_events enable row level security;");
    expect(sql).toMatch(/create policy ad_budget_events_member_select on public\.ad_budget_events\s+for select using/);
    expect(sql).toContain("tu.user_id = auth.uid() and tu.tenant_id = ad_budget_events.tenant_id");
    expect(sql).toMatch(/ad_budget_events_active_tenant_restrict\s+on public\.ad_budget_events as restrictive for select/);
    expect(sql).not.toMatch(/create policy[^;]*on public\.ad_budget_events[^;]*for (insert|update|delete|all)/);
    expect(sql).toContain("revoke insert, update, delete, truncate on public.ad_budget_events from authenticated;");
    expect(sql).toContain("revoke all on public.ad_budget_events from public, anon;");
    expect(sql).toContain("revoke all on public.ad_budget_events from service_role;");
    expect(sql).toContain("grant select, insert on public.ad_budget_events to service_role;");
    expect(sql).not.toMatch(/grant [^;]*(update|delete|all)[^;]*on public\.ad_budget_events/);
    expect(sql).toContain("occurred_at     timestamptz not null default clock_timestamp()");
    expect(sql).toMatch(/kind\s+text not null check \(kind in \('setup', 'edit', 'stop'\)\)/);
  });

  it("the table is classified in the tenant-isolation registry", () => {
    expect(registry).toMatch(/\n\s*ad_budget_events: "tenant_id",/);
  });

  it("each RPC keeps its signature and service-role-only ACL, security definer, pinned search_path", () => {
    for (const [fn, sig] of RPCS) {
      expect(fnOf(fn)).toMatch(/security definer set search_path = public, pg_temp/);
      expect(sql).toContain(`revoke all on function public.${fn}(${sig}) from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${fn}(${sig}) to service_role;`);
    }
    expect(sql).not.toMatch(/grant execute[^;]*to (authenticated|anon|public)/);
    expect(sql).not.toMatch(/drop function/);
  });

  it("the event is written inside each RPC, after the change it records, scoped to p_tenant_id", () => {
    const create = fnOf("create_ad_budget");
    expect(create).toMatch(/insert into ad_budget_events \([^)]*\)\s+values \(p_tenant_id, v_id, 'setup', round\(p_monthly_usd, 2\), round\(p_daily_limit_usd, 2\), p_actor\)/);
    expect(create.indexOf("insert into ad_budgets")).toBeLessThan(create.indexOf("insert into ad_budget_events"));
    expect(create.indexOf("'already_active'")).toBeLessThan(create.indexOf("insert into ad_budget_events"));

    const update = fnOf("update_ad_budget");
    expect(update).toMatch(/values \(p_tenant_id, v_budget\.id, 'edit', v_monthly, round\(p_daily_limit_usd, 2\), p_actor\)/);
    expect(update.indexOf("update ad_budgets")).toBeLessThan(update.indexOf("insert into ad_budget_events"));
    expect(update.indexOf("'below_used'")).toBeLessThan(update.indexOf("insert into ad_budget_events"));
    expect(update.indexOf("'daily_below_live'")).toBeLessThan(update.indexOf("insert into ad_budget_events"));
    expect(update).toContain("if v_budget.monthly_usd is distinct from v_monthly");
    expect(update).toContain("where id = p_budget_id and tenant_id = p_tenant_id and status = 'active'");

    const stop = fnOf("stop_ad_budget");
    const active = stop.slice(stop.indexOf("if v_budget.status = 'active' then"), stop.indexOf("v_status := 'already_stopped'"));
    expect(active).toContain("set status = 'stopped'");
    expect(active).toContain("stopped_at = clock_timestamp()");
    expect(active).toMatch(/\(select stopped_at from ad_budgets where id = v_budget\.id\),\s*'stop', v_budget\.monthly_usd, v_budget\.daily_limit_usd, p_actor\)/);
    expect(stop).toContain("where id = p_budget_id and tenant_id = p_tenant_id");
  });

  it("the rebuilt RPCs keep every guard of their previous definition", () => {
    for (const fn of ["create_ad_budget", "update_ad_budget", "stop_ad_budget"]) {
      expect(fnOf(fn)).toContain("perform _ad_budget_assert_manager(p_tenant_id, p_actor);");
    }
    for (const fn of ["create_ad_budget", "update_ad_budget"]) {
      expect(fnOf(fn)).toContain("if _tenant_tier(p_tenant_id) <> 'pro' then");
    }
    expect(fnOf("stop_ad_budget")).not.toContain("_tenant_tier");
    expect(fnOf("create_ad_budget")).toContain("return jsonb_build_object('status', 'outstanding_holds');");
    expect(fnOf("update_ad_budget")).toContain("set pause_due = false, updated_at = now()");
    expect(fnOf("stop_ad_budget")).toContain("bool_or(status = 'reserved') as in_flight");
  });

  it("backfills a setup per existing budget (honestly marked) and a stop only where a person stopped it", () => {
    expect(sql).toMatch(/select b\.tenant_id, b\.id, b\.created_at, 'setup', b\.monthly_usd, b\.daily_limit_usd, b\.created_by, true/);
    expect(sql).toMatch(/select b\.tenant_id, b\.id, b\.stopped_at, 'stop', b\.monthly_usd, b\.daily_limit_usd, b\.stopped_by, true/);
    expect(sql).toContain("b.stopped_at is not null and b.stopped_by is not null");
  });

  it("is the newest definition of all three RPCs, and later than every other migration's ad budget change", () => {
    const later = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql") && f > FILE);
    for (const f of later) {
      const other = readFileSync(join(MIG_DIR, f), "utf8");
      for (const [fn] of RPCS) {
        if (f === "20261005090000_creator_hire_budget.sql" && (fn === "create_ad_budget" || fn === "update_ad_budget")) continue;
        expect(other).not.toContain(`function public.${fn}(`);
      }
    }
  });
});
