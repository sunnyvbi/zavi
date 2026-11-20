import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260708075054_perf_dashboard_snapshots.sql",
  ),
  "utf8",
);

describe("20260708075054_perf_dashboard_snapshots.sql", () => {
  it("creates the table with a window CHECK, schema_version, and (tenant_id, window) PK", () => {
    expect(sql).toMatch(/create table if not exists perf_dashboard_snapshots/i);
    expect(sql).toMatch(/primary key \(tenant_id, "window"\)/i);
    expect(sql).toMatch(/schema_version\s+int\s+not null/i);
    expect(sql).toMatch(/check \("window" in \(/i);
    for (const w of [
      "last_7d",
      "last_14d",
      "last_28d",
      "last_30d",
      "this_month",
      "last_month",
    ]) {
      expect(sql).toContain(`'${w}'`);
    }
  });

  it("enables RLS and defines NO policy for authenticated (RPC-only access)", () => {
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).not.toMatch(/create policy/i);
  });

  it("defines both RPCs as security definer with a pinned search_path", () => {
    expect(sql).toMatch(/function get_perf_dashboard_snapshot/i);
    expect(sql).toMatch(/function upsert_perf_dashboard_snapshot/i);
    const definerCount = (sql.match(/security definer/gi) ?? []).length;
    expect(definerCount).toBe(2);
    const searchPathCount = (
      sql.match(/set search_path = public, pg_temp/gi) ?? []
    ).length;
    expect(searchPathCount).toBe(2);
  });

  it("CROSS-TENANT P1: both RPCs check auth.uid() membership of p_tenant_id", () => {
    const membershipChecks = (
      sql.match(
        /from tenant_users\s+where user_id = auth\.uid\(\) and tenant_id = p_tenant_id/gi,
      ) ?? []
    ).length;
    expect(membershipChecks).toBe(2);
    expect(sql).toMatch(/raise exception 'not a member of tenant/i);
  });

  it("revokes EXECUTE from anon/public and grants only authenticated", () => {
    expect(sql).toMatch(
      /revoke all on function get_perf_dashboard_snapshot.*from public, anon/i,
    );
    expect(sql).toMatch(
      /revoke all on function upsert_perf_dashboard_snapshot.*from public, anon/i,
    );
    expect(sql).toMatch(
      /grant execute on function get_perf_dashboard_snapshot.*to authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function upsert_perf_dashboard_snapshot.*to authenticated/i,
    );
  });

  it("upsert is idempotent (ON CONFLICT) and returns fetched_at", () => {
    expect(sql).toMatch(/on conflict \(tenant_id, "window"\) do update/i);
    expect(sql).toMatch(/returning fetched_at into v_fetched_at/i);
    expect(sql).toMatch(/return v_fetched_at/i);
  });
});
