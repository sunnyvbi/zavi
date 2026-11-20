import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const SQL = readFileSync(join(DIR, "20261024150000_site_photos_and_free_photo_retry.sql"), "utf-8");
const fn = (name: string) => {
  const i = SQL.indexOf(`create or replace function ${name}(`);
  if (i < 0) throw new Error(`${name} not found`);
  return SQL.slice(i, SQL.indexOf("$$;", i));
};

describe("20261024150000: site photos and one free photo retry per site", () => {
  it("adds a nullable column only", () => {
    expect(SQL).toMatch(/alter table public\.conductor_runs add column if not exists site_photos jsonb;/);
    expect(SQL).not.toMatch(/site_photos jsonb (not null|default)/i);
  });

  it("the claim is free once per site: missing photos, no earlier free retry, under the tenant's build lock, on the tenant's own rows", () => {
    const f = fn("claim_photo_retry");
    expect(f.indexOf("pg_advisory_xact_lock(hashtextextended('build:' || p_tenant_id::text, 0))")).toBeLessThan(f.indexOf("update conductor_runs"));
    expect(f).toMatch(/s\.tenant_id = p_tenant_id/);
    expect(f).toMatch(/r\.tenant_id = s\.tenant_id/);
    expect(f).toMatch(/r\.site_photos->>'status' = 'missing'/);
    expect(f).toMatch(/r\.site_photos->>'free_retry_run_id' is null/);
    expect(f).toMatch(/set credits_waived = true[\s\S]*status = 'provisioning'[\s\S]*objective like '\[refine\]%'/);
    expect(f).toMatch(/jsonb_build_object\('free_retry_run_id', p_conductor_run_id::text\)/);
  });

  it("a claim is never given back (no path to a second free retry)", () => {
    expect(SQL).not.toMatch(/release_photo_retry/);
    expect(SQL).not.toMatch(/- 'free_retry_run_id'\s*$/m);
  });

  it("the outcome is merged in one statement that keeps the current free-retry claim", () => {
    const f = fn("record_site_photos");
    expect(f).toMatch(/set site_photos = \(p_photos - 'free_retry_run_id'\)\s+\|\| case when r\.site_photos \? 'free_retry_run_id'/);
    expect(f).toMatch(/s\.tenant_id = p_tenant_id/);
    expect(f).toMatch(/r\.tenant_id = p_tenant_id/);
    expect(SQL).toContain("revoke all on function record_site_photos(uuid, uuid, jsonb) from public, anon, authenticated;");
  });

  it("a free photo retry never uses a Free tenant's free edit; the RPCs are service-role only", () => {
    expect(fn("_free_edits_used")).toMatch(/and not coalesce\(\(c\.goal_graph #>> '\{0,payload,photo_retry\}'\)::boolean, false\)/);
    for (const sig of ["photo_retry_free(uuid, uuid)", "claim_photo_retry(uuid, uuid, uuid)", "_free_edits_used(uuid, uuid)"]) {
      expect(SQL).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
    }
    expect(SQL).toContain("grant execute on function claim_photo_retry(uuid, uuid, uuid) to service_role;");
  });
});
