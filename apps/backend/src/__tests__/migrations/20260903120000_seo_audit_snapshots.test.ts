import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260903120000_seo_audit_snapshots.sql",
  ),
  "utf8",
);

describe("20260903120000_seo_audit_snapshots.sql", () => {
  it("creates the table keyed one-row-per-tenant, cascading on tenant delete", () => {
    expect(sql).toMatch(/create table if not exists seo_audit_snapshots/i);
    expect(sql).toMatch(
      /tenant_id\s+uuid\s+primary key references tenants\(id\) on delete cascade/i,
    );
    expect(sql).toMatch(/schema_version\s+int\s+not null/i);
    expect(sql).toMatch(/fetched_at\s+timestamptz\s+not null/i);
  });

  it("constrains status to the two states the dashboard branches on", () => {
    expect(sql).toMatch(/status\s+text\s+not null check \(status in \('ok', 'error'\)\)/i);
  });

  it("cannot store an 'ok' row with no report, or an 'error' row with no code", () => {
    expect(sql).toMatch(/check \(status <> 'ok' or report is not null\)/i);
    expect(sql).toMatch(/check \(status <> 'error' or error_code is not null\)/i);
  });

  it("keeps jsonb columns type-guarded", () => {
    expect(sql).toMatch(/report\s+jsonb\s+check \(report is null or jsonb_typeof\(report\) = 'object'\)/i);
    expect(sql).toMatch(/jsonb_typeof\(notes\) = 'array'/i);
  });

  it("is service-role only: RLS on, no policy, grants revoked from client roles", () => {
    expect(sql).toMatch(/alter table seo_audit_snapshots enable row level security/i);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).toMatch(
      /revoke all on table seo_audit_snapshots from public, anon, authenticated/i,
    );
    expect(sql).toMatch(/grant all on table seo_audit_snapshots to service_role/i);
  });

  it("carries no measured-performance column", () => {
    const columns = sql.slice(
      sql.indexOf("create table if not exists seo_audit_snapshots"),
      sql.indexOf("alter table seo_audit_snapshots"),
    );
    for (const banned of [
      "clicks",
      "impressions",
      "ctr",
      "position",
      "sessions",
      "traffic",
      "rank",
    ]) {
      expect(columns.toLowerCase()).not.toContain(banned);
    }
  });

  it("wraps the DDL in a transaction", () => {
    expect(sql).toMatch(/^begin;/im);
    expect(sql).toMatch(/^commit;/im);
  });
});
