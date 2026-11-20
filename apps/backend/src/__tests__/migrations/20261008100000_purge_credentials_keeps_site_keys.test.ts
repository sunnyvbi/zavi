import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { siteVaultKey } from "../../services/sites/contract";

const dir = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261008100000_purge_credentials_keeps_site_keys.sql";
const SQL = readFileSync(join(dir, FILE), "utf-8");
const PRIOR = readFileSync(join(dir, "20260910120000_account_soft_delete.sql"), "utf-8");
const fn = (s: string) => {
  const start = s.indexOf("create or replace function purge_tenant_credentials(");
  expect(start).toBeGreaterThan(-1);
  return s.slice(start, s.indexOf("end $$;", start) + "end $$;".length);
};
const KEEP = SQL.slice(SQL.indexOf("\n      -- A new-flow site's own keys"), SQL.indexOf(".sb_db_password'))") + ".sb_db_password'))".length);

describe("purge_tenant_credentials keeps site keys during the 7-day grace (20261008100000)", () => {
  it("is the latest prior body plus only the keep clause, on the Vault loop AND the secrets delete", () => {
    expect(KEEP.length).toBeGreaterThan(100);
    expect(fn(SQL).split(KEEP)).toHaveLength(3);
    expect(fn(SQL).split(KEEP).join("")).toBe(fn(PRIOR));
  });

  it("only 20261116200000 redefines purge_tenant_credentials after this body", () => {
    const others = readdirSync(dir)
      .filter((f) => f.endsWith(".sql") && f !== FILE && f > "20260910120000_account_soft_delete.sql")
      .filter((f) => /function\s+(public\.)?purge_tenant_credentials\s*\(/i.test(readFileSync(join(dir, f), "utf-8")));
    expect(others).toEqual(["20261116200000_account_purge_safety.sql"]);
    const later = readFileSync(join(dir, others[0]), "utf-8");
    expect(later.split(KEEP)).toHaveLength(3);
  });

  it("keeps exactly the three siteVaultKey names, only for this tenant's not-yet-deleted supabase_project", () => {
    expect(KEEP).toMatch(/and not exists \(\s+select 1 from public\.site_providers sp\s+where sp\.tenant_id = p_tenant_id\s+and sp\.kind = 'supabase_project'\s+and sp\.state <> 'deleted'/);
    const id = "00000000-0000-4000-8000-000000000001";
    const names = [...KEEP.matchAll(/'site\.' \|\| sp\.site_id::text \|\| '(\.[a-z_]+)'/g)].map((m) => `site.${id}${m[1]}`);
    expect(names.sort()).toEqual([siteVaultKey.serviceRole(id), siteVaultKey.anon(id), siteVaultKey.dbPassword(id)].sort());
    expect(KEEP).not.toMatch(/like|~/i);
  });

  it("keeps the signature, security definer, search_path and the revoke", () => {
    expect(SQL).toMatch(/language plpgsql security definer set search_path = public, vault, pg_temp as \$\$/);
    expect(SQL).toContain("revoke all on function purge_tenant_credentials(uuid) from public, anon, authenticated;");
    expect(SQL).not.toMatch(/grant execute on function purge_tenant_credentials\(uuid\) to (anon|authenticated|public)/i);
  });
});
