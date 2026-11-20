import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260705121500_engineer_pr_dispatch_notice_refs.sql",
);

describe("migration 20260705121500_engineer_pr_dispatch_notice_refs", () => {
  const sql = readFileSync(MIG_PATH, "utf8");

  it("creates the table keyed (decision_id, surface) with a surface CHECK", () => {
    expect(sql).toMatch(/create table if not exists public\.dispatch_notice_refs/i);
    expect(sql).toMatch(/primary key \(decision_id, surface\)/i);
    expect(sql).toMatch(/surface\s+text not null check \(surface in \('chat', 'slack'\)\)/i);
  });

  it("enables RLS with NO policies (default-deny; service-role writes only)", () => {
    expect(sql).toMatch(/alter table public\.dispatch_notice_refs enable row level security/i);
    expect(sql).not.toMatch(/create policy/i);
  });

  it("ci_status is a bounded lifecycle domain", () => {
    expect(sql).toMatch(/ci_status\s+text not null default 'pending'/i);
    expect(sql).toMatch(/check \(ci_status in \('pending', 'verifying', 'green', 'red', 'na'\)\)/i);
  });

  it("both write RPCs are security definer with a pinned search_path", () => {
    expect(sql).toMatch(/create or replace function upsert_dispatch_notice_ref/i);
    expect(sql).toMatch(/create or replace function set_dispatch_notice_ci/i);
    expect((sql.match(/security definer/gi) || []).length).toBe(2);
    expect((sql.match(/set search_path = public/gi) || []).length).toBe(2);
  });

  it("set_dispatch_notice_ci never moves BACKWARD out of a terminal state", () => {
    expect(sql).toMatch(/and ci_status not in \('green', 'red', 'na'\)/i);
  });

  it("upsert refreshes the ref but never reopens a settled ci_status", () => {
    expect(sql).toMatch(/on conflict \(decision_id, surface\) do update set/i);
    expect(sql).toMatch(/coalesce\(excluded\.notice_body, dispatch_notice_refs\.notice_body\)/i);
  });

  it("revokes EXECUTE from public/anon/authenticated on both RPCs", () => {
    expect(sql).toMatch(/revoke all on function upsert_dispatch_notice_ref/i);
    expect(sql).toMatch(/revoke all on function set_dispatch_notice_ci\(uuid, text, text\)\s*\n?\s*from public, anon, authenticated/i);
  });
});
