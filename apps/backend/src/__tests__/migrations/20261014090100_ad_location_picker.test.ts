import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations");
const keySql = readFileSync(join(dir, "20261014090000_tenant_fact_country_key.sql"), "utf8");
const sql = readFileSync(join(dir, "20261014090100_ad_location_picker.sql"), "utf8");

describe("20261014090000_tenant_fact_country_key", () => {
  it("adds the country key on its own (an enum value cannot be used in the transaction that adds it)", () => {
    expect(keySql).toMatch(/alter type tenant_fact_key add value if not exists 'country'/i);
    expect(keySql).not.toMatch(/^\s*begin;/im);
  });
});

describe("20261014090100_ad_location_picker", () => {
  it("only an ISO alpha-2 code can be stored as the country", () => {
    expect(sql).toMatch(/check \(key <> 'country' or value_text ~ '\^\[A-Z\]\{2\}\$'\)/);
  });

  it("ad_location_choices is RLS-on and service-role only, one row per targeted object per tenant", () => {
    expect(sql).toMatch(/create table if not exists public\.ad_location_choices/);
    expect(sql).toMatch(/alter table public\.ad_location_choices enable row level security/);
    expect(sql).toMatch(/revoke all on public\.ad_location_choices from public, anon, authenticated/);
    expect(sql).toMatch(/grant select, insert, update, delete on public\.ad_location_choices to service_role/);
    expect(sql).toMatch(/unique \(tenant_id, platform, object_id\)/);
    expect(sql).toMatch(/jsonb_array_length\(places\) <= 50/);
  });

  for (const slug of ["google_ads.replace_geo_targets_review", "meta_ads.replace_ad_set_geo_review"]) {
    it(`${slug}: approval, its own handler, never_auto, not click-allowlistable`, () => {
      const at = sql.indexOf(`'${slug}',\n    'Approval route`);
      expect(at).toBeGreaterThan(-1);
      const tuple = sql.slice(at, sql.indexOf(")", sql.indexOf(`'${slug}',\n    true`, at)) + 1);
      expect(tuple).toContain("'approval'");
      expect(tuple).toMatch(new RegExp(`'${slug.replace(/\./g, "\\.")}',\\s*true,\\s*false`));
    });
  }

  it("re-clamps on conflict, so an existing row can never stay auto-able", () => {
    expect(sql).toMatch(/on conflict \(slug\) do update/);
    expect(sql).toMatch(/never_auto\s+= excluded\.never_auto/);
  });
});
