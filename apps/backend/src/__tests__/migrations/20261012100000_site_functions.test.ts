import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(__dirname, "../../../../../supabase/migrations/20261012100000_site_functions.sql"), "utf-8");
const shard = readFileSync(join(__dirname, "../../../../../infra/site-shard/migrations/0080_function_callers.sql"), "utf-8");

describe("20261012100000_site_functions.sql (source)", () => {
  const fns = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]).filter((f) => f !== "site_fn_state_bump");

  it("every function is a security definer with a pinned search_path, service-role only", () => {
    expect(fns.length).toBeGreaterThan(20);
    for (const f of fns) {
      const body = sql.slice(sql.indexOf(`function public.${f}(`));
      expect(body.slice(0, 1200), f).toMatch(/security definer\s+set search_path = pg_catalog, pg_temp/);
      expect(sql, f).toMatch(new RegExp(`revoke all on function public\\.${f}\\([^)]*\\) from public, anon, authenticated;`));
      expect(sql, f).toMatch(new RegExp(`grant execute on function public\\.${f}\\([^)]*\\) to service_role;`));
    }
    expect(sql).not.toMatch(/grant [^;]*\bto (anon|authenticated)\b/);
  });

  it("RLS on every table, no policies, no table grants to the API roles", () => {
    for (const t of ["site_function_state", "site_function_deployments", "site_function_secrets", "site_function_schedules", "site_function_runs", "site_function_logs"]) {
      expect(sql).toMatch(new RegExp(`alter table public\\.${t}\\s+enable row level security`));
    }
    expect(sql).not.toMatch(/create policy/);
  });

  it("tenant RPCs re-check the site row's tenant", () => {
    expect(sql).toMatch(/where s\.id = p_site_id and s\.tenant_id = p_tenant_id\s+and s\.status not in \('deleting', 'deleted'\)/);
    for (const f of ["site_fn_secret_set", "site_fn_secret_delete", "site_fn_secret_list", "site_fn_stage", "site_fn_activate", "site_fn_set_status", "site_fn_schedule_set_enabled", "site_fn_overview", "site_fn_runs_list", "site_fn_logs_list"]) {
      const body = sql.slice(sql.indexOf(`function public.${f}(`), sql.indexOf("end $$;", sql.indexOf(`function public.${f}(`)));
      expect(body, f).toContain("site_fn_assert_site(p_tenant_id");
    }
  });

  it("Vault: a rotated / deleted value is retired (kept 8 days for log redaction, then deleted), never the dead vault.delete_secret; list never returns values", () => {
    expect(sql).not.toContain("vault.delete_secret");
    expect(sql).toMatch(/insert into public\.site_function_retired_secrets \(vault_secret_id, site_id, tenant_id\)\s+values \(v_old, p_site_id, p_tenant_id\)/);
    expect(sql).toMatch(/r3\.retired_at < p_now - interval '8 days'/);
    expect(sql).toMatch(/delete from vault\.secrets vs where vs\.id in \(select gone\.vault_secret_id from gone\)/);
    expect(sql).toMatch(/octet_length\(p_value\) < 8/);
    const list = sql.slice(sql.indexOf("function public.site_fn_secret_list("), sql.indexOf("end $$;", sql.indexOf("function public.site_fn_secret_list(")));
    expect(list).not.toContain("decrypted");
  });

  it("an older generation can never replace a newer one", () => {
    expect(sql).toMatch(/if v_active is not null and p_generation <= v_active then\s+return 'superseded';/);
    expect(sql).toMatch(/if v_active is not null and p_generation < v_active then\s+return jsonb_build_object\('outcome', 'superseded'/);
  });

  it("KV is derived state: every status / generation / script change bumps the version and marks it dirty", () => {
    expect(sql).toMatch(/new\.sync_version := old\.sync_version \+ 1;\s+new\.kv_dirty := true;/);
    expect(sql).toMatch(/kv_dirty = case when p_ok and x\.sync_version = p_version then false else x\.kv_dirty end/);
    expect(sql).toMatch(/where x\.site_id = p_site_id and \(x\.reconcile_until is null or x\.reconcile_until < now\(\)\)/);
  });

  it("a disabled schedule or a stopped site can never fire or run", () => {
    expect(sql).toMatch(/where sc\.id = p_id and sc\.next_run_at = p_expected_next and sc\.enabled/);
    expect(sql).toMatch(/join public\.site_function_schedules sc on sc\.site_id = r\.site_id and sc\.name = r\.schedule_name and sc\.enabled/);
  });

  it("one run per (site, schedule, slot)", () => {
    expect(sql).toMatch(/idempotency_key text not null unique/);
    expect(sql).toMatch(/on conflict \(idempotency_key\) do nothing/);
  });
});

describe("infra/site-shard/migrations/0080_function_callers.sql (source)", () => {
  it("a function caller matches only fn:<name> (and admin when zfn_admin), never anyone / signed_in / owner", () => {
    expect(shard).toMatch(/if v_fn is not null then\s+return p_principals \? \('fn:' \|\| v_fn\)\s+or \(coalesce\(\(p_ctx->>'fn_admin'\)::boolean, false\) and p_principals \? 'admin'\);/);
    expect(shard).toContain("(e #>> '{}') ~ '^fn:[a-z][a-z0-9-]{0,47}$'");
  });

  it("only under the authenticated DB role, never a member", () => {
    expect(shard).toMatch(/current_setting\('role', true\) is distinct from 'authenticated' then return null/);
    expect(shard).toMatch(/'fn', v_fn->>'fn', 'fn_admin'/);
    expect(shard).toMatch(/v_signed boolean := \(c->>'uid'\) is not null or \(c->>'fn'\) is not null;/);
  });
});
