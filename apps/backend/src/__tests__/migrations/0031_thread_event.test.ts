import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/0031_thread_event.sql"),
  "utf-8",
);

describe("0031_thread_event.sql", () => {
  it("creates thread_event table", () => {
    expect(sql).toMatch(/create table thread_event/i);
  });

  it("table has bigint identity primary key (single sequence — T-1 cursor stability)", () => {
    expect(sql).toMatch(
      /id bigint generated always as identity primary key/i,
    );
  });

  it("declares all 10 kind enum values in check constraint", () => {
    const kinds = [
      "chat_user",
      "chat_assistant",
      "run_start",
      "reasoning",
      "tool_call",
      "file_read",
      "file_edit",
      "file_create",
      "decision",
      "run_end",
    ];
    for (const kind of kinds) {
      expect(sql).toMatch(new RegExp(`'${kind}'`));
    }
  });

  it("agent_run_id is nullable (chat rows may have no run yet)", () => {
    expect(sql).toMatch(
      /agent_run_id uuid references agent_runs\(id\) on delete cascade(?!\s+not null)/i,
    );
  });

  it("body and citations are not-null jsonb", () => {
    expect(sql).toMatch(/body jsonb not null/i);
    expect(sql).toMatch(
      /citations jsonb not null default '\[\]'::jsonb/i,
    );
  });

  it("indexes (tenant_id, agent_slug, created_at desc, id desc) for Chat tab access path", () => {
    expect(sql).toMatch(
      /create index .*thread_event.*\(tenant_id, agent_slug, created_at desc, id desc\)/is,
    );
  });

  it("partial index on (agent_run_id, created_at) for per-active-run realtime (T-3)", () => {
    expect(sql).toMatch(
      /create index .*thread_event.*\(agent_run_id, created_at\)/is,
    );
    expect(sql).toMatch(/where agent_run_id is not null/i);
  });

  it("enables RLS", () => {
    expect(sql).toMatch(
      /alter table thread_event enable row level security/i,
    );
  });

  it("RLS select policy gates on tenant_users membership", () => {
    expect(sql).toMatch(/create policy thread_event_member_select/i);
    expect(sql).toMatch(/tenant_users/);
    expect(sql).toMatch(/auth\.uid\(\)/);
  });

  it("has NO insert/update/delete policy (service role only — Codex C8)", () => {
    expect(sql).not.toMatch(
      /create policy[^;]*on thread_event[^;]*for (insert|update|delete)/i,
    );
  });

  it("adds thread_event to supabase_realtime publication", () => {
    expect(sql).toMatch(
      /alter publication supabase_realtime add table thread_event/i,
    );
  });
});
