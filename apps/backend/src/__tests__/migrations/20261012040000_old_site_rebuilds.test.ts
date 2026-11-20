import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "../../../../../supabase/migrations");
const sql = readFileSync(join(MIGRATIONS, "20261012040000_old_site_rebuilds.sql"), "utf-8");

describe("20261012040000_old_site_rebuilds.sql (source)", () => {
  it("is a tenant-keyed table with RLS on and no client access", () => {
    expect(sql).toMatch(/tenant_id\s+uuid primary key references public\.tenants\(id\) on delete cascade/);
    expect(sql).toContain("alter table public.old_site_rebuilds enable row level security;");
    expect(sql).toContain("revoke all on public.old_site_rebuilds from public, anon, authenticated;");
    expect(sql).not.toMatch(/create policy/i);
  });

  it("every RPC is a service-role-only security definer with a pinned search_path", () => {
    for (const sig of [
      "claim_old_site_rebuild(uuid, uuid, integer)",
      "settle_old_site_rebuild(uuid, uuid, uuid)",
      "release_old_site_rebuild(uuid, uuid)",
    ]) {
      expect(sql).toContain(`revoke all on function public.${sig} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function public.${sig} to service_role;`);
    }
    expect(sql.match(/security definer set search_path = pg_catalog, pg_temp/g)).toHaveLength(3);
    expect(sql).not.toMatch(/to [^;]*\b(anon|authenticated)\b/);
  });

  it("claims under a row lock and never adopts a build by name or time", () => {
    expect(sql).toMatch(/on conflict \(tenant_id\) do nothing;/);
    expect(sql).toMatch(/where r\.tenant_id = p_tenant_id for update;/);
    expect(sql).toMatch(/where c\.id = v_row\.conductor_run_id and c\.tenant_id = p_tenant_id;/);
    expect(sql).toMatch(/not in \('failed', 'halted'\)/);
    expect(sql).not.toMatch(/objective/);
    expect(sql).not.toMatch(/site_name/);
  });

  it("settle and release are token-fenced; settle records only this tenant's run, never over a recorded one", () => {
    expect(sql).toMatch(/where r\.tenant_id = p_tenant_id\s+and r\.claim_token = p_token\s+and r\.conductor_run_id is null\s+and exists \(\s+select 1 from public\.conductor_runs c where c\.id = p_conductor_run_id and c\.tenant_id = p_tenant_id/);
    expect(sql).toMatch(/delete from public\.old_site_rebuilds\s+where tenant_id = p_tenant_id and claim_token = p_token and conductor_run_id is null;/);
  });
});
