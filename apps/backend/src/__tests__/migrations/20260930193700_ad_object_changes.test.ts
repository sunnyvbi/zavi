import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20260930193700_ad_object_changes.sql";
const sql = readFileSync(join(MIG_DIR, FILE), "utf8");
const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");
const fn = (() => {
  const at = sql.indexOf("create or replace function public.record_ad_object_changes(");
  return sql.slice(at, sql.indexOf("end $$;", at));
})();

describe("20260930193700_ad_object_changes", () => {
  it("sorts after every earlier migration and its version is its own", () => {
    const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(files.at(-1) === FILE || files.indexOf(FILE) > files.indexOf("20260930170000_goal_count_rule.sql")).toBe(true);
    expect(files.filter((f) => f.startsWith("20260930193700_"))).toEqual([FILE]);
  });

  it("RLS on; members of the tenant read; nobody writes but the RPC", () => {
    expect(sql).toContain("alter table public.ad_object_changes enable row level security;");
    expect(sql).toMatch(/create policy ad_object_changes_member_select on public\.ad_object_changes\s+for select using/);
    expect(sql).toContain("tu.user_id = auth.uid() and tu.tenant_id = ad_object_changes.tenant_id");
    expect(sql).toMatch(/ad_object_changes_active_tenant_restrict\s+on public\.ad_object_changes as restrictive for select/);
    expect(sql).not.toMatch(/create policy[^;]*on public\.ad_object_changes[^;]*for (insert|update|delete|all)/);
    expect(sql).not.toMatch(/grant [^;]*(insert|update|delete|all)[^;]*on public\.ad_object_changes/);
    expect(sql).toContain("revoke all on public.ad_object_changes from public, anon;");
    expect(sql).toContain("revoke insert, update, delete, truncate on public.ad_object_changes from authenticated;");
    expect(sql).toContain("revoke all on public.ad_object_changes from service_role;");
    expect(sql).toContain("grant select on public.ad_object_changes to service_role;");
  });

  it("the shape: two sources, reversible kinds only, a Zavi row names its action, no duplicate per retry", () => {
    expect(sql).toContain("source           text not null check (source in ('zavi', 'outside'))");
    expect(sql).toContain("change_kind      text not null check (change_kind in ('status', 'budget'))");
    expect(sql).toContain("check ((source = 'zavi') = (action_table is not null))");
    expect(sql).toContain("unique (tenant_id, action_table, action_id, object_id, change_kind)");
    expect(sql).toMatch(/before_daily_usd numeric\(12,2\) check \(before_daily_usd is null or before_daily_usd >= 0\)/);
  });

  it("record_ad_object_changes: security definer, pinned search_path, service-role only, validates before it writes", () => {
    expect(fn).toMatch(/security definer set search_path = public, pg_temp/);
    expect(sql).toContain("revoke all on function public.record_ad_object_changes(uuid, jsonb) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.record_ad_object_changes(uuid, jsonb) to service_role;");
    expect(sql).not.toMatch(/grant execute[^;]*to (authenticated|anon|public)/);
    expect(fn.lastIndexOf("raise exception")).toBeLessThan(fn.indexOf("insert into ad_object_changes"));
    expect(fn).toMatch(/where a\.id = \(e->>'action_id'\)::uuid and a\.tenant_id = p_tenant_id/);
    expect(fn).toMatch(/where d\.id = \(e->>'action_id'\)::uuid and d\.tenant_id = p_tenant_id/);
    expect(fn).toMatch(/select p_tenant_id, e->>'platform'/);
    expect(fn).toContain("on conflict (tenant_id, action_table, action_id, object_id, change_kind) do nothing");
    expect(fn).not.toMatch(/\bupdate ad_object_changes\b|\bdelete from ad_object_changes\b/);
  });

  it("the table and the RPC are classified in the tenant registries", () => {
    expect(registry).toMatch(/\n\s*ad_object_changes: "tenant_id",/);
    expect(registry).toMatch(/\n\s*record_ad_object_changes: "p_tenant_id",/);
  });

  it("one transaction, nothing dropped, no earlier function replaced", () => {
    expect(sql.trim().startsWith("--")).toBe(true);
    expect(sql).toMatch(/\nbegin;\n/);
    expect(sql.trim().endsWith("commit;")).toBe(true);
    expect(sql).not.toMatch(/drop (function|table)/);
    expect([...sql.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1])).toEqual(["record_ad_object_changes"]);
  });
});
