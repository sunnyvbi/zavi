import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260705071230_gap5_agent_run_actor_stamp_trigger.sql"),
  "utf-8",
);

describe("agent_runs actor-stamp trigger (Gap 5 chat-attribution fix)", () => {
  it("COALESCE-defaults actor_source from trigger and actor_user_id from enqueued_by (never overwrites)", () => {
    expect(SQL).toMatch(/new\.actor_source\s*:=\s*coalesce\(new\.actor_source,\s*new\.trigger\)/);
    expect(SQL).toMatch(/new\.actor_user_id\s*:=\s*coalesce\(new\.actor_user_id,\s*new\.enqueued_by\)/);
  });
  it("is a BEFORE INSERT row trigger on agent_runs, idempotent (drop-if-exists)", () => {
    expect(SQL).toMatch(/drop trigger if exists agent_runs_stamp_actor on public\.agent_runs/);
    expect(SQL).toMatch(/before insert on public\.agent_runs\s+for each row execute function stamp_agent_run_actor\(\)/);
  });
});
