import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const SQL = readFileSync(join(DIR, "20261012060000_site_publish_generation.sql"), "utf-8");
const code = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").replace(/\s+/g, " ");

describe("site publish generation (20261012060000)", () => {
  it("adds the generation and lease columns, additive with defaults", () => {
    expect(code).toContain("add column if not exists publish_generation bigint not null default 0");
    expect(code).toContain("add column if not exists publish_lease_generation bigint");
    expect(code).toContain("add column if not exists publish_lease_until timestamptz");
  });

  it("begin bumps the generation and the desired commit together, for the caller tenant's site only", () => {
    expect(code).toContain("set publish_generation = s.publish_generation + 1, desired_sha = p_sha where s.id = p_site_id and s.tenant_id = p_tenant_id and (s.publish_lease_generation is null or s.publish_lease_until <= now())");
    expect(code).toContain("if exists (select 1 from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id) then return 0;");
    expect(code).toContain("p_sha !~ '^[0-9a-f]{7,40}$'");
  });

  it("lease: superseded for any generation but the current, busy while ANY unexpired lease is held (same generation included)", () => {
    expect(code).toContain("for update;");
    expect(code).toContain("if v_gen <> p_generation then return 'superseded';");
    expect(code).toContain("if v_holder is not null and v_until > now() and v_token is distinct from p_token then return 'busy';");
    expect(code).toContain("least(greatest(coalesce(p_ttl_seconds, 300), 30), 900)");
  });

  it("release only drops the caller's OWN acquisition (token), never a newer holder's", () => {
    expect(code).toContain("where id = p_site_id and tenant_id = p_tenant_id and publish_lease_generation = p_generation and publish_lease_token = p_token;");
    expect(code).toContain("set publish_lease_generation = p_generation, publish_lease_token = p_token,");
  });

  it("is service-role only and does not touch updated_at", () => {
    for (const sig of ["site_publish_begin(uuid, uuid, text)", "site_publish_lease(uuid, uuid, bigint, integer, uuid)", "site_publish_release(uuid, uuid, bigint, uuid)"]) {
      expect(code).toContain(`revoke all on function public.${sig} from public, anon, authenticated;`);
      expect(code).toContain(`grant execute on function public.${sig} to service_role;`);
    }
    expect(code.match(/security definer set search_path = pg_catalog, pg_temp/g)?.length).toBe(5);
    const publishFns = code.slice(0, code.indexOf("drop function if exists public.site_activate_if_desired"));
    expect(publishFns).not.toContain("updated_at");
  });

  it("activation is fenced by the generation: an older generation's queued activation never lands", () => {
    expect(code).toContain("drop function if exists public.site_activate_if_desired(uuid, uuid, text, text, text);");
    expect(code).toContain("p_generation bigint default null");
    expect(code).toContain("and ((p_generation is null and s.publish_generation = 0) or s.publish_generation = p_generation);");
    expect(code).toContain("where s.id = p_site_id and s.tenant_id = p_tenant_id and s.desired_sha = p_sha");
    expect(code).toContain("and s.status not in ('deleting', 'deleted', 'fell_back_old')");
    expect(code).toContain(`(substr(s.live_deploy_id, 2, 9) collate "C") <= (substr(p_deploy_id, 2, 9) collate "C")`);
    expect(code).toContain("revoke all on function public.site_activate_if_desired(uuid, uuid, text, text, text, bigint) from public, anon, authenticated;");
    expect(code).toContain("grant execute on function public.site_activate_if_desired(uuid, uuid, text, text, text, bigint) to service_role;");
  });

  it("the binding is fenced: only the CURRENT publish generation writes a LIVE binding; every prior guard kept", () => {
    expect(code).toContain("drop function if exists public.site_host_bump(uuid, uuid, boolean, jsonb);");
    expect(code).toContain("p_generation bigint default null");
    expect(code).toContain("if v_live and ((p_generation is null and v_row.publish_generation <> 0) or (p_generation is not null and p_generation <> v_row.publish_generation)) then raise exception 'site_host_bump: stale_generation'");
    expect(code).toContain("raise exception 'site_host_bump: the hostname binding is tombstoned'");
    expect(code).toContain("raise exception 'site_host_bump: binding_not_current'");
    expect(code).toContain("select * into v_row from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id for update;");
    expect(code).toContain("revoke all on function public.site_host_bump(uuid, uuid, boolean, jsonb, bigint) from public, anon, authenticated;");
    expect(code).toContain("grant execute on function public.site_host_bump(uuid, uuid, boolean, jsonb, bigint) to service_role;");
  });
});
