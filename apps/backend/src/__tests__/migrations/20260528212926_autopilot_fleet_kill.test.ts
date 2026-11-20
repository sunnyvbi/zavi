import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260528212926_autopilot_fleet_kill.sql"),
  "utf-8",
);

describe("20260528212926_autopilot_fleet_kill.sql", () => {
  it("is a single-row table (id pinned to 1) seeded NOT halted", () => {
    expect(sql).toMatch(/create table if not exists autopilot_fleet_kill/i);
    expect(sql).toMatch(/id\s+int primary key default 1 check \(id = 1\)/i);
    expect(sql).toMatch(/halted\s+boolean not null default false/i);
    expect(sql).toMatch(/insert into autopilot_fleet_kill \(id, halted\) values \(1, false\)/i);
  });

  it("is_fleet_halted fails CLOSED (missing row → halted=true)", () => {
    expect(sql).toMatch(/create or replace function is_fleet_halted\(\)/i);
    expect(sql).toMatch(/select coalesce\(\(select halted from autopilot_fleet_kill where id = 1\), true\)/i);
    expect(sql).toMatch(/grant execute on function is_fleet_halted\(\) to authenticated, service_role/i);
  });

  it("the global flip (set_fleet_kill) is service_role-only, not authenticated", () => {
    expect(sql).toMatch(/create or replace function set_fleet_kill\(/i);
    expect(sql).toMatch(/grant execute on function set_fleet_kill\(boolean, text\) to service_role/i);
    expect(sql).not.toMatch(/grant execute on function set_fleet_kill\(boolean, text\) to authenticated/i);
  });

  it("RLS enabled + authenticated may read (for the halted banner)", () => {
    expect(sql).toMatch(/alter table autopilot_fleet_kill enable row level security/i);
    expect(sql).toMatch(/create policy autopilot_fleet_kill_select on autopilot_fleet_kill\s+for select to authenticated using \(true\)/i);
  });
});
