import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20260930030000_ad_budget_brake.sql";
const sql = readFileSync(join(MIG_DIR, FILE), "utf8");
const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");
const fnOf = (name: string) => {
  const at = sql.indexOf(`create or replace function public.${name}(`);
  if (at < 0) throw new Error(`no function ${name}`);
  return sql.slice(at, sql.indexOf("$$;", sql.indexOf("$$", at) + 2));
};
const FNS: Array<[string, string]> = [
  ["rebase_ad_spend_for_object", "uuid, text, text, numeric, text"],
  ["claim_ad_budget_brake", "uuid, uuid"],
  ["release_ad_budget_brake", "uuid, uuid"],
];

describe("20260930030000_ad_budget_brake", () => {
  it("sorts after the ledger migrations", () => {
    expect(readdirSync(MIG_DIR)).toContain(FILE);
    expect(FILE > "20260930020000_ad_ledger_removed_objects.sql").toBe(true);
  });

  it("every function: security definer, pinned search_path, service-role only, in the tenant-RPC registry", () => {
    for (const [name, sig] of FNS) {
      expect(fnOf(name)).toMatch(/security definer set search_path = public, pg_temp/);
      expect(sql).toContain(`revoke all on function public.${name}(${sig}) from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${name}(${sig}) to service_role;`);
      expect(registry).toMatch(new RegExp(`\\n\\s*${name}: "p_tenant_id",`));
    }
    expect(sql).not.toMatch(/grant execute[^;]*to (authenticated|anon|public)/);
    expect(sql).not.toMatch(/create table/i);
    expect(sql).not.toMatch(/create policy/i);
  });

  it("the op check is widened for the rebase row, and only for it", () => {
    expect(sql).toContain("check (op in ('raise', 'resume', 'create', 'rebase'))");
    expect(sql).not.toContain("function public.reserve_ad_spend(");
  });

  it("rebase: under the budget lock, idempotent first, refuses a busy object, only ever lowers, the new rate covers today", () => {
    const fn = fnOf("rebase_ad_spend_for_object");
    const lock = fn.indexOf("for update");
    const retry = fn.indexOf("'already_rebased'");
    const busy = fn.indexOf("'object_busy'");
    const lower = fn.indexOf("'not_lower'");
    const write = fn.indexOf("update ad_budget_reservations");
    expect(lock).toBeGreaterThan(0);
    expect(retry).toBeGreaterThan(lock);
    expect(busy).toBeGreaterThan(retry);
    expect(lower).toBeGreaterThan(busy);
    expect(write).toBeGreaterThan(lower);
    expect(fn).toContain("if v_new >= v_held then");
    expect(fn).toContain("set status = 'released', released_on = null, reason = 'rebased'");
    expect(fn).toMatch(/where budget_id = v_budget\.id and tenant_id = p_tenant_id\s+and platform = p_platform and object_id = p_object_id and status = 'committed'/);
    expect(fn).toContain("'rebase', v_new,");
    expect(fn).toContain("where tenant_id = p_tenant_id and status = 'active'");
  });

  it("the daily claim: once per UTC day on an active budget of the caller's tenant", () => {
    expect(sql).toContain("alter table public.ad_budgets add column if not exists brake_checked_for date;");
    const claim = fnOf("claim_ad_budget_brake");
    expect(claim).toContain("v_today date := _ad_budget_today();");
    expect(claim).toMatch(/where id = p_budget_id and tenant_id = p_tenant_id and status = 'active'\s+and brake_checked_for is distinct from v_today/);
    expect(fnOf("release_ad_budget_brake")).toMatch(/where id = p_budget_id and tenant_id = p_tenant_id/);
  });
});
