
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20261005100000_admin_script_runs.sql"),
  "utf8",
).toLowerCase();

describe("admin_script_runs migration", () => {
  it("is service-role only: RLS on, no policies, privileges revoked", () => {
    expect(sql).toMatch(/alter table public\.admin_script_runs enable row level security/);
    expect(sql).not.toMatch(/create policy/);
    expect(sql).toMatch(/revoke all on public\.admin_script_runs from public, anon, authenticated/);
  });

  it("allows one running row per script and lock key", () => {
    expect(sql).toMatch(
      /create unique index admin_script_runs_one_running\s+on public\.admin_script_runs \(script_key, lock_key\)\s+where status = 'running'/,
    );
  });
});
