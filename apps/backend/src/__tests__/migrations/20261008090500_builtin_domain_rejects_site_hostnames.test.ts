import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_HOST_LABELS, RESERVED_LABELS } from "../../services/provisioning/builtin-url";

const dir = join(__dirname, "../../../../../supabase/migrations");
const SQL = readFileSync(join(dir, "20261008090500_builtin_domain_rejects_site_hostnames.sql"), "utf-8");
const PRIOR = readFileSync(join(dir, "20260926230000_validate_builtin_domain_hostname.sql"), "utf-8");
const body = (s: string) => s.slice(s.indexOf("begin;"));

describe("set_tenant_builtin_domain rejects site hostnames (20261008090500)", () => {
  it("is the latest prior body plus only the sites check", () => {
    const added = body(SQL).replace(/\n    -- A hostname already owned[\s\S]*?belongs to a site', v_host\n        using errcode = '23505';\n    end if;/, "");
    expect(added).toBe(body(PRIOR));
  });

  it("checks public.sites after validation and before the write", () => {
    const site = SQL.indexOf("from public.sites s where s.hostname = v_host");
    expect(site).toBeGreaterThan(SQL.indexOf("invalid built-in hostname"));
    expect(site).toBeLessThan(SQL.indexOf("insert into tenant_resources"));
  });

  it("keeps the reserved labels and grants", () => {
    const list = SQL.slice(SQL.indexOf("= any (array["), SQL.indexOf("])", SQL.indexOf("= any (array[")));
    const sqlLabels = new Set([...list.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]));
    expect([...sqlLabels].sort()).toEqual([...RESERVED_LABELS].filter((l) => !PLATFORM_HOST_LABELS.includes(l)).sort());
    expect(SQL).toMatch(/revoke all on function set_tenant_builtin_domain\(uuid, jsonb, text\) from public, anon, authenticated;/);
  });
});
