import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260704224841_gap5_s5_split_rejected_by_and_resolver.sql",
  ),
  "utf-8",
);

describe("Gap 5 S5 migration — split rejected_by + resolver", () => {
  it("adds nullable rejected_by (FK auth.users, ON DELETE SET NULL) + rejected_at", () => {
    expect(SQL).toMatch(/add column if not exists rejected_by uuid references auth\.users\(id\) on delete set null/i);
    expect(SQL).toMatch(/add column if not exists rejected_at timestamptz/i);
    expect(SQL).not.toMatch(/update decisions[\s\S]*set rejected_by/i);
  });

  it("rebuilds exactly the 3 reject-writing RPCs (not approve_decision)", () => {
    expect(SQL).toMatch(/create or replace function decide_decision_as_actor/);
    expect(SQL).toMatch(/create or replace function decide_decision_as_staff/);
    expect(SQL).toMatch(/create or replace function reject_decision/);
    expect(SQL).not.toMatch(/create or replace function approve_decision/);
  });

  it("every reject path writes rejected_by, never approved_by", () => {
    expect(SQL).toMatch(/set status = 'rejected', rejected_by = auth\.uid\(\), rejected_at = now\(\)/);
    expect(SQL).toMatch(/rejected_by = case when p_action = 'reject'\s+then p_actor_user_id/);
    expect(SQL).toMatch(/approved_by = case when p_action = 'approve' then p_actor_user_id/);
    expect(SQL).not.toMatch(/set status = v_new_status, approved_by = p_actor_user_id, approved_at = now\(\)/);
  });

  it("preserves every guard + grant on the rebuilt RPCs (clean superset)", () => {
    expect(SQL).toMatch(/cross_tenant: decision % belongs to a different tenant/);
    expect(SQL).toMatch(/not_member: actor is not a member of tenant/);
    expect(SQL).toMatch(/perform _assert_tenant_admin\(v_tenant\)/);
    expect(SQL).toMatch(/security definer set search_path = public/);
    expect(SQL).toMatch(/grant execute on function decide_decision_as_actor\(uuid, uuid, uuid, text\) to service_role/);
    expect(SQL).toMatch(/grant execute on function decide_decision_as_staff\(uuid, uuid, uuid, text\) to service_role/);
    expect(SQL).toMatch(/jsonb_build_object\('changed', false/);
  });

  it("resolver: definer, caller-membership gated, staff→'Zavi staff', authenticated grant", () => {
    expect(SQL).toMatch(/create or replace function resolve_decision_actors/);
    expect(SQL).toMatch(/where tu\.user_id = auth\.uid\(\) and tu\.tenant_id = p_tenant_id[\s\S]*return; -- empty/);
    expect(SQL).toMatch(/else 'Zavi staff'/);
    expect(SQL).toMatch(/grant execute on function resolve_decision_actors\(uuid, uuid\[\]\) to authenticated, service_role/);
  });
});
