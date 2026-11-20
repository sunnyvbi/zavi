import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260603000000_admin_assist_task_queue_slice1.sql",
  ),
  "utf-8",
);

const RPCS = [
  "admin_task_create_once",
  "admin_task_claim",
  "admin_task_snooze",
  "admin_task_resolve",
  "admin_task_dismiss",
  "admin_action_log_append",
];

describe("20260603000000_admin_assist_task_queue_slice1.sql", () => {
  it("creates both tables", () => {
    expect(sql).toMatch(/create table if not exists admin_tasks/i);
    expect(sql).toMatch(/create table if not exists admin_action_log/i);
  });

  it("enables RLS on both tables (deny-all, no client write policies)", () => {
    expect(sql).toMatch(/alter table admin_tasks enable row level security/i);
    expect(sql).toMatch(/alter table admin_action_log enable row level security/i);
    expect(sql).not.toMatch(/create policy[\s\S]*on admin_tasks/i);
  });

  it("admin_action_log is WORM — a BEFORE UPDATE OR DELETE trigger raises", () => {
    expect(sql).toMatch(/before update or delete on admin_action_log/i);
    expect(sql).toMatch(/raise exception 'admin_action_log is append-only/i);
    expect(sql).toMatch(/errcode = '42501'/i);
  });

  it("has cross-tenant consistency triggers on both tables", () => {
    expect(sql).toMatch(/admin_tasks_tenant_consistency/i);
    expect(sql).toMatch(/admin_action_log_tenant_consistency/i);
    expect(sql).toMatch(/source_run_id[\s\S]*belongs to tenant/i);
    expect(sql).toMatch(/source_decision_id[\s\S]*belongs to tenant/i);
  });

  it("keys idempotency on idempotency_key (unique), NOT (tenant_id, kind)", () => {
    expect(sql).toMatch(/idempotency_key\s+text not null unique/i);
    expect(sql).not.toMatch(/unique[\s\S]{0,40}\(tenant_id,\s*kind\)/i);
    expect(sql).toMatch(/on conflict \(idempotency_key\) do nothing/i);
  });

  it("every RPC is revoked from public/anon/authenticated and granted service_role only", () => {
    for (const fn of RPCS) {
      expect(sql).toContain(fn);
    }
    expect(sql).toMatch(/revoke all on function %s from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function %s to service_role/i);
    expect(sql).not.toMatch(/grant execute on function[\s\S]*?to (authenticated|public|anon)/i);
  });

  it("all RPCs are security definer with a pinned search_path", () => {
    const definerCount = (sql.match(/security definer set search_path = public/gi) ?? []).length;
    expect(definerCount).toBeGreaterThanOrEqual(RPCS.length);
  });

  it("claim is a CAS open->claimed (single winner)", () => {
    expect(sql).toMatch(/set state = 'claimed'[\s\S]*?where id = p_task_id and state = 'open'/i);
  });

  it("adds the customer-visible on-behalf marker columns to memory_note", () => {
    expect(sql).toMatch(/alter table memory_note[\s\S]*last_edited_by_staff_at/i);
    expect(sql).toMatch(/last_edited_by_staff_email/i);
  });
});
