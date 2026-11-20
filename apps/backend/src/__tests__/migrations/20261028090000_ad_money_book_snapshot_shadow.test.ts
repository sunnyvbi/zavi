import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261028090000_ad_money_book_snapshot_shadow.sql";
const sql = readFileSync(join(MIGRATIONS, FILE), "utf-8");
const code = sql.replace(/--[^\n]*/g, "");
const tenantClient = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf-8");

const TABLES = ["ad_budget_snapshots", "ad_budget_shadow_verdicts"];
const FUNCTIONS: Record<string, string> = {
  record_ad_budget_snapshot: "uuid, uuid, date, timestamptz, jsonb, jsonb, text[], text[], uuid[], jsonb",
  ad_budget_shadow_context: "uuid",
  record_ad_budget_shadow_verdict: "uuid, jsonb",
};
const body = (name: string) => {
  const m = code.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$\\$;`));
  if (!m) throw new Error(`${name} not in ${FILE}`);
  return m[0];
};

describe(FILE, () => {
  it("sorts after the migrations whose objects it reads, and reuses no version", () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    for (const prior of ["20261012110000_cgo_spend_pace_holds.sql", "20261026100000_tiktok_ads_held_writes.sql"]) {
      expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf(prior));
    }
    expect(all.filter((f) => f.startsWith("20261028090000_"))).toEqual([FILE]);
  });

  it("adds new objects only: no existing money function, table or policy is rebuilt, patched or dropped", () => {
    const created = [...code.matchAll(/create (?:or replace )?function public\.([a-z0-9_]+)\(/g)].map((m) => m[1]).sort();
    expect(created).toEqual(Object.keys(FUNCTIONS).sort());
    expect([...code.matchAll(/create table if not exists public\.([a-z0-9_]+)/g)].map((m) => m[1]).sort()).toEqual([...TABLES].sort());
    expect(code).not.toMatch(/pg_get_functiondef|\bexecute\s+(?:format|definition)|\bdrop\s|\btrigger\b/i);
    for (const m of code.matchAll(/alter table public\.([a-z0-9_]+)/g)) expect(TABLES).toContain(m[1]);
    for (const fn of ["reserve_ad_spend", "_ad_budget_held_usd", "settle_ad_spend", "rebase_ad_spend_for_object", "record_ad_budget_actual"]) expect(code).not.toContain(fn);
    expect(code).not.toMatch(/(?:insert into|update|delete from)\s+(?:public\.)?(?:ad_budgets|ad_budget_reservations|ad_campaigns|ad_spend_daily|creator_hire_spend)\b/i);
    expect(code).not.toMatch(/for update/i);
  });

  it("both tables have RLS on with no member policy, and the service role may only select", () => {
    expect(code).not.toMatch(/create policy/i);
    for (const t of TABLES) {
      expect(code).toContain(`alter table public.${t} enable row level security;`);
      expect(code).toContain(`revoke all on public.${t} from public, anon, authenticated;`);
      expect(code).toContain(`revoke all on public.${t} from service_role;`);
      expect(code).toContain(`grant select on public.${t} to service_role;`);
    }
    expect(code).not.toMatch(/grant (?:all|insert|update|delete)[^;]* on public\./i);
    expect(code).not.toMatch(/grant [^;]* to (?:anon|authenticated|public)\b/i);
  });

  it("every RPC is security definer with a pinned search_path, requires a tenant, and runs for the service role only", () => {
    for (const [name, args] of Object.entries(FUNCTIONS)) {
      const fn = body(name);
      expect(fn).toMatch(/security definer set search_path = public, pg_temp/);
      expect(fn).toMatch(/if p_tenant_id is null/);
      expect(code).toContain(`revoke all on function public.${name}(${args})`);
      expect(code).toMatch(new RegExp(`grant execute on function public\\.${name}\\(${args.replace(/[[\]]/g, "\\$&")}\\)\\s+to service_role;`));
    }
    expect(body("ad_budget_shadow_context")).toMatch(/returns jsonb\s+language plpgsql stable security definer/);
  });

  it("each write names one of THIS tenant's budgets, and the context reads only this tenant's rows", () => {
    expect(body("record_ad_budget_snapshot")).toMatch(/from ad_budgets where id = p_budget_id and tenant_id = p_tenant_id/);
    expect(body("record_ad_budget_shadow_verdict")).toMatch(/from ad_budgets where id = \(p_row->>'budget_id'\)::uuid and tenant_id = p_tenant_id/);
    const ctx = body("ad_budget_shadow_context");
    expect(ctx).toContain("ad_budget_month_view(p_tenant_id)");
    expect(ctx.match(/tenant_id = p_tenant_id/g)!.length).toBeGreaterThanOrEqual(3);
    expect(body("record_ad_budget_snapshot")).toMatch(/s\.read_started_at <= excluded\.read_started_at/);
  });

  it("the tables and RPCs are registered with the tenant facade", () => {
    for (const t of TABLES) expect(tenantClient).toMatch(new RegExp(`^  ${t}: "tenant_id",$`, "m"));
    for (const name of Object.keys(FUNCTIONS)) expect(tenantClient).toMatch(new RegExp(`^  ${name}: "p_tenant_id",$`, "m"));
  });
});
