import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260529003834_tenant_resources.sql"),
  "utf-8",
);

describe("20260529003834_tenant_resources.sql", () => {
  it("creates tenant_resources keyed unique on (tenant_id, resource_kind)", () => {
    expect(sql).toMatch(/create table if not exists tenant_resources/i);
    expect(sql).toMatch(/unique \(tenant_id, resource_kind\)/i);
    expect(sql).toMatch(/tenant_id\s+uuid not null references tenants\(id\) on delete cascade/i);
  });

  it("constrains resource_kind, mode, status with CHECKs", () => {
    expect(sql).toMatch(/resource_kind in \('repo','hosting','db','stripe','email','ads','domain'\)/i);
    expect(sql).toMatch(/mode in \('provisioned','connected'\)/i);
    expect(sql).toMatch(/status in \('pending','provisioning','ready','failed','teardown','torn_down'\)/i);
  });

  it("stores a vault_key pointer + external_ref jsonb, NOT plaintext creds", () => {
    expect(sql).toMatch(/vault_key\s+text/i);
    expect(sql).toMatch(/external_ref\s+jsonb not null default '\{\}'::jsonb/i);
    expect(sql).not.toMatch(/\b(secret|token|api_key|password)\s+text\b/i);
  });

  it("RLS enabled + member-select, no DML policy", () => {
    expect(sql).toMatch(/alter table tenant_resources enable row level security/i);
    expect(sql).toMatch(/create policy tenant_resources_select on tenant_resources/i);
  });

  it("set_tenant_resource is service-role-only state writer (upsert)", () => {
    expect(sql).toMatch(/create or replace function set_tenant_resource\(/i);
    expect(sql).toMatch(/on conflict \(tenant_id, resource_kind\) do update/i);
    expect(sql).toMatch(/grant execute on function set_tenant_resource\(.*\) to service_role/i);
    expect(sql).not.toMatch(/grant execute on function set_tenant_resource\(.*\) to authenticated/i);
  });

  it("set_tenant_resource_mode is authenticated + member-checked (tenant opt-in)", () => {
    expect(sql).toMatch(/create or replace function set_tenant_resource_mode\(/i);
    expect(sql).toMatch(/not a member of tenant/i);
    expect(sql).toMatch(/grant execute on function set_tenant_resource_mode\(.*\) to authenticated/i);
  });
});
