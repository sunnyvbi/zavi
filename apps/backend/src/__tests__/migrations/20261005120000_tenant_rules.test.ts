import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20261005120000_tenant_rules.sql"),
  "utf8",
);
const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");

const RPCS = [
  "rule_add", "rule_activate", "rule_edit", "rule_dismiss", "rule_delete",
  "rule_delete_all", "rule_set_suggestions_paused", "rule_list",
];

describe("20261005120000_tenant_rules.sql", () => {
  it("tenant_rules: RLS on, members read, the excerpt and span are not granted to authenticated", () => {
    expect(sql).toMatch(/alter table public\.tenant_rules enable row level security/);
    expect(sql).toContain("tu.user_id = auth.uid() and tu.tenant_id = tenant_rules.tenant_id");
    expect(sql).toMatch(/tenant_rules_active_tenant_restrict\s+on public\.tenant_rules as restrictive for select\s+using \(tenant_id = \(select public\.app_active_tenant\(\)\)\)/);
    const grant = sql.match(/grant select \(([^)]*)\)\s+on public\.tenant_rules to authenticated/);
    expect(grant).not.toBeNull();
    expect(grant![1]).not.toMatch(/excerpt|source_start|source_end|source_ref|source_hash/);
    expect(sql).toMatch(/revoke all on public\.tenant_rules from public, anon, authenticated/);
  });

  it("no write policy: only the security-definer RPCs write", () => {
    expect(sql).not.toMatch(/create policy [a-z_]+ on public\.tenant_rules\s+for (insert|update|delete|all)/i);
    expect(sql).toMatch(/revoke all on public\.tenant_rules from service_role;\s*grant select on public\.tenant_rules to service_role/);
  });

  it("every rule RPC is service_role only and re-checks the actor inside", () => {
    for (const fn of RPCS) {
      expect(sql, fn).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\)\\s*from public, anon, authenticated`));
      expect(sql, fn).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\)\\s*to service_role`));
      const body = sql.slice(sql.indexOf(`function public.${fn}(`));
      const head = body.slice(0, body.indexOf("end $$;"));
      expect(head, fn).toMatch(/_rules_assert_manager\(p_tenant_id, p_actor\)|_rules_actor_role\(p_tenant_id, p_actor\)/);
    }
  });

  it("activation takes the per-tenant lock before counting", () => {
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtextextended\('tenant_rules:' \|\| p_tenant_id::text, 0\)\)/);
  });

  it("delete clears the words, excerpt and span", () => {
    for (const fn of ["rule_delete", "rule_delete_all"]) {
      const body = sql.slice(sql.indexOf(`function public.${fn}(`));
      expect(body.slice(0, body.indexOf("end $$;")), fn).toMatch(
        /status = 'deleted', text = '', excerpt = null,\s*source_start = null, source_end = null/,
      );
    }
  });

  it("records the applied rule set on each run", () => {
    expect(sql).toMatch(/alter table public\.agent_runs add column if not exists rule_set_hash text/);
  });

  it("the tables and RPCs are classified in the tenant-isolation registry", () => {
    expect(registry).toMatch(/\n\s*tenant_rules: "tenant_id",/);
    expect(registry).toMatch(/\n\s*tenant_rule_settings: "tenant_id",/);
    for (const fn of RPCS) expect(registry, fn).toMatch(new RegExp(`\\n\\s*${fn}: "p_tenant_id",`));
  });
});
