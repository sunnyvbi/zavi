import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(__dirname, "../../../../../supabase/migrations");
const strip = (sql: string) =>
  sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
const fnOf = (file: string) => {
  const code = strip(readFileSync(join(dir, file), "utf8"));
  return code.slice(code.indexOf("create or replace function approve_channel_action")).trim();
};

const prior = fnOf("20260928200000_cgo_approval_source.sql");
const next = fnOf("20261003120000_approve_channel_action_partial_no_retry.sql");

const ADDED = [
  "  if v_row.exec_status = 'failed'",
  "     and v_row.exec_result->>'code' in ('exec_partial', 'exec_outcome_unknown') then",
  "    return jsonb_build_object('ok', false, 'code', 'exec_partial_no_retry');",
  "  end if;",
];

describe("20261003120000_approve_channel_action_partial_no_retry.sql", () => {
  it("is the prior definition plus exactly the partial-risk check", () => {
    const nextLines = next.split("\n");
    const at = nextLines.indexOf(ADDED[0]!);
    expect(at).toBeGreaterThan(0);
    expect(nextLines.slice(at, at + ADDED.length)).toEqual(ADDED);
    const withoutAdded = [...nextLines.slice(0, at), ...nextLines.slice(at + ADDED.length)].join("\n");
    expect(withoutAdded).toBe(prior);
  });

  it("checks after the row lock and after the executed guard, before any write", () => {
    const lock = next.indexOf("for update");
    const executed = next.indexOf("'already_executed'");
    const check = next.indexOf("'exec_partial_no_retry'");
    const write = next.indexOf("update channel_actions");
    expect(lock).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(lock);
    expect(check).toBeGreaterThan(executed);
    expect(check).toBeLessThan(write);
  });

  it("keeps security definer, pinned search_path and service-role-only grants", () => {
    expect(next).toMatch(/language plpgsql security definer set search_path = public, pg_temp/i);
    expect(next).toMatch(/revoke all on function approve_channel_action\(uuid, uuid, text, uuid, text\)\s+from public, anon, authenticated;/i);
    expect(next).toMatch(/grant execute on function approve_channel_action\(uuid, uuid, text, uuid, text\) to service_role;/i);
    expect(next).not.toMatch(/grant execute on function approve_channel_action[^;]*(authenticated|anon)/i);
  });
});
