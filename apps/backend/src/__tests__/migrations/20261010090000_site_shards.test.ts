import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(__dirname, "../../../../../supabase/migrations/20261010090000_site_shards.sql"), "utf-8");

const RPCS: Array<[string, string]> = [
  ["site_shard_load", "public.site_shards"],
  ["site_shard_register", "text, text, text, boolean"],
  ["site_shard_update", "uuid, jsonb"],
  ["site_shard_record_metrics", "uuid, jsonb"],
  ["site_shard_list", "text"],
  ["site_shard_get", "uuid"],
  ["site_backend_init_static", "uuid, uuid"],
  ["site_backend_place", "uuid, uuid, text"],
  ["site_backend_release", "uuid, uuid, text"],
  ["site_shard_secret_set", "uuid, text, text"],
  ["site_shard_secret_get", "uuid, text"],
  ["site_shard_migration_record", "uuid, text, text"],
  ["site_host_bump", "uuid, uuid, boolean, jsonb"],
];

function fnBody(name: string): string {
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\(`, "i"));
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf("$$;", sql.indexOf("$$", start) + 2));
}

const esc = (s: string) => s.replace(/[[\]().]/g, (c) => `\\${c}`);

describe("20261010090000_site_shards.sql", () => {
  it("site_shards: RLS on, NO policy, no grant to anon / authenticated", () => {
    expect(sql).toMatch(/alter table public\.site_shards enable row level security/i);
    expect(sql).toMatch(/alter table public\.site_shard_secrets enable row level security/i);
    expect(sql).toMatch(/alter table public\.site_shard_migrations enable row level security/i);
    expect(sql).toMatch(/vault_secret_id uuid not null/);
    expect(sql).not.toMatch(/site_shard_secrets \([^;]*\bvalue\b/i);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).toMatch(/revoke all on public\.site_shards from public, anon, authenticated/i);
    expect(sql).not.toMatch(/grant [^;]* to (anon|authenticated)/i);
  });

  it("every function is service-role only, pins pg_temp, and is security definer", () => {
    for (const [name, args] of RPCS) {
      const body = fnBody(name);
      expect(body, name).toMatch(/security definer/i);
      expect(body, name).toMatch(/set search_path = pg_catalog, pg_temp/i);
      expect(sql, name).toMatch(new RegExp(`revoke all on function public\\.${name}\\(${esc(args)}\\) from public, anon, authenticated;`, "i"));
      expect(sql, name).toMatch(new RegExp(`grant execute on function public\\.${name}\\(${esc(args)}\\) to service_role;`, "i"));
    }
  });

  it("every site RPC re-checks the tenant on the locked site row", () => {
    for (const name of ["site_backend_init_static", "site_backend_place", "site_backend_release", "site_host_bump"]) {
      expect(fnBody(name), name).toMatch(/where s\.id = p_site_id and s\.tenant_id = p_tenant_id for update/i);
    }
  });

  it("placement is atomic: locks the shard row and re-checks the cap in the increment", () => {
    const b = fnBody("site_backend_place");
    expect(b).toMatch(/order by public\.site_shard_load\(sh\)[\s\S]*limit 1\s+for update;/i);
    expect(b).not.toMatch(/for update\s+skip locked/i);
    expect(b).toMatch(/set site_count = sh\.site_count \+ 1[\s\S]*where sh\.id = v_shard\.id and sh\.state = 'open' and sh\.site_count < sh\.max_sites/i);
    expect(b).toMatch(/errcode = '53400'/);
    expect(b).toMatch(/pg_advisory_xact_lock\(pg_catalog\.hashtext\('site_backend_place:' \|\| p_env\)\)/);
    expect(b).toMatch(/backend_mode = 'dedicated'[\s\S]*errcode = '42501'/i);
  });

  it("load counts records, bytes, requests, p95, CPU, connections, Auth users, sessions and email volume", () => {
    const b = fnBody("site_shard_load");
    for (const m of ["site_count", "m_records", "m_bytes", "m_requests_per_min", "m_p95_ms", "m_cpu_pct", "m_connections", "m_auth_users", "m_sessions", "m_emails_per_hour"]) {
      expect(b, m).toContain(m);
    }
  });

  it("sites gain shard_id + backend_mode, existing rows default to dedicated, mode and shard agree", () => {
    expect(sql).toMatch(/add column if not exists shard_id uuid references public\.site_shards \(id\) on delete restrict/i);
    expect(sql).toMatch(/add column if not exists backend_mode text not null default 'dedicated'/i);
    expect(sql).toMatch(/check \(\(backend_mode = 'pooled'\) = \(shard_id is not null\)\)/i);
    expect(sql).toMatch(/'pooled_backend'\)\)/);
  });

  it("is wrapped in one transaction", () => {
    expect(sql.trim()).toMatch(/^[\s\S]*?\nbegin;[\s\S]*\ncommit;$/);
  });
});
