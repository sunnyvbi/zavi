import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(MIGRATIONS, "20261011130000_site_set_name.sql"), "utf-8");
const SIG = "uuid, uuid, text, text";

describe("20261011130000_site_set_name.sql (source)", () => {
  it("is a service-role-only security definer with a pinned search_path", () => {
    expect(sql).toMatch(/security definer\s+set search_path = pg_catalog, pg_temp/);
    expect(sql).toContain(`revoke all on function public.site_set_name(${SIG}) from public, anon, authenticated;`);
    expect(sql).toContain(`grant execute on function public.site_set_name(${SIG}) to service_role;`);
    expect(sql).not.toMatch(/to [^;]*\b(anon|authenticated)\b/);
  });

  it("locks and writes only the site row of p_tenant_id, and only its name", () => {
    expect(sql).toMatch(/where s\.id = p_site_id and s\.tenant_id = p_tenant_id\s+for update;/);
    expect(sql).toMatch(/update public\.sites\s+set name = v_name, updated_at = now\(\)\s+where id = p_site_id and tenant_id = p_tenant_id;/);
    expect(sql).not.toMatch(/\b(label|hostname)\s*=/);
  });

  it("is a compare-and-set on the previewed name, idempotent, and normalises like site_get_or_create_for_run", () => {
    expect(sql).toMatch(/if v_cur is not distinct from v_name then\s+return jsonb_build_object\('outcome', 'already_applied'/);
    expect(sql).toMatch(/if v_cur is distinct from p_expected_name then\s+return jsonb_build_object\('outcome', 'stale_preview'/);
    const create = readFileSync(join(MIGRATIONS, "20261010170000_site_names.sql"), "utf-8");
    const norm = "btrim(left(btrim(regexp_replace(regexp_replace(coalesce(p_";
    expect(create).toContain(`${norm}site_name, ''), '[[:cntrl:]]', ' ', 'g'), '\\s+', ' ', 'g')), 60)), '')`);
    expect(sql).toContain(`${norm}name, ''), '[[:cntrl:]]', ' ', 'g'), '\\s+', ' ', 'g')), 60)), '')`);
  });
});
