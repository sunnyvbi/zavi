import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260904171051_geo_audit_snapshot_column.sql",
  ),
  "utf8",
);

describe("20260904171051_geo_audit_snapshot_column.sql", () => {
  it("adds geo_report to the EXISTING audit row rather than a second table", () => {
    expect(sql).toMatch(/alter table seo_audit_snapshots/i);
    expect(sql).toMatch(/add column if not exists geo_report jsonb/i);
    expect(sql).not.toMatch(/create table/i);
  });

  it("type-guards the jsonb column", () => {
    expect(sql).toMatch(
      /check \(geo_report is null or jsonb_typeof\(geo_report\) = 'object'\)/i,
    );
  });

  it("leaves geo_report nullable on purpose", () => {
    expect(sql).not.toMatch(/geo_report[^;]*not null/i);
    expect(sql).not.toMatch(/status <> 'ok' or geo_report is not null/i);
  });

  it("is idempotent and transactional", () => {
    expect(sql).toMatch(/^begin;/im);
    expect(sql).toMatch(/^commit;/im);
    expect(sql).toMatch(/if not exists/i);
  });

  it("records in the schema itself that this is not visibility data", () => {
    expect(sql).toMatch(/comment on column seo_audit_snapshots\.geo_report/i);
    expect(sql).toMatch(/never a citation count, share-of-voice or AI-traffic figure/i);
  });

  it("does not widen access to a service-role-only table", () => {
    expect(sql).not.toMatch(/grant .* to (anon|authenticated)/i);
    expect(sql).not.toMatch(/create policy/i);
  });
});
