import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261010140500_site_host_projection.sql";
const sql = readFileSync(join(dir, FILE), "utf-8");
const PRIOR = readFileSync(join(dir, "20261009130000_site_pointer_projection.sql"), "utf-8");

function fnBody(src: string, name: string): string {
  const start = src.search(new RegExp(`create or replace function public\\.${name}\\(`, "i"));
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("end $$;", start));
}

describe(FILE, () => {
  it("runs after both migrations it unifies (main's pointer projection and the pooled graduation)", () => {
    const v = (f: string) => Number(f.split("_")[0]);
    const files = readdirSync(dir);
    for (const f of ["20261009130000_site_pointer_projection.sql", "20261010120000_site_graduation.sql", "20261010130000_site_auth_directory_rpc.sql"]) {
      expect(files).toContain(f);
      expect(v(FILE)).toBeGreaterThan(v(f));
    }
  });

  it("is one transaction, additive, and never drops a column 20261009130000 shipped", () => {
    expect(sql.trimStart().split("\n").find((l) => l.trim() && !l.startsWith("--"))).toBe("begin;");
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("add column if not exists kv_host_version bigint not null default 0");
    expect(sql).not.toMatch(/drop (table|column)/i);
    expect(sql).not.toMatch(/drop function/i);
  });

  it.each([
    ["site_mark_host_projected", "uuid, uuid, bigint, boolean"],
    ["site_projection_drift_batch", "timestamptz, int"],
  ])("%s is security definer, pinned search_path, service_role only", (name, sig) => {
    const body = fnBody(sql, name);
    expect(body).toMatch(/security definer/i);
    expect(body).toMatch(/set search_path = pg_catalog, pg_temp/i);
    expect(sql).toContain(`revoke all on function public.${name}(${sig}) from public, anon, authenticated;`);
    expect(sql).toContain(`grant execute on function public.${name}(${sig}) to service_role;`);
  });

  it("site_mark_host_projected is a CAS on the row's host_version, tenant-checked, never touching updated_at", () => {
    const b = fnBody(sql, "site_mark_host_projected");
    expect(b).toContain("where s.id = p_site_id and s.tenant_id = p_tenant_id");
    expect(b).toContain("and s.host_version = p_version");
    expect(b).toContain("return -1;");
    expect(b).not.toMatch(/updated_at|host_version\s*=\s*s\./);
  });

  it("the trigger bumps the ONE version on every projected-field change it was not told about, and never lets it go down", () => {
    const b = fnBody(sql, "sites_bump_host_version");
    for (const f of ["live_deploy_id", "live_sha", "hostname", "tenant_id", "gateway_binding", "gateway_config"]) {
      expect(b).toContain(`new.${f}`);
    }
    expect(b).toContain("is distinct from (old.status in ('deleting', 'deleted', 'fell_back_old'))");
    expect(b).toContain("new.host_version = old.host_version and (");
    expect(b).toContain("new.host_version := old.host_version + 1;");
    expect(b).toMatch(/if new\.host_version < old\.host_version then\s+raise exception/);
    expect(b).not.toMatch(/security definer/i);
    expect(sql).toMatch(/create trigger sites_bump_host_version\s+before insert or update on public\.sites/);
  });

  it("the drift batch and its partial index use the same version predicate; the old ledger's trigger and index are retired", () => {
    const b = fnBody(sql, "site_projection_drift_batch");
    expect(b).toContain("where s.kv_host_version <> s.host_version");
    expect(sql).toMatch(/create index if not exists sites_host_drift_idx on public\.sites \(updated_at\)\s+where kv_host_version <> host_version;/);
    expect(sql).toContain("drop index if exists public.sites_kv_drift_idx;");
    expect(sql).toContain("drop trigger if exists sites_terminal_dirties_projection on public.sites;");
  });

  it("site_projection_drift_batch is rebuilt from 20261009130000: only the drift predicate changed", () => {
    const strip = (s: string) => s.replace(/\s+/g, " ").replace(/where s\.kv_\S+ .*?end\)|where s\.kv_host_version <> s\.host_version/, "WHERE");
    expect(strip(fnBody(sql, "site_projection_drift_batch"))).toBe(strip(fnBody(PRIOR, "site_projection_drift_batch")));
  });

  it("blue-green: an old container's legacy ledger write (site_mark_projected) re-dirties the new ledger", () => {
    const b = fnBody(sql, "sites_legacy_ledger_dirties");
    expect(b).toContain("new.kv_host_version := -1;");
    expect(sql).toMatch(/create trigger sites_legacy_ledger_dirties\s+before update of kv_deploy_id on public\.sites/);
    expect(sql.slice(0, sql.indexOf("create trigger sites_legacy_ledger_dirties"))).not.toMatch(/set\s+kv_deploy_id/i);
  });

  it("the old migration file is untouched by this change (it was applied first)", () => {
    expect(PRIOR).toContain("create or replace function public.site_mark_projected(");
  });
});
