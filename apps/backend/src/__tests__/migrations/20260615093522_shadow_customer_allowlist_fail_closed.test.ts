import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260615093522_shadow_customer_allowlist_fail_closed.sql",
);

describe("20260615093522_shadow_customer_allowlist_fail_closed.sql", () => {
  it("migration file exists", () => {
    expect(existsSync(PATH)).toBe(true);
  });

  const sql = readFileSync(PATH, "utf-8");

  it("(allowlist storage) seeds shadow_customer_tenant_ids = [] idempotently", () => {
    expect(sql).toMatch(/shadow_customer_tenant_ids/);
    expect(sql).toMatch(/when blob \? 'shadow_customer_tenant_ids' then blob/i);
    expect(sql).toMatch(/jsonb_set\(blob, '\{shadow_customer_tenant_ids\}', '\[\]'::jsonb, true\)/i);
  });

  it("(shared helper) shadow_tenant_allowed(uuid): dogfood always; customer via the list; fail-closed", () => {
    expect(sql).toMatch(/create or replace function shadow_tenant_allowed\(p_tenant_id uuid\)\s*\n?\s*returns boolean/i);
    expect(sql).toMatch(/p_tenant_id = '73db45ff-457e-4541-bc8f-bdb625390204'::uuid/i);
    expect(sql).toMatch(/return true;/i);
    expect(sql).toMatch(/blob->'shadow_customer_tenant_ids'\) @> to_jsonb\(p_tenant_id::text\)/i);
    expect(sql).toMatch(/return coalesce\(v_allowed, false\)/i);
    expect(sql).toMatch(/grant execute on function shadow_tenant_allowed\(uuid\) to service_role/i);
  });

  it("(both RPCs use the SAME helper — no per-RPC drift)", () => {
    const calls = sql.match(/if not shadow_tenant_allowed\(v_tenant\) then/gi) ?? [];
    expect(calls.length).toBe(2);
    expect(sql).not.toMatch(/v_tenant <> '73db45ff-457e-4541-bc8f-bdb625390204'::uuid/i);
  });

  it("(signature-parity) insert_shadow_run: drop the EXACT 17-arg sig, recreate the SAME (no overload drift)", () => {
    const dropBlock = sql.match(/drop function if exists insert_shadow_run\(([\s\S]*?)\);/i);
    expect(dropBlock, "missing drop of old insert_shadow_run signature").toBeTruthy();
    const dropTypes = (dropBlock![1].match(/\b(uuid|text|boolean|jsonb|numeric|integer)\b/gi) ?? []).map((t) => t.toLowerCase());
    expect(dropTypes.length).toBe(17);

    const createBlock = sql.match(/create or replace function insert_shadow_run\(([\s\S]*?)\)\s*returns/i);
    expect(createBlock, "missing insert_shadow_run definition").toBeTruthy();
    const createTypes = (createBlock![1].match(/\b(uuid|text|boolean|jsonb|numeric|integer)\b/gi) ?? []).map((t) => t.toLowerCase());
    expect(createTypes.length).toBe(17);
    expect(createTypes).toEqual(dropTypes);

    for (const verb of [/revoke all on function insert_shadow_run\(([^)]*)\)/i, /grant execute on function insert_shadow_run\(([^)]*)\)/i]) {
      const m = sql.match(verb);
      expect(m, "missing grant/revoke for insert_shadow_run").toBeTruthy();
      const types = (m![1].match(/\b(uuid|text|boolean|jsonb|numeric|integer)\b/gi) ?? []).map((t) => t.toLowerCase());
      expect(types).toEqual(createTypes);
    }
  });

  it("(signature-parity) grade_shadow_run: clean create-or-replace of the SAME 3-arg sig (no drop/overload)", () => {
    expect(sql).not.toMatch(/drop function if exists grade_shadow_run/i);
    const createBlock = sql.match(/create or replace function grade_shadow_run\(([\s\S]*?)\)\s*returns/i);
    expect(createBlock, "missing grade_shadow_run definition").toBeTruthy();
    const createTypes = (createBlock![1].match(/\b(uuid|text|integer)\b/gi) ?? []).map((t) => t.toLowerCase());
    expect(createTypes).toEqual(["uuid", "integer", "text"]);
  });

  it("(C8 preserved) both RPCs still re-derive tenant from the SOURCE row, never a caller param", () => {
    const insertArgs = sql.match(/create or replace function insert_shadow_run\(([\s\S]*?)\)\s*returns/i)![1];
    const gradeArgs = sql.match(/create or replace function grade_shadow_run\(([\s\S]*?)\)\s*returns/i)![1];
    expect(insertArgs).not.toMatch(/p_tenant_id/i);
    expect(gradeArgs).not.toMatch(/p_tenant_id/i);
    expect(sql).toMatch(/select tenant_id, agent_slug into v_tenant, v_slug\s*\n?\s*from agent_runs where id = p_source_agent_run_id/i);
    expect(sql).toMatch(/select ar\.tenant_id, asr\.status into v_tenant, v_status/i);
  });

  it("(idempotency preserved) insert keeps on conflict (source, mode, provider, model) do nothing", () => {
    expect(sql).toMatch(/on conflict \(source_agent_run_id, mode, provider, model\) do nothing/i);
  });

  it("(grade preserved) keeps the success|parse_failed status gate + idempotent comparison_score-null update", () => {
    expect(sql).toMatch(/v_status not in \('success', 'parse_failed'\)/i);
    expect(sql).toMatch(/where id = p_shadow_run_id\s*\n?\s*and comparison_score is null/i);
  });

  it("(PII/RLS) revokes the member-SELECT policy → staff/service_role only", () => {
    expect(sql).toMatch(/drop policy if exists asr_member_select on agent_shadow_runs/i);
    expect(sql).toMatch(/revoke select on agent_shadow_runs from authenticated, anon/i);
  });

  it("(safety contract) ships with an EMPTY allowlist — inert until Ravi opts a tenant in", () => {
    expect(sql).toMatch(/'\[\]'::jsonb/);
    const uuids = sql.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
    for (const u of uuids) expect(u.toLowerCase()).toBe("73db45ff-457e-4541-bc8f-bdb625390204");
  });
});
