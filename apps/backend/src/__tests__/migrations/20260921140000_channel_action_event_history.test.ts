import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260921140000_channel_action_event_history.sql"),
  "utf8",
);
const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const SIGS = [
  "set_channel_action\\(uuid, uuid, text, text, timestamptz, text, uuid\\)",
  "mark_channel_action_redone\\(uuid, uuid, uuid, text\\)",
];

describe("20260921140000_channel_action_event_history.sql", () => {
  it("keeps the snooze deadline on the event", () => {
    expect(code).toMatch(/add column if not exists snoozed_until timestamptz/i);
    expect(code).toMatch(/snoozed_until\)\s+values/);
    expect(code).toMatch(/when p_status = 'snoozed' then p_snoozed_until else null end/);
  });

  it("drops an execution error from the founder note on Done or Reject", () => {
    expect(code).toMatch(/p_status in \('acted', 'rejected'\)\s+and v_row\.exec_status = 'failed' then null/);
  });

  it("copies the founder who asked onto the redone event", () => {
    expect(code).toMatch(/event = 'redo_requested'/);
    expect(code).toMatch(/'redone', 'channel_run', v_actor/);
  });

  it("does not touch settle: the open card still reads the error from note", () => {
    expect(code).not.toMatch(/settle_channel_action_exec/);
    expect(code).not.toMatch(/set exec_status = 'failed'/);
  });

  it.each(SIGS)("%s stays service-role only", (sig) => {
    expect(code).toMatch(new RegExp(`revoke all on function ${sig}\\s+from public, anon, authenticated`, "i"));
    expect(code).toMatch(new RegExp(`grant execute on function ${sig}\\s+to service_role`, "i"));
  });

  it("both replacements stay security definer with a pinned search_path", () => {
    const defs = code.match(/language plpgsql security definer set search_path = public, pg_temp/gi) ?? [];
    expect(defs).toHaveLength(2);
  });
});
