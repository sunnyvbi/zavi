import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260612130000_agent_chat_doc_inputs.sql",
  ),
  "utf-8",
);

describe("20260612130000_agent_chat_doc_inputs.sql", () => {
  it("creates the agent-chat-docs bucket idempotently, 10MB cap, doc mimes only", () => {
    expect(sql).toMatch(/insert into storage\.buckets/i);
    expect(sql).toMatch(/'agent-chat-docs'/);
    expect(sql).toMatch(/10485760/);
    expect(sql).toMatch(/'application\/pdf'/);
    expect(sql).toMatch(/wordprocessingml\.document/);
    expect(sql).toMatch(/'text\/csv'/);
    expect(sql).toMatch(/'text\/plain'/);
    expect(sql).not.toMatch(/'image\//);
    expect(sql).toMatch(/on conflict \(id\) do update/i);
  });

  it("denies anon + authenticated direct storage access (all I/O via service-role)", () => {
    expect(sql).toMatch(/agent_chat_docs_deny_anon_select/);
    expect(sql).toMatch(/agent_chat_docs_deny_anon_insert/);
    expect(sql).toMatch(/agent_chat_docs_deny_authenticated_select/);
    expect(sql).toMatch(/agent_chat_docs_deny_authenticated_insert/);
    expect(sql).not.toMatch(/auth\.uid\(\) is not null/);
  });

  it("uses drop-if-exists for all policies (idempotent re-apply)", () => {
    const dropCount = (sql.match(/drop policy if exists/g) ?? []).length;
    expect(dropCount).toBeGreaterThanOrEqual(4);
  });

  it("creates send_agent_chat_turn_v3 (explicit v3 name, 6 args incl p_doc_paths)", () => {
    expect(sql).toMatch(/create or replace function send_agent_chat_turn_v3/i);
    expect(sql).toMatch(/p_doc_paths text\[\]/);
    expect(sql).toMatch(
      /grant execute on function send_agent_chat_turn_v3\(text, text, text, uuid, text\[\], text\[\]\) to authenticated/i,
    );
  });

  it("enforces a tenant-scoped doc-only path regex (defense-in-depth)", () => {
    expect(sql).toMatch(/v_tenant_id::text \|\| '\/\[0-9a-f-\]\{36\}/);
    expect(sql).toMatch(/pdf\|docx\|csv\|txt/);
    expect(sql).toMatch(/doc path % does not belong to tenant/);
  });

  it("preserves the v2 security guards (C2 member-allowlist, enqueued_by, agent_run_id link)", () => {
    expect(sql).toMatch(/tenant_member_agents/);
    expect(sql).toMatch(/not in member allowlist/);
    expect(sql).toMatch(/enqueued_by/);
    expect(sql).toMatch(/agent_run_id/);
  });

  it("caps doc_paths at 4 per turn", () => {
    expect(sql).toMatch(/array_length\(p_doc_paths, 1\)[^>]*> 4/);
  });

  it("allows attachment-only turns (empty message OK when image OR doc present)", () => {
    expect(sql).toMatch(/array_length\(p_doc_paths, 1\), 0\) = 0/);
  });

  it("writes doc_paths to agent_runs.payload", () => {
    expect(sql).toMatch(/'doc_paths'/);
  });

  it("does NOT modify v2 or the 4-arg form (deploy-order safe — additive)", () => {
    expect(sql).not.toMatch(/create or replace function send_agent_chat_turn_v2/i);
    expect(sql).not.toMatch(/drop function .*send_agent_chat_turn/i);
  });

  it("is wrapped in a single transaction", () => {
    expect(sql).toMatch(/^begin;/m);
    expect(sql).toMatch(/^commit;\s*$/m);
  });
});
