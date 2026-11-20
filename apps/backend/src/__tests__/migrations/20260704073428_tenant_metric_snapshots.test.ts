
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations");
const FILE = "20260704073428_tenant_metric_snapshots.sql";
const sql = readFileSync(join(MIGRATIONS_DIR, FILE), "utf8");
const flat = sql.replace(/\s+/g, " ").toLowerCase();

describe("tenant_metric_snapshots migration", () => {
  it("creates the table with the contract columns + tenant cascade", () => {
    expect(flat).toContain("create table tenant_metric_snapshots");
    expect(flat).toContain("id uuid primary key default gen_random_uuid()");
    expect(flat).toContain("tenant_id uuid not null references tenants(id) on delete cascade");
    expect(flat).toContain("value numeric");
    expect(flat).toContain("status text not null default 'measured'");
    expect(flat).toContain("check (status in ('measured', 'unavailable'))");
    expect(flat).toContain("check (window_kind in ('rolling_7d', 'day', 'calendar_week', 'point'))");
    expect(flat).toContain("window_start timestamptz");
    expect(flat).toContain("window_end timestamptz not null");
    expect(flat).toContain("meta jsonb not null default '{}'");
    expect(flat).toContain("created_at timestamptz not null default now()");
  });

  it("declares the re-measure grain the writer upserts on", () => {
    expect(flat).toContain("unique (tenant_id, metric_key, window_kind, window_end)");
  });

  it("enables RLS with member SELECT and NO authenticated write policy", () => {
    expect(flat).toContain("alter table tenant_metric_snapshots enable row level security");
    expect(flat).toContain("create policy tenant_metric_snapshots_member_select");
    expect(flat).toMatch(/for select using \( exists \( select 1 from tenant_users tu/);
    expect(flat).not.toContain("for insert");
    expect(flat).not.toContain("for update");
    expect(flat).not.toContain("for delete");
    expect(flat).not.toContain("for all");
  });

  it("self-adds the fail-closed active-tenant RESTRICTIVE policy", () => {
    expect(flat).toContain("create policy tenant_metric_snapshots_active_tenant_restrict");
    expect(flat).toContain("as restrictive for select");
    expect(flat).toContain(
      "tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid",
    );
  });

  it("is fresh-DB-safe (no seeded tenant ids, no data inserts)", () => {
    expect(flat).not.toContain("insert into");
    expect(flat).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});
