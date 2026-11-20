import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations", "20260930071500_tenant_reporting_timezone.sql"),
  "utf-8",
);
const code = sql.replace(/--.*$/gm, "");

describe("20260930071500_tenant_reporting_timezone", () => {
  it("adds a nullable text column with no backfill", () => {
    expect(code).toMatch(/alter table tenants\s+add column if not exists reporting_timezone text;/);
    expect(code).not.toMatch(/not null/i);
    expect(code).not.toMatch(/\bupdate\s+tenants\b/i);
  });

  it("guards the format with an idempotent CHECK that allows null", () => {
    expect(code).toMatch(/constraint tenants_reporting_timezone_format/);
    expect(code).toMatch(/reporting_timezone is null/);
    expect(code).toMatch(/pg_constraint where conname = 'tenants_reporting_timezone_format'/);
  });

  it("adds no function, grant or policy (writes go through the backend)", () => {
    expect(code).not.toMatch(/create (or replace )?function/i);
    expect(code).not.toMatch(/\bgrant\b/i);
    expect(code).not.toMatch(/create policy/i);
  });

  it("the CHECK regex is the same shape the backend validates (tenant-timezone.ts STORABLE_TZ)", () => {
    const backend = readFileSync(join(__dirname, "..", "..", "services", "analytics", "tenant-timezone.ts"), "utf-8");
    const sqlRe = /reporting_timezone ~ '([^']+)'/.exec(code)?.[1];
    const tsRe = /const STORABLE_TZ = \/(.+)\/;/.exec(backend)?.[1]?.replace(/\\\//g, "/");
    expect(sqlRe).toBeTruthy();
    expect(sqlRe).toBe(tsRe);
  });
});
