import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260606091500_agent_shadow_runs.sql",
);

describe("20260606091500_agent_shadow_runs.sql", () => {
  it("migration file exists", () => {
    expect(existsSync(PATH)).toBe(true);
  });

  const sql = readFileSync(PATH, "utf-8");

  it("creates the dedicated agent_shadow_runs table (not agent_runs reuse)", () => {
    expect(sql).toMatch(/create table if not exists agent_shadow_runs/i);
    expect(sql).toMatch(/source_agent_run_id\s+uuid not null references agent_runs/i);
  });

  it("is idempotent — unique on (source, mode, provider, model)", () => {
    expect(sql).toMatch(/unique\s*\(source_agent_run_id,\s*mode,\s*provider,\s*model\)/i);
    expect(sql).toMatch(/on conflict \(source_agent_run_id, mode, provider, model\) do nothing/i);
  });

  it("enables RLS with member-select + service-role-only writes", () => {
    expect(sql).toMatch(/alter table agent_shadow_runs enable row level security/i);
    expect(sql).toMatch(/create policy asr_member_select on agent_shadow_runs\s+for select/i);
    expect(sql).toMatch(/revoke insert, update, delete on agent_shadow_runs from authenticated, anon/i);
  });

  it("C8 — insert_shadow_run re-derives tenant from the SOURCE row, never a caller param", () => {
    expect(sql).not.toMatch(/insert_shadow_run\([^)]*p_tenant_id/i);
    expect(sql).toMatch(/select tenant_id, agent_slug into v_tenant, v_slug\s*\n?\s*from agent_runs where id = p_source_agent_run_id/i);
  });

  it("P0 dogfood gate — rejects any tenant but 73db45ff", () => {
    expect(sql).toMatch(/v_tenant <> '73db45ff-457e-4541-bc8f-bdb625390204'::uuid/i);
    expect(sql).toMatch(/restricted to the dogfood tenant/i);
  });

  it("insert RPC is service-role only (a tenant user cannot write shadow rows)", () => {
    expect(sql).toMatch(/revoke all on function insert_shadow_run\([^)]*\) from public, authenticated, anon/i);
    expect(sql).toMatch(/grant execute on function insert_shadow_run\([^)]*\) to service_role/i);
  });

  it("revoke/grant signatures match the function's actual arg types (executable-mismatch guard)", () => {
    const createBlock = sql.match(/create or replace function insert_shadow_run\(([\s\S]*?)\)\s*returns/i);
    expect(createBlock, "could not find insert_shadow_run definition").toBeTruthy();
    const createTypes = (createBlock![1].match(/\b(uuid|text|boolean|jsonb|numeric|integer)\b/gi) ?? []).map((t) => t.toLowerCase());
    expect(createTypes.length).toBe(16);

    for (const verb of [/revoke all on function insert_shadow_run\(([^)]*)\)/i, /grant execute on function insert_shadow_run\(([^)]*)\)/i]) {
      const m = sql.match(verb);
      expect(m, `missing grant/revoke for insert_shadow_run`).toBeTruthy();
      const grantTypes = (m![1].match(/\b(uuid|text|boolean|jsonb|numeric|integer)\b/gi) ?? []).map((t) => t.toLowerCase());
      expect(grantTypes).toEqual(createTypes);
    }
  });

  it("shadow budget is a SEPARATE fail-closed lane (not class-cap, not tenant budget)", () => {
    expect(sql).toMatch(/create table if not exists shadow_daily_spend/i);
    expect(sql).toMatch(/function consume_shadow_budget_or_reject\(p_estimated_usd numeric\)/i);
    expect(sql).toMatch(/return 'over_cap'/);
    expect(sql).toMatch(/for update/i);
    expect(sql).toMatch(/if not found then return 'disabled'/i);
  });

  it("seeds the shadow_disabled kill flag + $20 cap default (distinct from provider_overrides_disabled)", () => {
    expect(sql).toMatch(/'\{shadow_disabled\}',\s*'false'::jsonb/i);
    expect(sql).toMatch(/'\{shadow_daily_budget_usd\}',\s*'20'::jsonb/i);
  });
});
