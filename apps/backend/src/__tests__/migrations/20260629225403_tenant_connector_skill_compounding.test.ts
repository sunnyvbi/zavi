import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260629225403_tenant_connector_skill_compounding.sql",
  ),
  "utf-8",
);

describe("20260629225403_tenant_connector_skill_compounding.sql", () => {
  it("creates the tenant_connector_skill table", () => {
    expect(sql).toMatch(/create table tenant_connector_skill/i);
  });

  it("FK ON DELETE CASCADE from tenants (tenant scoping)", () => {
    expect(sql).toMatch(
      /tenant_id\s+uuid not null references tenants\(id\) on delete cascade/i,
    );
  });

  it("dedup key is (tenant_id, provider, fact_key)", () => {
    expect(sql).toMatch(/unique \(tenant_id, provider, fact_key\)/i);
  });

  it("enables RLS", () => {
    expect(sql).toMatch(/alter table tenant_connector_skill enable row level security/i);
  });

  it("has a member SELECT policy scoped to the tenant", () => {
    expect(sql).toMatch(/create policy tenant_connector_skill_member_select/i);
    expect(sql).toMatch(/tu\.tenant_id = tenant_connector_skill\.tenant_id/i);
  });

  it("has NO authenticated write policy (service-role-only trust gate)", () => {
    expect(sql).not.toMatch(/for insert/i);
    expect(sql).not.toMatch(/for update/i);
    expect(sql).not.toMatch(/for delete/i);
  });

  it("defines the record_connector_skill_facts RPC as security definer", () => {
    expect(sql).toMatch(/create or replace function record_connector_skill_facts/i);
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = public/i);
  });

  it("upsert is an atomic ON CONFLICT hit-bump (compounding loop)", () => {
    expect(sql).toMatch(/on conflict \(tenant_id, provider, fact_key\)/i);
    expect(sql).toMatch(/hits = tenant_connector_skill\.hits \+ 1/i);
  });

  it("locks the RPC grant to service_role only", () => {
    expect(sql).toMatch(
      /revoke all on function record_connector_skill_facts[\s\S]*from public, authenticated, anon/i,
    );
    expect(sql).toMatch(
      /grant execute on function record_connector_skill_facts[\s\S]*to service_role/i,
    );
  });
});
