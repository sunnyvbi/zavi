import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(__dirname, "../../../../../supabase/migrations/20261010120000_site_graduation.sql"), "utf-8");
const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");

const RPCS: Array<[string, string]> = [
  ["site_backend_dedicate_static", "uuid, uuid, text[]"],
  ["site_graduation_request", "uuid, uuid, text, text[]"],
  ["site_graduation_get", "uuid, uuid"],
  ["site_graduation_claim", "uuid, uuid, integer"],
  ["site_graduation_advance", "uuid, uuid, text, text, jsonb"],
  ["site_graduation_switch", "uuid, uuid, bigint, jsonb, timestamptz"],
  ["site_graduation_due", "integer"],
  ["site_graduation_request_by_site", "uuid, text"],
  ["site_member_role_audit_record", "uuid, uuid, text, text, integer"],
  ["site_kernel_register", "uuid, uuid, text, text"],
  ["site_kernel_ready", "uuid, uuid"],
  ["site_kernel_retire", "uuid, uuid"],
  ["site_kernel_ref", "uuid, uuid"],
  ["site_graduation_status", "uuid"],
  ["site_backend_settings_set", "uuid, uuid, text, jsonb, text, boolean"],
  ["site_backend_settings_get", "uuid"],
  ["site_backend_turnstile_secret", "uuid"],
];
const PLATFORM_RPCS = ["site_graduation_due", "site_graduation_request_by_site", "site_backend_settings_set", "site_backend_settings_get", "site_backend_turnstile_secret", "site_graduation_status"];
const TENANT_RPCS = RPCS.map(([n]) => n).filter((n) => !PLATFORM_RPCS.includes(n));

