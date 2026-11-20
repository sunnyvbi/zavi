import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/0033_agent_feedback_extensions.sql",
  ),
  "utf-8",
);

describe("0033_agent_feedback_extensions.sql", () => {
  it("adds kind column with check ('rule','note') default 'note'", () => {
    expect(sql).toMatch(
      /add column kind text not null default 'note'\s+check \(kind in \('rule', 'note'\)\)/i,
    );
  });

  it("adds state column with check ('open','acknowledged','applied')", () => {
    expect(sql).toMatch(
      /add column state text not null default 'open'\s+check \(state in \('open', 'acknowledged', 'applied'\)\)/i,
    );
  });

  it("adds scope jsonb column (nullable)", () => {
    expect(sql).toMatch(/add column scope jsonb/i);
  });

  it("relaxes target_type and target_id NOT NULL", () => {
    expect(sql).toMatch(
      /alter table agent_feedback alter column target_type drop not null/i,
    );
    expect(sql).toMatch(
      /alter table agent_feedback alter column target_id drop not null/i,
    );
  });

  it("rewrites target_type check to allow NULL for slug-scoped rule/note rows", () => {
    expect(sql).toMatch(
      /target_type is null\s+or target_type in \('agent_run', 'decision'\)/i,
    );
  });

  it("makes the existing unique-per-user-target index partial (target_id NOT NULL)", () => {
    expect(sql).toMatch(
      /create unique index agent_feedback_unique_per_user_target[\s\S]+where target_id is not null/i,
    );
  });

  it("adds an index for the Feedback tab list query", () => {
    expect(sql).toMatch(
      /create index .*agent_feedback_tenant_agent_kind_state[\s\S]+\(tenant_id, agent_slug, kind, state, created_at desc\)/i,
    );
  });

  it("defines add_agent_rule(text, text) RPC", () => {
    expect(sql).toMatch(
      /create or replace function add_agent_rule\(\s*p_agent_slug text,\s*p_body text/i,
    );
  });

  it("add_agent_rule caps body length at 500 chars", () => {
    expect(sql).toMatch(/rule body too long.+500 chars/i);
  });

  it("add_agent_rule inserts kind='rule', state='open', target_id null", () => {
    const block = sql.match(
      /add_agent_rule[\s\S]*?insert into agent_feedback[\s\S]*?values \(([\s\S]*?)\)/i,
    );
    expect(block).not.toBeNull();
    const valuesBlock = block![1];
    expect(valuesBlock).toMatch(/'rule'/);
    expect(valuesBlock).toMatch(/'open'/);
  });

  it("defines add_agent_note(text, text, jsonb) RPC with scope param", () => {
    expect(sql).toMatch(
      /create or replace function add_agent_note\(\s*p_agent_slug text,\s*p_body text,\s*p_scope jsonb default null/i,
    );
  });

  it("add_agent_note caps body length at 4000 chars", () => {
    expect(sql).toMatch(/note body too long.+4000 chars/i);
  });

  it("defines list_agent_feedback(text) RPC returning 10 columns", () => {
    expect(sql).toMatch(/create or replace function list_agent_feedback\(\s*p_agent_slug text/i);
    for (const col of [
      "id uuid",
      "kind text",
      "state text",
      "scope jsonb",
      "rating smallint",
      "comment text",
      "target_type text",
      "target_id uuid",
      "created_by uuid",
      "created_at timestamptz",
    ]) {
      expect(sql).toMatch(new RegExp(col.replace(/ /g, "\\s+"), "i"));
    }
  });

  it("list_agent_feedback orders by created_at desc (newest first)", () => {
    expect(sql).toMatch(/order by af\.created_at desc/i);
  });

  it("all 3 RPCs are security definer with explicit set search_path", () => {
    const sd = sql.match(/language plpgsql\s+security definer/gi) ?? [];
    expect(sd.length).toBe(3);
    const sp = sql.match(/set search_path = public/gi) ?? [];
    expect(sp.length).toBe(3);
  });

  it("all 3 RPCs re-derive tenant_id from tenant_users by auth.uid() (Codex C8)", () => {
    const tenantLookups = sql.match(
      /from tenant_users tu\s+where tu\.user_id = v_user_id/gi,
    ) ?? [];
    expect(tenantLookups.length).toBe(3);
  });

  it("all 3 RPCs reject unauthenticated callers + non-tenant-members", () => {
    const unauth = sql.match(/raise exception 'unauthenticated'/gi) ?? [];
    expect(unauth.length).toBe(3);
    const unauthorized = sql.match(/raise exception 'unauthorized'/gi) ?? [];
    expect(unauthorized.length).toBe(3);
  });

  it("write RPCs reject empty agent_slug and empty body", () => {
    const slugRejects = sql.match(/agent_slug required/gi) ?? [];
    expect(slugRejects.length).toBe(3);
    const bodyRejects = sql.match(/body required/gi) ?? [];
    expect(bodyRejects.length).toBe(2);
  });

  it("revokes from public + grants to authenticated for all 3 RPCs", () => {
    expect(sql).toMatch(/revoke all on function add_agent_rule\(text, text\) from public/i);
    expect(sql).toMatch(/grant execute on function add_agent_rule\(text, text\) to authenticated/i);
    expect(sql).toMatch(
      /revoke all on function add_agent_note\(text, text, jsonb\) from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function add_agent_note\(text, text, jsonb\) to authenticated/i,
    );
    expect(sql).toMatch(/revoke all on function list_agent_feedback\(text\) from public/i);
    expect(sql).toMatch(/grant execute on function list_agent_feedback\(text\) to authenticated/i);
  });

  it("does NOT trust caller-supplied tenant_id (no p_tenant_id param anywhere)", () => {
    expect(sql).not.toMatch(/p_tenant_id\s+uuid/i);
  });

  it("does NOT alter or touch existing submit_agent_feedback RPC (kept stable)", () => {
    expect(sql).not.toMatch(/function submit_agent_feedback/i);
  });
});
