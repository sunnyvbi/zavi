import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20261008094400_site_reaper.sql"),
  "utf-8",
);

function fnBody(name: string): string {
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\(`, "i"));
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf("end $$;", start));
}

describe("20261008094400_site_reaper.sql", () => {
  it.each([
    ["site_reaper_candidates", "timestamptz, int"],
    ["delete_site_secrets", "uuid, uuid"],
  ])("%s is security definer, pinned search_path, service_role only", (name, sig) => {
    const body = fnBody(name);
    expect(body).toMatch(/security definer/i);
    expect(body).toMatch(/set search_path = pg_catalog, pg_temp/i);
    expect(sql).toContain(`revoke all on function public.${name}(${sig}) from public, anon, authenticated;`);
    expect(sql).toContain(`grant execute on function public.${name}(${sig}) to service_role;`);
  });

  it("the reaper only lists DEAD sites that still hold a provider, and returns only 4 fields", () => {
    const body = fnBody("site_reaper_candidates");
    expect(body).toMatch(/returns table \(tenant_id uuid, site_id uuid, status text, tenant_slug text\)/i);
    expect(body).toMatch(/s\.status in \('fell_back_old', 'failed', 'deleting', 'deleted'\)/);
    expect(body).toMatch(/p\.state <> 'deleted'/);
    expect(body).not.toMatch(/\b(update|delete|insert)\b/i);
  });

  it("also lists sites stranded in provisioning/building past the cutoff whose build run is no longer live (S4 F3)", () => {
    const body = fnBody("site_reaper_candidates");
    expect(body).toMatch(/s\.status in \('provisioning', 'building'\)\s+and s\.updated_at < p_cutoff/);
    expect(body).toMatch(/r\.id = s\.root_conductor_run_id and r\.tenant_id = s\.tenant_id/);
    expect(body).toMatch(/r\.status in \('provisioning', 'active', 'paused'\)/);
    const stranded = body.slice(body.indexOf("s.status in ('provisioning', 'building')"));
    expect(stranded).not.toMatch(/cleanup_pending/);
  });

  it("a soft-deleted project counts only once due, and a retained one never (7-day grace)", () => {
    const body = fnBody("site_reaper_candidates");
    expect(body).toMatch(/not \(p\.state = 'delete_scheduled'\s+and \(p\.scheduled_delete_at is null or p\.scheduled_delete_at > now\(\)\)\)/);
    expect(body).toMatch(/not \(p\.ref @> '\{"retained": true\}'::jsonb\)/);
    expect(body).toMatch(/p\.state = 'delete_scheduled' and p\.scheduled_delete_at <= now\(\)/);
    expect(body).toMatch(/p\.state in \('cleanup_pending', 'delete_issuing'\)/);
  });

  it("delete_site_secrets derives the three key names from the site id and scopes by tenant", () => {
    const body = fnBody("delete_site_secrets");
    for (const k of ["sb_service_role", "sb_anon", "sb_db_password"]) {
      expect(body).toContain(`'site.' || p_site_id::text || '.${k}'`);
    }
    expect(body).toMatch(/s\.tenant_id = p_tenant_id and s\.key = any \(v_keys\)/);
    expect(body).not.toMatch(/p_key/);
  });
});
