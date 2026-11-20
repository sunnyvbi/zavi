import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(__dirname, "../../../../../supabase/migrations/20261022093000_site_seo_audits.sql"), "utf8");

describe("20261022093000_site_seo_audits.sql", () => {
  it("is one row per site, gone with the site or the tenant", () => {
    expect(sql).toMatch(/site_id\s+uuid\s+primary key references public\.sites \(id\) on delete cascade/i);
    expect(sql).toMatch(/tenant_id\s+uuid\s+not null references public\.tenants \(id\) on delete cascade/i);
  });

  it("cannot store an 'ok' row without both reports, or an 'error' row without a code", () => {
    expect(sql).toMatch(/check \(status in \('ok', 'error'\)\)/i);
    expect(sql).toMatch(/check \(status <> 'ok' or \(report is not null and geo_report is not null\)\)/i);
    expect(sql).toMatch(/check \(status <> 'error' or error_code is not null\)/i);
  });

  it("has the (tenant_id, site_id) conflict target the tenantClient upsert needs", () => {
    expect(sql).toMatch(/constraint site_seo_audits_tenant_site unique \(tenant_id, site_id\)/i);
    const service = readFileSync(join(__dirname, "../../services/sites/site-seo.ts"), "utf8");
    expect(service).toContain('onConflict: "tenant_id,site_id"');
  });

  it("is service-role only", () => {
    expect(sql).toMatch(/alter table public\.site_seo_audits enable row level security/i);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).toMatch(/revoke all on table public\.site_seo_audits from public, anon, authenticated/i);
  });

  it("is registered in the tenantClient scope registry by tenant_id", () => {
    const registry = readFileSync(join(__dirname, "../../services/tenant-client.ts"), "utf8");
    expect(registry).toMatch(/^\s*site_seo_audits: "tenant_id",$/m);
  });
});
