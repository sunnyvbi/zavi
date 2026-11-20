import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260530092541_refine_suggestions.sql",
  ),
  "utf-8",
);

describe("20260530092541_refine_suggestions.sql", () => {
  it("creates refine_suggestions with tenant cascade + conductor_run set-null + status CHECK enum", () => {
    expect(sql).toMatch(/create table if not exists refine_suggestions/i);
    expect(sql).toMatch(
      /tenant_id\s+uuid not null references tenants\(id\) on delete cascade/i,
    );
    expect(sql).toMatch(
      /conductor_run_id\s+uuid references conductor_runs\(id\) on delete set null/i,
    );
    expect(sql).toMatch(/suggestion\s+text not null/i);
    expect(sql).toMatch(/evidence\s+jsonb not null default '\{\}'::jsonb/i);
    expect(sql).toMatch(
      /check \(status in \('pending','dismissed','accepted'\)\)/i,
    );
  });

  it("declares the tenant+status query index (workspace UI list) and the conductor-run probe index (worker idempotency)", () => {
    expect(sql).toMatch(
      /create index if not exists refine_suggestions_tenant_status_idx/i,
    );
    expect(sql).toMatch(
      /create index if not exists refine_suggestions_conductor_run_idx/i,
    );
    expect(sql).toMatch(/where conductor_run_id is not null/i);
  });

  it("RLS enabled + tenant-member SELECT-only policy (writes only via RPC + service-role)", () => {
    expect(sql).toMatch(
      /alter table refine_suggestions enable row level security/i,
    );
    expect(sql).toMatch(
      /create policy refine_suggestions_select on refine_suggestions/i,
    );
    expect(sql).not.toMatch(
      /create policy .* on refine_suggestions\s+for (insert|update|delete)/i,
    );
  });

  it("set_refine_suggestion_status RPC: security-definer + service_role-only + status CHECK", () => {
    expect(sql).toMatch(
      /create or replace function set_refine_suggestion_status\(\s*p_tenant_id\s+uuid,\s*p_suggestion_id\s+uuid,\s*p_new_status\s+text/i,
    );
    expect(sql).toMatch(
      /language plpgsql security definer set search_path = public/i,
    );
    expect(sql).toMatch(
      /revoke all on function set_refine_suggestion_status\(uuid, uuid, text\) from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function set_refine_suggestion_status\(uuid, uuid, text\) to service_role/i,
    );
    expect(sql).toMatch(
      /p_new_status not in \('accepted','dismissed'\)/i,
    );
  });

  it("set_refine_suggestion_status RPC: row-locked select-for-update so concurrent accept+dismiss can't both win", () => {
    expect(sql).toMatch(/for update/i);
    expect(sql).toMatch(
      /where id = p_suggestion_id and tenant_id = p_tenant_id/i,
    );
  });

  it("set_refine_suggestion_status RPC: idempotent — already-terminal rows return the CURRENT status (no UPDATE)", () => {
    expect(sql).toMatch(/if v_current in \('accepted','dismissed'\)/i);
    expect(sql).toMatch(/return v_current/i);
  });

  it("migration header documents the Lovable-beat motivation + the morning-brief defensive read", () => {
    expect(sql).toMatch(/Lovable/i);
    expect(sql).toMatch(/morning-brief/i);
  });
});
