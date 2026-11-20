import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260528212925_autopilot_class_caps.sql"),
  "utf-8",
);

describe("20260528212925_autopilot_class_caps.sql", () => {
  it("adds nullable max_daily_usd + max_per_action_usd to the existing override table", () => {
    expect(sql).toMatch(/alter table tenant_decision_class_overrides/i);
    expect(sql).toMatch(/add column if not exists max_daily_usd\s+numeric/i);
    expect(sql).toMatch(/add column if not exists max_per_action_usd numeric/i);
  });

  it("caps RPC is security definer + authenticated, with a tenant-membership check", () => {
    expect(sql).toMatch(/create or replace function set_tenant_class_caps\(/i);
    expect(sql).toMatch(/language plpgsql security definer set search_path = public/i);
    expect(sql).toMatch(/not a member of tenant/i);
    expect(sql).toMatch(/grant execute on function set_tenant_class_caps\(.*\) to authenticated/i);
  });

  it("preserves autonomy on conflict (only updates the caps)", () => {
    expect(sql).toMatch(/on conflict \(tenant_id, decision_class\) do update/i);
    expect(sql).toMatch(/set max_daily_usd\s*=\s*excluded\.max_daily_usd/i);
    expect(sql).not.toMatch(/do update[\s\S]*set[\s\S]*autonomy\s*=\s*excluded\.autonomy/i);
  });

  it("rejects negative caps", () => {
    expect(sql).toMatch(/caps must be >= 0/i);
  });
});
