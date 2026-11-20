import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_HOST_LABELS, RESERVED_LABELS, validateBuiltinLabel } from "../../services/provisioning/builtin-url";

const dir = join(__dirname, "../../../../../supabase/migrations");
const SQL = readFileSync(join(dir, "20261012130000_reserve_platform_host_labels.sql"), "utf-8");
const PRIOR_DOMAIN = readFileSync(join(dir, "20261008090500_builtin_domain_rejects_site_hostnames.sql"), "utf-8");
const PRIOR_SITES = readFileSync(join(dir, "20261010170000_site_names.sql"), "utf-8");

const ADDED_LINES = /,\n\s*'latest', 'preview-dev', 'api-latest', 'api-staging', 'api-dev',\n\s*'admin-latest', 'admin-staging', 'admin-dev', 'www-latest', 'www-dev',\n\s*'sites', 'sites-auth'/g;
const stripped = SQL.replace(ADDED_LINES, "");
const between = (s: string, from: string, to: string) => s.slice(s.indexOf(from), s.indexOf(to, s.indexOf(from)));

function arrays(src: string): string[][] {
  return [...src.matchAll(/= any \(array\[([\s\S]*?)\]\)/g)].map((m) => [...m[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]));
}

describe("20261012130000_reserve_platform_host_labels.sql", () => {
  it("adds the labels to all three SQL copies, each equal to RESERVED_LABELS", () => {
    const lists = arrays(SQL);
    expect(lists).toHaveLength(3);
    for (const l of lists) expect([...l].sort()).toEqual([...RESERVED_LABELS].sort());
    expect(SQL.match(ADDED_LINES)).toHaveLength(3);
  });

  it("reserves latest and every host the web app serves", () => {
    for (const l of ["latest", "www", "api", "admin", "staging", "preview", "preview-dev"]) {
      expect(RESERVED_LABELS.has(l), l).toBe(true);
      expect(validateBuiltinLabel(l).ok, l).toBe(false);
    }
    for (const l of PLATFORM_HOST_LABELS) expect(validateBuiltinLabel(l).ok, l).toBe(false);
  });

  it("set_tenant_builtin_domain is its latest prior body plus only the labels", () => {
    const body = (s: string) => between(s, "create or replace function set_tenant_builtin_domain(", "\ncommit;");
    expect(between(stripped, "create or replace function set_tenant_builtin_domain(", "\ncreate or replace function public.site_get_or_create_for_run(").trimEnd()).toBe(
      body(PRIOR_DOMAIN).trimEnd(),
    );
  });

  it("both site_get_or_create_for_run overloads are their latest prior bodies plus only the labels", () => {
    const from = "create or replace function public.site_get_or_create_for_run(";
    expect(between(stripped, from, "\ncommit;").trimEnd()).toBe(between(PRIOR_SITES, from, "\ncommit;").trimEnd());
  });

  it("keeps every grant", () => {
    expect(SQL).toContain("revoke all on function set_tenant_builtin_domain(uuid, jsonb, text) from public, anon, authenticated;");
    expect(SQL).toContain("grant execute on function set_tenant_builtin_domain(uuid, jsonb, text) to authenticated, service_role;");
    for (const sig of ["uuid, uuid, text, uuid, text, text, text", "uuid, uuid, text, uuid, text, text"]) {
      expect(SQL).toContain(`revoke all on function public.site_get_or_create_for_run(${sig}) from public, anon, authenticated;`);
      expect(SQL).toContain(`grant execute on function public.site_get_or_create_for_run(${sig}) to service_role;`);
    }
  });
});
