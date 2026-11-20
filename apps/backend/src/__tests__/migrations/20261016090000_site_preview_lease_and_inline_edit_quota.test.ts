import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(__dirname, "../../../../../supabase/migrations/20261016090000_site_preview_lease_and_inline_edit_quota.sql"), "utf-8");
const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");

const RPCS: Array<[string, string]> = [
  ["claim_site_preview_lease", "uuid, uuid, text, integer"],
  ["release_site_preview_lease", "uuid, uuid, uuid, text"],
  ["site_preview_lease_held", "uuid, uuid"],
  ["take_inline_edit_call", "uuid, text, integer, integer"],
];
const esc = (s: string) => s.replace(/[[\]().]/g, (c) => `\\${c}`);
function fnBody(name: string): string {
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\(`, "i"));
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf("$$;", sql.indexOf("$$", start) + 2));
}

describe("20261016090000_site_preview_lease_and_inline_edit_quota.sql", () => {
  it("both tables: RLS on, NO policy, nothing granted to anon / authenticated", () => {
    for (const t of ["site_preview_leases", "site_inline_edit_calls"]) {
      expect(sql).toMatch(new RegExp(`alter table public\\.${t} enable row level security`));
      expect(sql).toMatch(new RegExp(`revoke all on public\\.${t} from public, anon, authenticated`));
    }
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/grant [^;]* to (anon|authenticated)/i);
  });

  it("every function is service-role only, security definer, pins search_path, and is in the tenant-RPC registry", () => {
    for (const [name, args] of RPCS) {
      const body = fnBody(name);
      expect(body, name).toMatch(/security definer/i);
      expect(body, name).toMatch(/set search_path = pg_catalog, pg_temp/i);
      expect(sql, name).toMatch(new RegExp(`revoke execute on function public\\.${name}\\(${esc(args)}\\) from public, anon, authenticated;`));
      expect(sql, name).toMatch(new RegExp(`grant execute on function public\\.${name}\\(${esc(args)}\\) to service_role;`));
      expect(registry, name).toMatch(new RegExp(`\\b${name}: "p_tenant_id"`));
    }
  });

  it("the lease claim locks THIS tenant's site row, then compare-and-sets: only a free or expired lease is taken", () => {
    const body = fnBody("claim_site_preview_lease");
    expect(body).toMatch(/where s\.id = p_site_id and s\.tenant_id = p_tenant_id for update/);
    expect(body).toMatch(/if found and v_row\.expires_at > now\(\) then/);
    expect(body).not.toMatch(/p_kind = 'edit' and v_row\.kind = 'wake'/);
    expect(body).toMatch(/on conflict \(site_id\) do update/);
  });

  it("release and the held read are tenant-scoped; release by token, or by kind only when no token is given", () => {
    expect(fnBody("release_site_preview_lease")).toMatch(/l\.site_id = p_site_id and l\.tenant_id = p_tenant_id/);
    expect(fnBody("release_site_preview_lease")).toMatch(/case when p_token is not null then l\.token = p_token else l\.kind = p_kind end/);
    expect(fnBody("site_preview_lease_held")).toMatch(/l\.site_id = p_site_id and l\.tenant_id = p_tenant_id and l\.expires_at > now\(\)/);
  });

  it("the inline-edit call counter serializes per tenant and enforces the per-site minute rate and the daily cap before inserting", () => {
    const body = fnBody("take_inline_edit_call");
    expect(body).toMatch(/pg_advisory_xact_lock\(hashtextextended\('inline_edit:' \|\| p_tenant_id::text, 0\)\)/);
    const site = body.indexOf("'site_rate_limited'");
    const cap = body.indexOf("'daily_cap'");
    const insert = body.indexOf("insert into public.site_inline_edit_calls");
    expect(site).toBeGreaterThan(-1);
    expect(site).toBeLessThan(cap);
    expect(cap).toBeLessThan(insert);
    expect(body).toMatch(/c\.tenant_id = p_tenant_id and c\.app_id = p_app_id and c\.created_at > now\(\) - interval '1 minute'/);
    expect(body).toMatch(/c\.tenant_id = p_tenant_id and c\.created_at > now\(\) - interval '1 day'/);
  });
});
