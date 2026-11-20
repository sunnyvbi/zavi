import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations", "20261121100000_pause_past_cut_guard.sql"), "utf8");

describe("20261121100000_pause_past_cut_guard", () => {
  it("the class is approval-only, its own handler, never_auto, not click-allowlistable, re-clamped on conflict", () => {
    expect(sql).toMatch(/'approval',\s*'meta_ads\.pause_past_cut_guard',\s*true,\s*false/);
    expect(sql).toMatch(/never_auto\s+= excluded\.never_auto/);
  });

  it("one card per ad set per day across both rails: an atomic claim table, service-role only", () => {
    expect(sql).toMatch(/create table if not exists public\.pause_past_guard_claims[\s\S]*?primary key \(tenant_id, object_id, day\)/);
    expect(sql).toMatch(/alter table public\.pause_past_guard_claims enable row level security/);
    expect(sql).toMatch(/revoke all on public\.pause_past_guard_claims from public, anon, authenticated/);
    expect(sql).toMatch(/grant select, insert, update, delete on public\.pause_past_guard_claims to service_role/);
  });
});