function fnBody(name: string): string {
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\(`, "i"));
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf("$$;", sql.indexOf("$$", start) + 2));
}
const esc = (s: string) => s.replace(/[[\]().]/g, (c) => `\\${c}`);

describe("20261010120000_site_graduation.sql", () => {
  it("both tables: RLS on, NO policy, no grant to anon / authenticated", () => {
    expect(sql).toMatch(/alter table public\.site_graduations enable row level security/);
    expect(sql).toMatch(/alter table public\.site_member_role_events enable row level security/);
    expect(sql).toMatch(/revoke all on public\.site_graduations from public, anon, authenticated/);
    expect(sql).toMatch(/revoke all on public\.site_member_role_events from public, anon, authenticated/);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/grant [^;]* to (anon|authenticated)/i);
  });

  it("every function is service-role only, security definer, pins search_path", () => {
    for (const [name, args] of RPCS) {
      const body = fnBody(name);
      expect(body, name).toMatch(/security definer/i);
      expect(body, name).toMatch(/set search_path = pg_catalog, pg_temp/i);
      expect(sql, name).toMatch(new RegExp(`revoke all on function public\\.${name}\\(${esc(args)}\\) from public, anon, authenticated;`));
      expect(sql, name).toMatch(new RegExp(`grant execute on function public\\.${name}\\(${esc(args)}\\) to service_role;`));
    }
  });

  it("every tenant RPC filters the site by id AND tenant, and is registered with an injected tenant", () => {
    for (const name of TENANT_RPCS) {
      expect(fnBody(name), name).toMatch(/(s\.id = p_site_id and s\.tenant_id = p_tenant_id|g\.site_id = p_site_id and g\.tenant_id = p_tenant_id)/);
      expect(registry, name).toMatch(new RegExp(`\\n\\s*${name}: "p_tenant_id",`));
    }
    for (const name of PLATFORM_RPCS) expect(registry).toMatch(new RegExp(`"${name}",`));
  });

  it("the switch is one locked CAS: verified, on its source shard, expected host_version, the verified target", () => {
    const b = fnBody("site_graduation_switch");
    expect(b).toMatch(/from public\.sites s where s\.id = p_site_id and s\.tenant_id = p_tenant_id for update/);
    expect(b).toMatch(/v_grad\.state <> 'verified'/);
    expect(b).toMatch(/v_site\.shard_id is distinct from v_grad\.source_shard_id/);
    expect(b).toMatch(/v_site\.host_version <> p_expected_host_version/);
    expect(b).toMatch(/p_binding->>'shard_id' is distinct from v_grad\.target_project_ref/);
    expect(b).toMatch(/host_version\s+= s\.host_version \+ 1/);
    expect(b).toMatch(/site_count = greatest\(sh\.site_count - 1, 0\)/);
  });

  it("settings: the Turnstile secret is a Vault id, never a column value; every change is audited; tenant from the row", () => {
    expect(sql).toMatch(/turnstile_secret_id\s+uuid,/);
    const table = sql.slice(sql.indexOf("create table if not exists public.site_backend_settings ("), sql.indexOf("alter table public.site_backend_settings enable"));
    expect(table).not.toMatch(/secret\s+text|secret_value/);
    const b = fnBody("site_backend_settings_set");
    expect(b).toMatch(/vault\.create_secret\(p_turnstile_secret\)/);
    expect(b).toMatch(/insert into public\.site_backend_settings_events/);
    expect(b).toMatch(/jsonb_build_object\('turnstile_secret', 'set'\)/);
    expect(b).toMatch(/from public\.sites s where s\.id = p_site_id for update/);
    expect(b).toMatch(/- 'turnstile_secret_id'/);
    expect(b).toMatch(/patch has keys outside the allowlist/);
  });

  it("a kernel shard is the site's OWN project, one site, never placeable; the switch binds the site to it", () => {
    expect(sql).toMatch(/check \(dedicated_site_id is null or \(state <> 'open' and max_sites = 1\)\)/);
    const reg = fnBody("site_kernel_register");
    expect(reg).toMatch(/v_site\.supabase_project_ref/);
    expect(reg).not.toMatch(/p_project_ref/);
    expect(fnBody("site_kernel_ready")).toMatch(/sh\.provision_step = 'done'/);
    const sw = fnBody("site_graduation_switch");
    expect(sw).toMatch(/sh\.dedicated_site_id = p_site_id and sh\.project_ref = v_grad\.target_project_ref and sh\.state = 'full'/);
    expect(sw).toMatch(/kernel_shard_id = v_kernel/);
    expect(sql).toMatch(/check \(kernel_shard_id is null or backend_mode = 'dedicated'\)/);
  });

  it("redefinitions: a live binding must name the CURRENT serving project; metrics never reopen a kernel", () => {
    const hb = fnBody("site_host_bump");
    expect(hb).toMatch(/binding_not_current/);
    expect(hb).toMatch(/coalesce\(v_row\.shard_id, v_row\.kernel_shard_id\)/);
    const m = fnBody("site_shard_record_metrics");
    expect(m.match(/and v_row\.dedicated_site_id is null then/g)).toHaveLength(2);
    expect(sql).toMatch(/revoke all on function public\.site_host_bump\(uuid, uuid, boolean, jsonb\) from public, anon, authenticated;/);
  });

  it("kernel retire touches only a one-site kernel row registered to this site", () => {
    const r = fnBody("site_kernel_retire");
    expect(r).toMatch(/where sh\.dedicated_site_id = p_site_id for update/);
    expect(r).toMatch(/v_row\.name !~ '-k\[0-9a-f\]\{32\}\$' or v_row\.max_sites <> 1/);
    expect(r).toMatch(/delete from vault\.secrets/);
  });

  it("build-time dedicate refuses any site with a pooled resource; advance only walks the machine", () => {
    const d = fnBody("site_backend_dedicate_static");
    expect(d).toMatch(/v_row\.shard_id is not null or v_row\.gateway_binding is not null/);
    expect(d).toMatch(/sp\.kind = 'pooled_backend'/);
    const a = fnBody("site_graduation_advance");
    expect(a).toMatch(/where g\.site_id = p_site_id and g\.tenant_id = p_tenant_id and g\.state = p_from/);
    expect(a).not.toMatch(/\('switched', 'rolled_back'\)/);
    expect(a).toMatch(/patch has keys outside the allowlist/);
  });
});
