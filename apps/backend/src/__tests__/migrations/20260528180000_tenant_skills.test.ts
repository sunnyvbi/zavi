import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260528180000_tenant_skills.sql"),
  "utf-8",
);

describe("20260528180000_tenant_skills.sql", () => {
  it("creates the tenant_skills table", () => {
    expect(sql).toMatch(/create table tenant_skills/i);
  });

  it("FK ON DELETE CASCADE from tenants", () => {
    expect(sql).toMatch(/tenant_id\s+uuid not null references tenants\(id\) on delete cascade/i);
  });

  it("agent_slug + skill_name are NOT NULL", () => {
    expect(sql).toMatch(/agent_slug\s+text not null/i);
    expect(sql).toMatch(/skill_name\s+text not null/i);
  });

  it("constrains status to the lifecycle set, default candidate", () => {
    expect(sql).toMatch(
      /status text not null\s+check \(status in \('candidate', 'staged', 'approved', 'rejected', 'quarantined'\)\)\s+default 'candidate'/i,
    );
  });

  it("carries the founder-gate flags defaulting false", () => {
    expect(sql).toMatch(/founder_blessed boolean not null default false/i);
    expect(sql).toMatch(/faithfulness_clean boolean not null default false/i);
  });

  it("keeps emitted_tool_name (server-synthesized callable id) separate + nullable", () => {
    expect(sql).toMatch(/emitted_tool_name text\b/i);
    expect(sql).not.toMatch(/emitted_tool_name text not null/i);
  });

  it("records the approver the same way dream_candidates does (decided_by → auth.users)", () => {
    expect(sql).toMatch(/decided_by uuid references auth\.users\(id\)/i);
    expect(sql).toMatch(/decided_at timestamptz/i);
  });

  it("enforces at most ONE approved skill per (tenant, agent, callable id) via a partial unique index", () => {
    expect(sql).toMatch(
      /create unique index tenant_skills_approved_emitted_uq[\s\S]*on tenant_skills \(tenant_id, agent_slug, emitted_tool_name\)[\s\S]*where status = 'approved'/i,
    );
  });

  it("enables RLS and grants members SELECT-only on their own tenant (founder gate — no write policy)", () => {
    expect(sql).toMatch(/alter table tenant_skills enable row level security/i);
    expect(sql).toMatch(/create policy tenant_skills_member_select on tenant_skills\s+for select/i);
    expect(sql).not.toMatch(/create policy[^\n]*for (insert|update|delete)/i);
  });

  it("the member-select policy scopes by tenant_users membership (mirror of dream_candidates)", () => {
    expect(sql).toMatch(
      /using \(\s*exists \(select 1 from tenant_users tu\s+where tu\.user_id = auth\.uid\(\)\s+and tu\.tenant_id = tenant_skills\.tenant_id\)/i,
    );
  });

  it("defines the source-note integrity trigger function (SECURITY DEFINER, pinned search_path)", () => {
    expect(sql).toMatch(/create or replace function tenant_skills_assert_source_note\(\)/i);
    expect(sql).toMatch(/security definer\s+set search_path = public/i);
  });

  it("the trigger enforces all three provenance conditions (tenant + note_type + agent_slug)", () => {
    expect(sql).toMatch(/v_tenant_id is distinct from new\.tenant_id/i);
    expect(sql).toMatch(/v_note_type is distinct from 'agent_experience'/i);
    expect(sql).toMatch(/v_agent_slug is distinct from new\.agent_slug/i);
    expect(sql).toMatch(/if not found then[\s\S]*raise exception/i);
  });

  it("wires the trigger BEFORE INSERT OR UPDATE FOR EACH ROW", () => {
    expect(sql).toMatch(
      /create trigger tenant_skills_assert_source_note_trg\s+before insert or update on tenant_skills\s+for each row execute function tenant_skills_assert_source_note\(\)/i,
    );
  });
});
