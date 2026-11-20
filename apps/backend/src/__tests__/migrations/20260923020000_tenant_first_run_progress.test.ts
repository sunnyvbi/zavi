import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260923020000_tenant_first_run_progress.sql",
);

describe("migration 20260923020000_tenant_first_run_progress", () => {
  const sql = readFileSync(MIG_PATH, "utf8");
  const fn = sql.slice(
    sql.indexOf("create or replace function mark_first_run_progress"),
    sql.indexOf("revoke all on function mark_first_run_progress"),
  );

  it("enables RLS on the table", () => {
    expect(sql).toMatch(/alter table tenant_first_run_progress enable row level security/i);
  });

  it("has a member SELECT policy and a mandatory restrictive active-tenant policy", () => {
    expect(sql).toMatch(
      /create policy tenant_first_run_progress_member_select on tenant_first_run_progress\s+for select using \(\s*exists \(\s*select 1 from tenant_users tu\s+where tu\.user_id = auth\.uid\(\) and tu\.tenant_id = tenant_first_run_progress\.tenant_id/i,
    );
    expect(sql).toMatch(
      /on tenant_first_run_progress as restrictive for select\s+using \(tenant_id = nullif\(auth\.jwt\(\) -> 'app_metadata' ->> 'active_tenant_id', ''\)::uuid\)/i,
    );
  });

  it("has no DML policies (writes only through the RPC)", () => {
    const policies = sql.match(/create policy[^;]*;/gi) ?? [];
    expect(policies).toHaveLength(2);
    for (const p of policies) expect(p).toMatch(/for select/i);
  });

  it("the RPC is security definer with a pinned search_path", () => {
    expect(fn).toMatch(/security definer\s+set search_path = public, pg_temp/i);
  });

  it("takes the route's tenant and refuses a caller who is not a member of it", () => {
    expect(fn).toMatch(/v_user_id\s+uuid := auth\.uid\(\)/i);
    expect(fn).toMatch(/v_tenant_id := p_tenant_id/i);
    expect(fn).not.toMatch(/from profiles/i);
    expect(fn).toMatch(
      /not exists \(\s*select 1 from tenant_users\s+where user_id = v_user_id and tenant_id = v_tenant_id\s*\)/i,
    );
    expect(fn.indexOf("not a member of tenant")).toBeGreaterThan(-1);
    expect(fn.indexOf("not a member of tenant")).toBeLessThan(fn.indexOf("insert into tenant_first_run_progress"));
  });

  it("validates kind and key length, and bounds new keys at 20", () => {
    expect(fn).toMatch(/p_kind not in \('plan_opened', 'asked', 'made'\)/i);
    expect(fn).toMatch(/length\(p_key\) > 300/i);
    expect(fn).toMatch(/not \(v_existing \? p_key\)\s+and \(select count\(\*\) from jsonb_object_keys\(v_existing\)\) >= 20/i);
  });

  it("keeps the first plan-opened time", () => {
    expect(fn).toMatch(/plan_opened_at = coalesce\(tenant_first_run_progress\.plan_opened_at, now\(\)\)/i);
  });

  it("grants: execute to authenticated only, select to authenticated, nothing to anon", () => {
    expect(sql).toMatch(/revoke all on function mark_first_run_progress\(uuid, text, text\) from public/i);
    expect(sql).toMatch(/revoke all on function mark_first_run_progress\(uuid, text, text\) from anon/i);
    expect(sql).toMatch(/grant execute on function mark_first_run_progress\(uuid, text, text\) to authenticated/i);
    expect(sql).toMatch(/revoke all on table tenant_first_run_progress from anon/i);
    expect(sql).toMatch(/grant select on table tenant_first_run_progress to authenticated/i);
    expect(sql).not.toMatch(/grant (insert|update|delete|all)[^;]*tenant_first_run_progress/i);
  });
});
