import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260928230000_ad_budget_setup_ledger.sql"),
  "utf8",
);
const fnOf = (name: string) => {
  const at = sql.indexOf(`create or replace function public.${name}(`);
  expect(at).toBeGreaterThan(-1);
  return sql.slice(at, sql.indexOf("end $$;", at));
};

const RPCS: Array<[string, string]> = [
  ["create_ad_budget", "uuid, uuid, numeric, numeric, date"],
  ["update_ad_budget", "uuid, uuid, uuid, numeric, numeric, date"],
  ["stop_ad_budget", "uuid, uuid, uuid"],
  ["release_ad_spend_for_object", "uuid, text, text, uuid"],
  ["log_ad_budget_human_action", "uuid, uuid, uuid, date, text, numeric"],
  ["_ad_budget_assert_manager", "uuid, uuid"],
];

describe("20260928230000_ad_budget_setup_ledger", () => {
  it("every RPC is security definer with a pinned search_path, service-role only", () => {
    for (const [fn, sig] of RPCS) {
      expect(fnOf(fn)).toMatch(/security definer set search_path = public, pg_temp/);
      expect(sql).toContain(`revoke all on function public.${fn}(${sig}) from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${fn}(${sig}) to service_role;`);
    }
    expect(sql).not.toMatch(/grant execute[^;]*to (authenticated|anon)/);
  });

  it("the new RPCs are in the tenant-RPC registry and the new table is classified", () => {
    const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");
    for (const fn of ["create_ad_budget", "update_ad_budget", "stop_ad_budget", "log_ad_budget_human_action", "release_ad_spend_for_object"]) {
      expect(registry).toMatch(new RegExp(`\\n\\s*${fn}: "p_tenant_id",`));
    }
    expect(registry).toMatch(/\n\s*ad_budget_human_actions: "tenant_id",/);
  });

  it("the writes check the actor's owner/admin role; create, edit and log need Pro; stop does not", () => {
    expect(fnOf("_ad_budget_assert_manager")).toMatch(/role in \('owner', 'admin'\)/);
    for (const fn of ["create_ad_budget", "update_ad_budget", "stop_ad_budget", "log_ad_budget_human_action"]) {
      expect(fnOf(fn)).toContain("perform _ad_budget_assert_manager(p_tenant_id, p_actor);");
    }
    for (const fn of ["create_ad_budget", "update_ad_budget", "log_ad_budget_human_action"]) {
      expect(fnOf(fn)).toContain("if _tenant_tier(p_tenant_id) <> 'pro' then");
    }
    expect(fnOf("stop_ad_budget")).not.toContain("_tenant_tier");
  });

  it("every budget read is scoped to p_tenant_id (no cross-tenant row)", () => {
    expect(fnOf("update_ad_budget")).toContain("where id = p_budget_id and tenant_id = p_tenant_id and status = 'active'");
    expect(fnOf("stop_ad_budget")).toContain("where id = p_budget_id and tenant_id = p_tenant_id");
    expect(fnOf("release_ad_spend_for_object")).toContain("where id = p_budget_id and tenant_id = p_tenant_id and status in ('active', 'stopped')");
    expect(fnOf("log_ad_budget_human_action")).toContain("where id = p_budget_id and tenant_id = p_tenant_id");
  });

  it("the edit keeps the committed floor and grows live holds on a later end date", () => {
    const f = fnOf("update_ad_budget");
    expect(f).toContain("'below_committed'");
    expect(f).toContain("'extension_over_total'");
    expect(f).toContain("for update");
  });

  it("a new budget is refused while a stopped one still holds money; stop flags in-flight writes", () => {
    expect(fnOf("create_ad_budget")).toContain("'outstanding_holds'");
    expect(fnOf("stop_ad_budget")).toContain("bool_or(status = 'reserved') as in_flight");
  });

  it("the end date is bounded to 90 days out, in both create and edit", () => {
    for (const fn of ["create_ad_budget", "update_ad_budget"]) {
      expect(fnOf(fn)).toContain("p_ends_on <= current_date or p_ends_on > current_date + 90");
    }
  });

  it("the old 3-argument release is replaced, not left beside the new one", () => {
    expect(sql).toContain("drop function if exists public.release_ad_spend_for_object(uuid, text, text);");
    expect(fnOf("release_ad_spend_for_object")).toContain("p_budget_id uuid default null");
  });

  it("human actions: RLS on, members read their tenant only, no write policy", () => {
    expect(sql).toContain("alter table public.ad_budget_human_actions enable row level security;");
    expect(sql).not.toMatch(/create policy[^;]*for (insert|update|delete|all)/i);
    expect(sql).toContain("as restrictive for select");
    expect(sql).toContain("revoke insert, update, delete, truncate on public.ad_budget_human_actions from authenticated;");
    expect(sql).toMatch(/note\s+text not null check \(char_length\(btrim\(note\)\) between 1 and 500\)/);
  });
});
