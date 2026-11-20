import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20261009100050_approve_channel_action_refuse_blocked.sql";
const PRIOR = "20261003120000_approve_channel_action_partial_no_retry.sql";
const strip = (sql: string) => sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
const fnOf = (file: string) => {
  const code = strip(readFileSync(join(dir, file), "utf8"));
  return code.slice(code.indexOf("create or replace function approve_channel_action")).trim();
};
const prior = fnOf(PRIOR);
const next = fnOf(FILE);

const ADDED = [
  "  if v_row.exec_status = 'failed'",
  "     and v_row.exec_result->>'bucket' = 'blocked_on_us' then",
  "    return jsonb_build_object('ok', false, 'code', 'exec_blocked_no_retry');",
  "  end if;",
  "  if v_row.exec_status = 'failed'",
  "     and (v_row.exec_result->>'bucket' = 'partial_risk'",
  "          or v_row.exec_result->>'code' in ('exec_partial', 'exec_outcome_unknown')) then",
  "    return jsonb_build_object('ok', false, 'code', 'exec_partial_no_retry');",
  "  end if;",
];

describe(FILE, () => {
  it("rebuilds from the LATEST definition, and every later redefinition keeps both guards", () => {
    const defs = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => /create\s+or\s+replace\s+function\s+(public\.)?approve_channel_action\s*\(/i.test(readFileSync(join(dir, f), "utf8")))
      .sort();
    const at = defs.indexOf(FILE);
    expect(defs.slice(at - 1, at + 1)).toEqual([PRIOR, FILE]);
    for (const later of defs.slice(at + 1)) {
      const lines = fnOf(later).split("\n");
      const first = lines.indexOf(ADDED[0]!);
      expect(first, later).toBeGreaterThan(0);
      expect(lines.slice(first, first + ADDED.length), later).toEqual(ADDED);
    }
  });

  it("is the prior definition plus exactly the two guards, right before the replay branch", () => {
    const lines = next.split("\n");
    const at = lines.indexOf(ADDED[0]!);
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at, at + ADDED.length)).toEqual(ADDED);
    expect([...lines.slice(0, at), ...lines.slice(at + ADDED.length)].join("\n")).toBe(prior);
  });

  it("checks after the row lock and before any write; needs_founder stays approvable", () => {
    const lock = next.indexOf("for update");
    const check = next.indexOf("'exec_blocked_no_retry'");
    expect(lock).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(lock);
    expect(check).toBeLessThan(next.indexOf("update channel_actions"));
    expect(check).toBeLessThan(next.indexOf("'illegal_transition'"));
    expect(next).not.toContain("needs_founder");
  });

  it("refuses a dead attempt BEFORE the replay branch, so a retried click never hears 'queued'", () => {
    const replay = next.indexOf("event_key = v_key");
    expect(next.indexOf("'exec_blocked_no_retry'")).toBeLessThan(replay);
    expect(next.indexOf("'exec_partial_no_retry'")).toBeLessThan(replay);
  });

  it("keeps security definer, pinned search_path and service-role-only grants", () => {
    expect(next).toMatch(/language plpgsql security definer set search_path = public, pg_temp/i);
    expect(next).toMatch(/revoke all on function approve_channel_action\(uuid, uuid, text, uuid, text\)\s+from public, anon, authenticated;/i);
    expect(next).toMatch(/grant execute on function approve_channel_action\(uuid, uuid, text, uuid, text\) to service_role;/i);
    expect(next).not.toMatch(/grant execute on function approve_channel_action[^;]*(authenticated|anon)/i);
  });
});
