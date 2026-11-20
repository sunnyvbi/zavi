import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260807090000_growth_suggestions.sql"),
  "utf8",
).toLowerCase();

describe("growth suggestions migration", () => {
  it("creates a distinct, RLS-protected staff ledger with the locked lifecycle", () => {
    expect(sql).toContain("create table if not exists public.growth_suggestions");
    expect(sql).toContain("status in ('draft', 'awaiting_client', 'approved', 'archived')");
    expect(sql).toContain("alter table public.growth_suggestions enable row level security");
    expect(sql).toContain("growth_suggestions_not_self_duplicate");
    expect(sql).toContain("revoke all on table public.growth_suggestions from public, anon, authenticated");
  });

  it("registers an approval-only, never-auto informational decision class", () => {
    expect(sql).toContain("'growth-lead.suggestion'");
    expect(sql).toMatch(/'approval',\s*null,\s*true,\s*false/);
  });

  it("pushes atomically through emit_decision and stores the decision id", () => {
    expect(sql).toContain("create or replace function public.push_growth_suggestions");
    expect(sql).toContain("public.emit_decision(");
    expect(sql).toContain("'rendered_markdown'");
    expect(sql).toContain("suggestion decision did not enter the approval queue");
    expect(sql).toContain("v_decision_autonomy is distinct from 'approval'");
    expect(sql).toContain("status = 'awaiting_client'");
    expect(sql).toContain("decision_id = v_decision_id");
    expect(sql).toContain("grant execute on function public.push_growth_suggestions(uuid[], uuid, uuid) to service_role");
  });

  it("projects existing decision outcomes back to approved/archived", () => {
    expect(sql).toContain("create or replace function public.sync_growth_suggestion_from_decision");
    expect(sql).toContain("set status = 'approved'");
    expect(sql).toContain("set status = 'archived'");
    expect(sql).toContain("after update of status on public.decisions");
  });

  it("applies the ledger and the transcript in one transaction", () => {
    expect(sql.match(/^begin;$/gm)).toHaveLength(1);
    expect(sql.match(/^commit;$/gm)).toHaveLength(1);
  });

  describe("staff chat transcript", () => {
    it("creates staff-only session and message tables", () => {
      expect(sql).toContain("create table if not exists public.growth_suggestion_sessions");
      expect(sql).toContain("create table if not exists public.growth_suggestion_messages");
      expect(sql).toContain("role in ('staff', 'zavi')");
    });

    it("keeps both tables unreadable by customers", () => {
      expect(sql).toContain("alter table public.growth_suggestion_sessions enable row level security");
      expect(sql).toContain("alter table public.growth_suggestion_messages enable row level security");
      expect(sql).toContain("revoke all on table public.growth_suggestion_sessions from public, anon, authenticated");
      expect(sql).toContain("revoke all on table public.growth_suggestion_messages from public, anon, authenticated");
      expect(sql).toContain("grant all on table public.growth_suggestion_sessions to service_role");
      expect(sql).toContain("grant all on table public.growth_suggestion_messages to service_role");
    });

    it("cascades from tenants so a deleted tenant leaves no transcript behind", () => {
      expect(sql).toMatch(/tenant_id\s+uuid not null references public\.tenants\(id\) on delete cascade/);
      expect(sql).toContain("references public.growth_suggestion_sessions(id) on delete cascade");
    });

    it("refuses a message whose tenant does not match its session", () => {
      expect(sql).toContain("create or replace function public.assert_growth_suggestion_message_tenant");
      expect(sql).toContain("message tenant does not match session tenant");
      expect(sql).toContain("before insert on public.growth_suggestion_messages");
    });

    it("advances the session recency cursor on every turn", () => {
      expect(sql).toContain("create or replace function public.touch_growth_suggestion_session");
      expect(sql).toContain("after insert on public.growth_suggestion_messages");
    });
  });
});
