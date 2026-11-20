import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260629234941_connector_skill_fk_cascade_and_runid_dedupe.sql",
  ),
  "utf-8",
);

describe("20260629234941_connector_skill_fk_cascade_and_runid_dedupe.sql", () => {
  it("reconnect-staleness FK approach is REMOVED (deferred to delete-on-disconnect hook)", () => {
    expect(sql).not.toMatch(/add constraint tenant_connector_skill_connector_fk/i);
    expect(sql).not.toMatch(/foreign key \(tenant_id, provider\)/i);
    expect(sql).not.toMatch(/references connector_metadata \(tenant_id, slug\)/i);
  });

  it("does NOT delete any tenant_connector_skill rows (no orphan pre-delete)", () => {
    expect(sql).not.toMatch(/delete from tenant_connector_skill/i);
  });

  it("FIX #2: adds last_run_id idempotency column", () => {
    expect(sql).toMatch(/add column if not exists last_run_id uuid/i);
  });

  it("FIX #2: recreates the RPC with a p_run_id parameter", () => {
    expect(sql).toMatch(/drop function if exists record_connector_skill_facts\(uuid, text, jsonb\)/i);
    expect(sql).toMatch(/create or replace function record_connector_skill_facts/i);
    expect(sql).toMatch(/p_run_id uuid default null/i);
  });

  it("FIX #2: hits only bumps when a DIFFERENT run reinforces the fact", () => {
    expect(sql).toMatch(/last_run_id is distinct from excluded\.last_run_id/i);
    expect(sql).toMatch(/when excluded\.last_run_id is null then 1/i);
  });

  it("RPC stays security definer + service_role-only grant (trust gate intact)", () => {
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = public/i);
    expect(sql).toMatch(
      /revoke all on function record_connector_skill_facts\(uuid, text, jsonb, uuid\)[\s\S]*from public, authenticated, anon/i,
    );
    expect(sql).toMatch(
      /grant execute on function record_connector_skill_facts\(uuid, text, jsonb, uuid\)[\s\S]*to service_role/i,
    );
  });
});
