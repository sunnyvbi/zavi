import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(MIGRATIONS, "20261012080000_site_by_repo.sql"), "utf-8");

describe("20261012080000_site_by_repo.sql (source)", () => {
  it("is a service-role-only security definer with a pinned search_path", () => {
    expect(sql).toMatch(/security definer\s+set search_path = pg_catalog, pg_temp/);
    expect(sql).toContain("revoke all on function public.site_by_repo(text) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.site_by_repo(text) to service_role;");
    expect(sql).not.toMatch(/to [^;]*\b(anon|authenticated)\b/);
  });

  it("is read-only and projects only tenant_id, site id and status", () => {
    expect(sql).toMatch(/returns table \(tenant_id uuid, site_id uuid, status text\)/);
    expect(sql).toMatch(/select s\.tenant_id, s\.id, s\.status\s+from public\.sites s/);
    expect(sql).not.toMatch(/\b(insert|update|delete)\b\s+(into|public\.|from public\.)/i);
  });

  it("matches case-insensitively on the unique lower(github_full_name) and refuses an empty name", () => {
    expect(sql).toContain("lower(s.github_full_name) = v_name");
    expect(sql).toContain("v_name text := lower(btrim(coalesce(p_github_full_name, '')))");
    expect(sql).toMatch(/if v_name = '' then\s+return;/);
  });
});
