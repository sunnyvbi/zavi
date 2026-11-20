import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/0079_agent_seen_marker.sql"),
  "utf-8",
);

describe("0079_agent_seen_marker.sql", () => {
  it("creates agent_seen_marker with the composite PK", () => {
    expect(sql).toMatch(/create table if not exists agent_seen_marker/i);
    expect(sql).toMatch(
      /primary key \(user_id,\s*tenant_id,\s*agent_slug\)/i,
    );
  });

  it("enables RLS + owner-only select on agent_seen_marker", () => {
    expect(sql).toMatch(
      /alter table agent_seen_marker enable row level security/i,
    );
    expect(sql).toMatch(
      /create policy agent_seen_marker_owner on agent_seen_marker\s+for select using \(user_id = auth\.uid\(\)\)/i,
    );
  });

  it("mark_agent_seen is security definer + sets search_path", () => {
    expect(sql).toMatch(
      /create or replace function mark_agent_seen\(p_agent_slug text\)/i,
    );
    expect(sql).toMatch(
      /create or replace function mark_agent_seen[\s\S]*?language plpgsql\s+security definer\s+set search_path = public/i,
    );
  });

  it("mark_agent_seen upserts on the composite key", () => {
    expect(sql).toMatch(
      /on conflict \(user_id,\s*tenant_id,\s*agent_slug\)\s*do update set seen_at = now\(\)/i,
    );
  });

  it("mark_agent_seen is locked to authenticated (revoke public + grant)", () => {
    expect(sql).toMatch(
      /revoke all on function mark_agent_seen\(text\) from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function mark_agent_seen\(text\) to authenticated/i,
    );
  });

  it("DROPs list_agents_for_tenant before recreating (can't change return type in place)", () => {
    const dropIdx = sql.search(/drop function if exists list_agents_for_tenant\(\)/i);
    const createIdx = sql.search(/create function list_agents_for_tenant\(\)/i);
    expect(dropIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(-1);
    expect(dropIdx).toBeLessThan(createIdx);
    expect(sql).not.toMatch(
      /create or replace function list_agents_for_tenant\(\)/i,
    );
  });

  it("list_agents_for_tenant returns the 6 columns incl has_unseen_pending", () => {
    for (const col of [
      "slug text",
      "latest_run_started_at timestamptz",
      "latest_run_status text",
      "latest_event_preview text",
      "pending_decisions_count int",
      "has_unseen_pending boolean",
    ]) {
      expect(sql).toMatch(new RegExp(col.replace(/ /g, "\\s+"), "i"));
    }
  });

  it("has_unseen is NULL-safe (null emitted_at counts as unseen — never hide a real pending approval)", () => {
    expect(sql).toMatch(
      /bool_or\(\s*d\.emitted_at is null\s*or\s*d\.emitted_at > coalesce\(sm\.seen_at, '-infinity'::timestamptz\)\s*\)/i,
    );
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
