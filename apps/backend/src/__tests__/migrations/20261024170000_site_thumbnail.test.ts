import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(__dirname, "../../../../../supabase/migrations/20261024170000_site_thumbnail.sql"), "utf8");

describe("migration 20261024170000_site_thumbnail", () => {
  it("adds nullable columns only", () => {
    expect(sql).toContain("alter table public.sites add column if not exists thumbnail_path text;");
    expect(sql).toContain("alter table public.sites add column if not exists thumbnail_at timestamptz;");
    expect(sql).not.toMatch(/\bdrop\b/i);
  });

  it("accepts only a thumbnail under this tenant's and this site's prefix, on this tenant's live row", () => {
    expect(sql).toContain("'^' || lower(p_tenant_id::text) || '/' || lower(p_site_id::text) || '/site-thumb-[0-9a-f]{12}\\.jpg$'");
    expect(sql).toMatch(/where s\.id = p_site_id and s\.tenant_id = p_tenant_id\s+and s\.status not in \('deleting', 'deleted'\)/);
    expect(sql).toMatch(/security definer\s+set search_path = pg_catalog, pg_temp/);
  });

  it("never lets an older screenshot replace a newer one", () => {
    expect(sql).toMatch(/if v_at is not null and v_at >= p_taken_at then\s+return jsonb_build_object\('outcome', 'stale'/);
    expect(sql).toMatch(/set thumbnail_path = p_path, thumbnail_at = p_taken_at/);
  });

  it("is service-role only", () => {
    const signature = "site_set_thumbnail(uuid, uuid, text, timestamptz)";
    expect(sql).toContain(`revoke all on function public.${signature} from public, anon, authenticated;`);
    expect(sql).toContain(`grant execute on function public.${signature} to service_role;`);
  });
});
