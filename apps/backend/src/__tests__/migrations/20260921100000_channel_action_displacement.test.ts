import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260921100000_channel_action_displacement.sql"),
  "utf8",
);
const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const SIG = "displace_channel_actions\\(uuid, text, uuid, uuid\\[\\], text\\)";

describe("20260921100000_channel_action_displacement.sql", () => {
  it("adds displaced to both vocabularies without dropping what was there", () => {
    expect(code).toMatch(/'pending','acted','rejected','snoozed','redone','stale','displaced'/);
    expect(code).toMatch(/'proposed','acted','rejected','snoozed','redo_requested','redone','stale_flagged',\s*'displaced',/);
    for (const e of ["revised", "approved", "executed", "exec_failed"]) {
      expect(code).toContain(`'${e}'`);
    }
  });

  it("is security definer with a pinned search_path", () => {
    expect(code).toMatch(/language plpgsql security definer set search_path = public, pg_temp/);
  });

  it("is service-role only", () => {
    expect(code).toMatch(new RegExp(`revoke all on function ${SIG}\\s+from public, anon, authenticated`));
    expect(code).toMatch(new RegExp(`grant execute on function ${SIG}\\s+to service_role`));
  });

  it("refuses a row of another tenant, another channel, or one already closed", () => {
    expect(code).toMatch(/tenant_id is distinct from p_tenant_id/);
    expect(code).toMatch(/channel_slug is distinct from p_channel_slug/);
    expect(code).toMatch(/status not in \('pending', 'snoozed'\)/);
  });

  it("never displaces an action whose execution is in flight", () => {
    expect(code).toMatch(/exec_status[^)]*\)\s*in \('queued', 'dispatching'\)/);
  });

  it("writes once per (run, action) on an Inngest replay", () => {
    expect(code).toMatch(/'displaced:' \|\| p_run_id \|\| ':' \|\| v_id/);
    expect(code).toMatch(/where action_id = v_id and event_key = v_key/);
  });

  it("keeps the row and names what beat it, rather than deleting", () => {
    expect(code).not.toMatch(/delete from channel_actions/i);
    expect(code).toMatch(/highest new: /);
    expect(code).toMatch(/insert into channel_action_events/);
  });

  it("decides nothing by age: no interval, no age comparison, no now() threshold", () => {
    const body = code.slice(code.indexOf("create or replace function displace_channel_actions"));
    expect(body).not.toMatch(/interval/i);
    expect(body).not.toMatch(/proposed_at\s*[<>]/);
    expect(body).not.toMatch(/now\(\)\s*-/);
    expect(body).not.toMatch(/order by/i);
    expect(body.match(/now\(\)/g) ?? []).toHaveLength(1);
  });
});
