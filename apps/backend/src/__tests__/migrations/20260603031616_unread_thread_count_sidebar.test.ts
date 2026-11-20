import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260603031616_unread_thread_count_sidebar.sql",
  ),
  "utf-8",
);

describe("20260603031616_unread_thread_count_sidebar.sql", () => {
  it("creates agent_thread_seen_marker keyed per (user, thread)", () => {
    expect(sql).toMatch(
      /create table if not exists agent_thread_seen_marker/i,
    );
    expect(sql).toMatch(/primary key \(user_id,\s*thread_id\)/i);
  });

  it("enables RLS + owner-only select on agent_thread_seen_marker", () => {
    expect(sql).toMatch(
      /alter table agent_thread_seen_marker enable row level security/i,
    );
    expect(sql).toMatch(
      /create policy agent_thread_seen_marker_owner on agent_thread_seen_marker\s+for select using \(user_id = auth\.uid\(\)\)/i,
    );
  });

  it("mark_thread_seen is security definer + sets search_path", () => {
    expect(sql).toMatch(
      /create or replace function mark_thread_seen\(p_thread_id uuid\)/i,
    );
    expect(sql).toMatch(
      /create or replace function mark_thread_seen[\s\S]*?language plpgsql\s+security definer\s+set search_path = public/i,
    );
  });

  it("mark_thread_seen enforces thread ownership (trust boundary) before upsert", () => {
    expect(sql).toMatch(/raise exception 'thread not owned by caller'/i);
    expect(sql).toMatch(
      /on conflict \(user_id,\s*thread_id\)\s*do update set seen_at = now\(\)/i,
    );
  });

  it("mark_thread_seen is locked to authenticated (revoke public + grant)", () => {
    expect(sql).toMatch(
      /revoke all on function mark_thread_seen\(uuid\) from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function mark_thread_seen\(uuid\) to authenticated/i,
    );
  });

  it("DROPs list_agents_for_tenant before recreating (return-type change)", () => {
    const dropIdx = sql.search(
      /drop function if exists list_agents_for_tenant\(\)/i,
    );
    const createIdx = sql.search(/create function list_agents_for_tenant\(\)/i);
    expect(dropIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(-1);
    expect(dropIdx).toBeLessThan(createIdx);
    expect(sql).not.toMatch(
      /create or replace function list_agents_for_tenant\(\)/i,
    );
  });

  it("list_agents_for_tenant adds unseen_thread_count, keeps the prior 6 columns", () => {
    for (const col of [
      "slug text",
      "latest_run_started_at timestamptz",
      "latest_run_status text",
      "latest_event_preview text",
      "pending_decisions_count int",
      "has_unseen_pending boolean",
      "unseen_thread_count int",
    ]) {
      expect(sql).toMatch(new RegExp(col.replace(/ /g, "\\s+"), "i"));
    }
  });

  it("unread count is per-thread, assistant-only, NULL-marker-safe (never opened = unread)", () => {
    expect(sql).toMatch(/m\.sender_role = 'assistant'/i);
    expect(sql).toMatch(
      /m\.created_at > coalesce\(tsm\.seen_at, '-infinity'::timestamptz\)/i,
    );
    expect(sql).toMatch(/t\.user_id = v_user_id/i);
    expect(sql).toMatch(/t\.deleted_at is null/i);
  });

  it("re-issues the revoke/grant for list_agents_for_tenant (they die with the drop)", () => {
    expect(sql).toMatch(
      /revoke all on function list_agents_for_tenant\(\) from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function list_agents_for_tenant\(\) to authenticated/i,
    );
  });

  it("list_agents_for_tenant keeps the tenant-membership guard (Codex C8)", () => {
    expect(sql).toMatch(/v_user_id uuid := auth\.uid\(\)/);
    expect(sql).toMatch(/raise exception 'not a member of tenant'/i);
  });
});
