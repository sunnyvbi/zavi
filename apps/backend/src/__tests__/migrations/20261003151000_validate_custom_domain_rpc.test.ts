import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RESERVED_SUFFIXES } from "../../services/provisioning/custom-domain-validate";

const SQL = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20261003151000_validate_custom_domain_rpc.sql"),
  "utf-8",
);

const at = (needle: string) => {
  const i = SQL.indexOf(needle);
  expect(i, needle).toBeGreaterThan(-1);
  return i;
};

describe("set_tenant_custom_domain validation (20261003151000)", () => {
  it("reserves exactly the suffixes the route reserves", () => {
    const list = SQL.slice(at("unnest(array["), SQL.indexOf("])", at("unnest(array[")));
    const sqlSuffixes = [...list.matchAll(/'([a-z0-9.-]+)'/g)].map((m) => m[1]).sort();
    expect(sqlSuffixes).toEqual([...RESERVED_SUFFIXES].sort());
  });

  it("checks role, hostname, service ownership and status before the insert", () => {
    const insert = at("insert into tenant_custom_domains");
    const role = at("caller is not owner|admin");
    const host = at("invalid custom hostname");
    const service = at("is not tenant %''s hosting");
    const status = at("can only be set by verification");
    expect(role).toBeLessThan(host);
    expect([host, service, status].every((i) => i < insert)).toBe(true);
  });

  it("binds the row to the tenant's own provisioned Render service", () => {
    expect(SQL).toMatch(/from tenant_resources\s+where tenant_id = p_tenant_id\s+and resource_kind = 'hosting'\s+and mode = 'provisioned'\s+and external_ref->>'render_service_id' = p_render_service_id/);
  });

  it("lets an authenticated caller write only pending or dns_required", () => {
    expect(SQL).toMatch(/auth\.uid\(\) is not null and coalesce\(p_status, 'pending'\) not in \('pending', 'dns_required'\)/);
  });

  it("rejects unnormalized, oversized, local and platform hostnames", () => {
    expect(SQL).toMatch(/v_host is distinct from p_hostname/);
    expect(SQL).toMatch(/length\(v_host\) > 253/);
    expect(SQL).toMatch(/v_host = 'localhost' or v_host like '%\.localhost' or v_host like '%\.local'/);
    expect(SQL).toMatch(/v_host = s\.suffix or v_host like '%\.' \|\| s\.suffix/);
  });

  it("keeps the no-takeover upsert and the original grants", () => {
    expect(SQL).toMatch(/where tenant_custom_domains\.tenant_id = p_tenant_id\s+returning id into v_id;/);
    expect(SQL).toMatch(/revoke all on function set_tenant_custom_domain\(uuid, text, text, text, text, text, jsonb\) from public, anon, authenticated;/);
    expect(SQL).toMatch(/grant execute on function set_tenant_custom_domain\(uuid, text, text, text, text, text, jsonb\) to authenticated, service_role;/);
  });
});
