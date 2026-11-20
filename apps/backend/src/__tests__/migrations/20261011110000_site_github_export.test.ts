import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const SQL = readFileSync(join(DIR, "20261011110000_site_github_export.sql"), "utf-8");
const code = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").replace(/\s+/g, " ");

describe("site github export (20261011110000)", () => {
  it("adds one nullable jsonb column, no backfill", () => {
    expect(code).toContain("alter table public.sites add column if not exists github_export jsonb;");
    expect(code).not.toMatch(/\bupdate public\.sites s set github_export = p_record where s\.id = p_site_id;/);
  });

  it("writes only the caller tenant's site, and refuses an unknown one", () => {
    expect(code).toContain("update public.sites s set github_export = p_record where s.id = p_site_id and s.tenant_id = p_tenant_id;");
    expect(code).toContain("if not found then raise exception");
  });

  it("is service-role only", () => {
    expect(code).toContain("revoke all on function public.site_set_github_export(uuid, uuid, jsonb) from public, anon, authenticated;");
    expect(code).toContain("grant execute on function public.site_set_github_export(uuid, uuid, jsonb) to service_role;");
    expect(code).toContain("security definer set search_path = pg_catalog, pg_temp");
  });

  it("does not touch updated_at (not a serving-state change)", () => {
    expect(code).not.toContain("updated_at");
  });
});
