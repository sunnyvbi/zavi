import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_HOST_LABELS, RESERVED_LABELS } from "@/services/provisioning/builtin-url";
import { SITE_BASE_DOMAIN_RE, SITE_HOSTNAME_SUFFIX_RE } from "@/services/sites/label";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20261008090000_sites.sql"),
  "utf-8",
);

const RPCS: Array<[string, string]> = [
  ["site_get_or_create_for_run", "uuid, uuid, text, uuid, text, text"],
  ["site_update", "uuid, uuid, jsonb"],
  ["site_transition", "uuid, uuid, text[], text, jsonb"],
  ["site_activate_if_desired", "uuid, uuid, text, text, text"],
  ["site_provider_claim", "uuid, uuid, text, jsonb"],
  ["site_provider_set", "uuid, uuid, text, text, jsonb"],
  ["site_provider_schedule_delete", "uuid, uuid, text, int, jsonb"],
  ["site_provider_cancel_delete", "uuid, uuid, text, jsonb"],
  ["site_provider_begin_delete", "uuid, uuid, text, text"],
  ["site_by_hostname", "text"],
  ["site_claim_idle_batch", "timestamptz, int"],
];

function fnBody(name: string): string {
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\(`, "i"));
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  const end = sql.indexOf("end $$;", start);
  return sql.slice(start, end);
}

const esc = (s: string) => s.replace(/[[\]()]/g, (c) => `\\${c}`);

describe("20261008090000_sites.sql", () => {
  it("creates sites and site_providers with RLS on and a member-only SELECT policy", () => {
    expect(sql).toMatch(/create table if not exists public\.sites/i);
    expect(sql).toMatch(/create table if not exists public\.site_providers/i);
    expect(sql).toMatch(/alter table public\.sites enable row level security/i);
    expect(sql).toMatch(/alter table public\.site_providers enable row level security/i);
    expect(sql).toMatch(/create policy sites_select on public\.sites\s+for select using/i);
    expect(sql).toMatch(/create policy site_providers_select on public\.site_providers\s+for select using/i);
    expect(sql).not.toMatch(/create policy[^;]*for (insert|update|delete|all)\b/i);
  });

  it("has every SiteRow column and the uniqueness the plan requires", () => {
    for (const col of [
      "id", "tenant_id", "root_conductor_run_id", "started_by_user_id", "owner_email", "label", "hostname",
      "github_full_name", "supabase_project_ref", "supabase_url", "status", "live_url", "desired_sha",
      "live_sha", "live_deploy_id", "last_visit_at", "last_edit_at", "paused_at", "last_error",
      "created_at", "updated_at",
    ]) {
      expect(sql, col).toMatch(new RegExp(`^\\s+${col}\\s+(uuid|text|timestamptz)`, "m"));
    }
    expect(sql).toMatch(/unique index if not exists sites_label_uq on public\.sites \(label\)/i);
    expect(sql).toMatch(/unique index if not exists sites_hostname_uq on public\.sites \(hostname\)/i);
    expect(sql).toMatch(/sites_root_run_uq\s+on public\.sites \(root_conductor_run_id\) where root_conductor_run_id is not null/i);
    expect(sql).toMatch(/sites_github_full_name_uq\s+on public\.sites \(lower\(github_full_name\)\)/i);
    expect(sql).toMatch(/primary key \(site_id, kind\)/i);
  });

  it("constrains status, provider kind and provider state to the contract unions", () => {
    expect(sql).toMatch(/'provisioning', 'building', 'publishing', 'live', 'paused',\s+'waking', 'failed', 'fell_back_old', 'deleting', 'deleted'/);
    expect(sql).toMatch(/'github_repo', 'supabase_project', 'cloudflare_host', 'r2_prefix'/);
    expect(sql).toMatch(/'claimed', 'created', 'cleanup_pending', 'delete_scheduled', 'delete_issuing', 'deleted'/);
  });

  for (const [name, sig] of RPCS) {
    it(`${name}: security definer, pinned search_path, service-role only`, () => {
      const body = fnBody(name);
      expect(body).toMatch(/security definer/i);
      expect(body).toMatch(/set search_path = pg_catalog, pg_temp/i);
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${name}\\(${esc(sig)}\\) from public, anon, authenticated;`, "i"));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${name}\\(${esc(sig)}\\) to service_role;`, "i"));
      expect(sql).not.toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to [^;]*(anon|authenticated)`, "i"));
    });
  }

  it("every relation inside the functions is schema-qualified (empty effective search_path)", () => {
    for (const [name] of RPCS) {
      const body = fnBody(name).replace(/'[^']*'/g, "''").replace(/--[^\n]*/g, "");
      for (const m of body.matchAll(/\b(?:from|into|update|join|exists \(select 1 from)\s+([a-z_][a-z0-9_.]*)/gi)) {
        const rel = m[1];
        if (/^(v_|jsonb_object_keys$|set$|of$)/i.test(rel)) continue;
        expect(rel, `${name}: ${rel}`).toMatch(/^public\./);
      }
    }
  });

  it("every write RPC re-checks the tenant", () => {
    for (const name of [
      "site_update", "site_transition", "site_activate_if_desired", "site_provider_set",
      "site_provider_schedule_delete", "site_provider_cancel_delete", "site_provider_begin_delete",
    ]) {
      expect(fnBody(name), name).toMatch(/tenant_id = p_tenant_id/);
    }
    expect(fnBody("site_provider_claim")).toMatch(/s\.id = p_site_id and s\.tenant_id = p_tenant_id/);
  });

  it("get-or-create validates the run's tenant and generates id + label server-side", () => {
    const body = fnBody("site_get_or_create_for_run");
    expect(body).toMatch(/from public\.conductor_runs cr where cr\.id = p_run_id/);
    expect(body).toMatch(/v_run_tenant is null or v_run_tenant <> p_tenant_id/);
    expect(body).toMatch(/errcode = '42501'/);
    expect(body).toMatch(/v_id := gen_random_uuid\(\)/);
    expect(body).toMatch(/on conflict \(root_conductor_run_id\) where root_conductor_run_id is not null do nothing/);
    expect(body).toMatch(/left\(encode\(sha256\(convert_to\(p_tenant_id::text, 'UTF8'\)\), 'hex'\), 8\)/);
    expect(body).toMatch(/left\(replace\(v_id::text, '-', ''\), 6\)/);
    expect(body).toMatch(/'\[\^a-z0-9\]\+', '-'/);
    expect(body).toMatch(/, 24\)/);
    expect(body).toMatch(/v_slug := 'company'/);
    expect(body).toMatch(/continue when v_host_label = any \(array\[/);
    expect(body).toMatch(/resource_kind = 'domain'[\s\S]*= v_hostname/);
  });

  it("get-or-create builds the hostname from validated suffix + domain params, never a hardcoded domain", () => {
    const body = fnBody("site_get_or_create_for_run");
    expect(body).not.toMatch(/zaviagent/);
    expect(body).toMatch(/p_hostname_suffix\s+text,\s*p_base_domain\s+text\s*\) returns public\.sites/);
    expect(body).toContain("p_hostname_suffix is null or p_hostname_suffix !~ '^(-[a-z0-9]{1,10})?$'");
    expect(body).toContain("p_base_domain !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$'");
    expect(body).toMatch(/v_host_label := v_label \|\| p_hostname_suffix/);
    expect(body).toMatch(/v_hostname := v_host_label \|\| '\.' \|\| p_base_domain/);
    expect(body).toMatch(/length\(v_host_label\) < 3 or length\(v_host_label\) > 63/);
    expect(body).toMatch(/values \(v_id, p_tenant_id, p_run_id, p_started_by, v_label, v_hostname\)/);
  });

  it("the SQL suffix and domain regexes match label.ts", () => {
    const body = fnBody("site_get_or_create_for_run");
    expect(body).toContain(`'${SITE_HOSTNAME_SUFFIX_RE.source}'`);
    expect(body).toContain(`'${SITE_BASE_DOMAIN_RE.source}'`);
  });

  it("the reserved label list equals RESERVED_LABELS in builtin-url.ts", () => {
    const body = fnBody("site_get_or_create_for_run");
    const arr = body.match(/v_host_label = any \(array\[([\s\S]*?)\]\)/)![1];
    const inSql = [...arr.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]).sort();
    expect(inSql).toEqual([...RESERVED_LABELS].filter((l) => !PLATFORM_HOST_LABELS.includes(l)).sort());
  });

  it("update + transition hold the same patch whitelist; transition owns status", () => {
    const keys = (name: string) => {
      const m = fnBody(name).match(/k <> all \(array\[([\s\S]*?)\]\)/)!;
      return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    };
    const upd = keys("site_update");
    expect(upd).toEqual([
      "desired_sha", "github_full_name", "last_edit_at", "last_error", "last_visit_at", "live_url",
      "owner_email", "paused_at", "status", "supabase_project_ref", "supabase_url",
    ]);
    expect(keys("site_transition")).toEqual(upd.filter((k) => k !== "status"));
    expect(fnBody("site_update")).toMatch(/is not patchable/);
    for (const forbidden of ["tenant_id", "label", "hostname", "live_sha", "live_deploy_id", "root_conductor_run_id"]) {
      expect(upd).not.toContain(forbidden);
    }
  });

  it("transition is a status CAS that returns null when the row was not in `from`", () => {
    const body = fnBody("site_transition");
    expect(body).toMatch(/s\.status = any \(p_from\)/);
    expect(body).toMatch(/if not found then\s+return null;/);
  });

  it("activation is a CAS on desired_sha", () => {
    expect(fnBody("site_activate_if_desired")).toMatch(/s\.desired_sha = p_sha\b/);
    expect(fnBody("site_activate_if_desired")).toMatch(/and s\.status not in \('deleting', 'deleted', 'fell_back_old'\);\s+return found;/);
  });

  it("the provider claim never downgrades an existing state and stays tenant-bound", () => {
    const body = fnBody("site_provider_claim");
    expect(body).toMatch(/on conflict \(site_id, kind\) do update\s+set ref\s+= public\.site_providers\.ref \|\| excluded\.ref/);
    expect(body).not.toMatch(/set state/);
    expect(body).toMatch(/where public\.site_providers\.tenant_id = p_tenant_id/);
  });

  it("soft delete: a scheduled provider always carries its time; only the schedule RPC sets it", () => {
    expect(sql).toMatch(/scheduled_delete_at timestamptz,/);
    expect(sql).toMatch(/check \(state not in \('delete_scheduled', 'delete_issuing'\) or scheduled_delete_at is not null\)/);
    const set = fnBody("site_provider_set");
    expect(set).toMatch(/if p_state = 'delete_scheduled' then\s+raise exception/);
    expect(set).toMatch(/scheduled_delete_at = case when p_state = 'deleted' then sp\.scheduled_delete_at else null end/);
  });

  it("the schedule RPC floors the grace at 7 days, keeps an existing time and never revives a deleted provider", () => {
    const body = fnBody("site_provider_schedule_delete");
    expect(body).toMatch(/p_grace_days is null or p_grace_days < 7/);
    expect(body).toMatch(/when sp\.state = 'delete_scheduled' and sp\.scheduled_delete_at is not null then sp\.scheduled_delete_at/);
    expect(body).toMatch(/now\(\) \+ make_interval\(days => p_grace_days\)/);
    expect(body).toMatch(/and sp\.state not in \('deleted', 'delete_issuing'\)/);
  });

  it("begin_delete is a compare-and-set on the caller's read: due, not retained, tenant-bound", () => {
    const body = fnBody("site_provider_begin_delete");
    expect(body).toMatch(/p_from not in \('delete_scheduled', 'delete_issuing'\)/);
    expect(body).toMatch(/state\s+= 'delete_issuing'/);
    expect(body).toMatch(/sp\.tenant_id = p_tenant_id and sp\.kind = p_kind\s+and sp\.state = p_from/);
    expect(body).toMatch(/sp\.scheduled_delete_at is not null and sp\.scheduled_delete_at <= now\(\)/);
    expect(body).toMatch(/not \(sp\.ref @> '\{"retained": true\}'::jsonb\)/);
    expect(body).toMatch(/jsonb_build_object\('delete_issued_at', now\(\)\)/);
    expect(body).toMatch(/return found;/);
  });

  it("a 'delete_issuing' provider can only become 'deleted' (no cancel, no re-schedule, no other state)", () => {
    const set = fnBody("site_provider_set");
    expect(set).toMatch(/if p_state = 'delete_issuing' then\s+raise exception/);
    expect(set).toMatch(/and \(sp\.state <> 'delete_issuing' or p_state = 'deleted'\);/);
    expect(set).toMatch(/is being deleted', p_kind, p_site_id using errcode = '55000'/);
    expect(fnBody("site_provider_cancel_delete")).not.toMatch(/delete_issuing/);
  });

  it("the cancel RPC only moves delete_scheduled back to created and clears the time", () => {
    const body = fnBody("site_provider_cancel_delete");
    expect(body).toMatch(/state\s+= 'created'/);
    expect(body).toMatch(/scheduled_delete_at = null/);
    expect(body).toMatch(/and sp\.state = 'delete_scheduled';\s+return found;/);
  });

  it("site_by_hostname returns only tenant_id, site_id and status", () => {
    expect(sql).toMatch(/function public\.site_by_hostname\(p_hostname text\)\s+returns table \(tenant_id uuid, site_id uuid, status text\)/i);
    expect(fnBody("site_by_hostname")).toMatch(/select s\.tenant_id, s\.id, s\.status\s+from public\.sites s/);
  });

  it("the idle batch uses both timestamps with created_at fallback, live only, skip locked", () => {
    const body = fnBody("site_claim_idle_batch");
    expect(sql).toMatch(/returns table \(tenant_id uuid, site_id uuid, hostname text\)/i);
    expect(body).toMatch(/s\.status = 'live'/);
    expect(body).toMatch(/coalesce\(s\.last_visit_at, s\.created_at\) < p_cutoff/);
    expect(body).toMatch(/coalesce\(s\.last_edit_at, s\.created_at\) < p_cutoff/);
    expect(body).toMatch(/for update of s skip locked/);
  });
});
