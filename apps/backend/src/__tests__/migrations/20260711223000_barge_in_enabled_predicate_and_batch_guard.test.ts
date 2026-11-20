import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260711223000_barge_in_enabled_predicate_and_batch_guard.sql",
  ),
  "utf-8",
);

function fnBody(name: string): string {
  const m = sql.match(
    new RegExp(`create or replace function ${name}[\\s\\S]*?\\$\\$;`, "i"),
  );
  if (!m) throw new Error(`${name} not found`);
  return m[0];
}

describe("20260711223000 — barge-in enabled predicate + batch guard", () => {
  it("P1: a batch fan-out CHILD can never be steered — all three RPCs exclude it", () => {
    expect(fnBody("enqueue_or_steer_chat_turn")).toMatch(/batch_id is null/i);
    expect(fnBody("enqueue_agent_run_steer")).toMatch(
      /v_batch is not null[\s\S]*batch_child/i,
    );
    expect(fnBody("drain_agent_run_steers")).toMatch(/r\.batch_id is null/i);
  });

  it("P1: ONE enabled-predicate — enqueue and drain can never disagree", () => {
    const pred = fnBody("barge_in_enabled_for_tenant");
    expect(pred).toMatch(/agent_barge_in_enabled/);
    expect(pred).toMatch(/agent_barge_in_disabled_tenants/);
    for (const f of ["enqueue_or_steer_chat_turn", "enqueue_agent_run_steer"]) {
      expect(fnBody(f)).toMatch(/barge_in_enabled_for_tenant\(p_tenant_id\)/i);
      expect(fnBody(f)).not.toMatch(/blob->>'agent_barge_in_enabled'/i);
    }
  });

  it("defaults OFF when the master key is absent (ships inert)", () => {
    expect(fnBody("barge_in_enabled_for_tenant")).toMatch(/coalesce\([\s\S]*false\)/i);
  });

  it("every function stays a pg_temp-pinned security definer with the grants intact", () => {
    for (const f of [
      "barge_in_enabled_for_tenant",
      "enqueue_or_steer_chat_turn",
      "enqueue_agent_run_steer",
      "drain_agent_run_steers",
    ]) {
      const b = fnBody(f);
      expect(b, f).toMatch(/security definer/i);
      expect(b, f).toMatch(/set search_path = public, pg_temp/i);
    }
    expect(sql).toMatch(
      /revoke all on function enqueue_agent_run_steer[\s\S]*from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /revoke all on function drain_agent_run_steers[\s\S]*from public, anon, authenticated/i,
    );
  });

  it("the chat RPC keeps its identity guards (membership + thread ownership + plain FOR UPDATE)", () => {
    const b = fnBody("enqueue_or_steer_chat_turn");
    expect(b).toMatch(/auth\.uid\(\)/);
    expect(b).toMatch(/tenant_users/);
    expect(b).toMatch(/not_thread_owner/);
    expect(b).toMatch(/for update;/);
    expect(b).not.toMatch(/for update skip locked[\s\S]*order by started_at/i);
  });
});
