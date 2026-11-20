import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261003170000_retry_failed_build_in_place.sql";
const SQL = readFileSync(join(DIR, FILE), "utf-8");
const PRIOR = readFileSync(join(DIR, "20260923040000_build_pause_continue.sql"), "utf-8");

const body = (sql: string) =>
  sql
    .slice(sql.indexOf("create or replace function continue_paused_build("), sql.indexOf("end $$;"))
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

describe("retry a failed build in place (20261003170000)", () => {
  it("flips a paused build or a failed build that was never paused and was not stopped by the founder, still pinned to the row version read", () => {
    expect(body(SQL)).toMatch(
      /and \(status = 'paused' or \(status = 'failed' and paused_at is null\s+and coalesce\(failure_class, ''\) not in \('user_cancelled', 'provision_failed', 'coach_precedence'\)\)\)\s+and updated_at = p_expected_updated_at/,
    );
  });

  it("cleared the first-build waiver on a failed-build retry (superseded by 20261005120050, which keeps it)", () => {
    expect(body(SQL)).toMatch(
      /updated_at = now\(\),\s+credits_waived = case when status = 'failed' then false else credits_waived end\s+where id = p_run_id/,
    );
  });

  it("changes nothing else: same lock, supersede rule, running-build rule and grants", () => {
    const norm = (s: string) =>
      body(s)
        .replace(/\s+/g, " ")
        .replace(", credits_waived = case when status = 'failed' then false else credits_waived end", "")
        .replace(
          "and (status = 'paused' or (status = 'failed' and paused_at is null and coalesce(failure_class, '') not in ('user_cancelled', 'provision_failed', 'coach_precedence')))",
          "and status = 'paused'",
        );
    expect(norm(SQL)).toBe(norm(PRIOR));
    expect(SQL).toMatch(/revoke all on function continue_paused_build\(uuid, uuid, timestamptz, jsonb\) from public, anon, authenticated;/);
    expect(SQL).toMatch(/grant execute on function continue_paused_build\(uuid, uuid, timestamptz, jsonb\) to service_role;/);
  });
});
