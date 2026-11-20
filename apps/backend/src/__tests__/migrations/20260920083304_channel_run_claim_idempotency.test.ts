import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260920083304_channel_run_claim_idempotency.sql",
  ),
  "utf8",
);
const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("20260920083304_channel_run_claim_idempotency.sql", () => {
  it("keys the claim on (tenant_id, channel_slug, request_id) with the TENANT FIRST", () => {
    expect(code).toMatch(/unique \(tenant_id, channel_slug, request_id\)/i);
    expect(code).not.toMatch(/unique \(request_id\)/i);
    expect(code).not.toMatch(/unique \(channel_slug, request_id\)/i);
  });

  it("serializes admission per tenant, and only per tenant", () => {
    expect(code).toMatch(
      /pg_advisory_xact_lock\(hashtextextended\('channel_run_claim:' \|\| p_tenant_id::text, 0\)\)/i,
    );
    expect(code).not.toMatch(/pg_advisory_lock\(/i);
  });

  it("counts in-flight admissions the ledger cannot see yet", () => {
    expect(code).toMatch(/sum\(estimate\)[\s\S]*from channel_run_claims[\s\S]*settled_at is null/i);
    expect(code).toMatch(/channel_budget_allows\(p_tenant_id, v_est \+ v_pending\)/i);
    expect(code).toMatch(/claimed_at > now\(\) - channel_claim_stale_after\(\)/i);
  });

  it("scopes every read and write by the injected tenant", () => {
    const fns = code.split(/create or replace function /).slice(1);
    const claim = fns.find((f) => f.startsWith("claim_channel_run"));
    const settle = fns.find((f) => f.startsWith("settle_channel_run_claim"));
    const release = fns.find((f) => f.startsWith("release_channel_run_claim"));
    expect(claim).toBeDefined();
    expect(settle).toBeDefined();
    expect(release).toBeDefined();
    for (const body of [claim!, settle!, release!]) {
      expect(body).toMatch(/tenant_id = p_tenant_id/);
    }
    expect(claim).toMatch(/raise exception 'claim_channel_run: tenant_id required'/i);
  });

  it("refuses a run id that never produced a run, and never drops one that did", () => {
    const release = code
      .split(/create or replace function /)
      .find((f) => f.startsWith("release_channel_run_claim"));
    expect(release).toMatch(/and run_id is null/i);
  });

  it("records the run id even when the stamp failed, but keeps holding the budget", () => {
    const settle = code
      .split(/create or replace function /)
      .find((f) => f.startsWith("settle_channel_run_claim"));
    expect(settle).toMatch(/run_id\s*=\s*coalesce\(run_id, p_run_id\)/i);
    expect(settle).toMatch(/case when coalesce\(p_visible_to_ledger, true\)/i);
  });

  it("RLS on, member SELECT + active-tenant RESTRICTIVE, no DML policy", () => {
    expect(code).toMatch(/alter table channel_run_claims enable row level security/i);
    expect(code).toMatch(
      /create policy channel_run_claims_member_select on channel_run_claims\s+for select/i,
    );
    expect(code).toMatch(
      /create policy channel_run_claims_active_tenant_restrict\s+on channel_run_claims as restrictive for select/i,
    );
    expect(code).not.toMatch(
      /on channel_run_claims[^;]*for (insert|update|delete|all)/i,
    );
  });

  it("revokes every function from the browser roles and grants only service_role", () => {
    for (const sig of [
      "claim_channel_run(uuid, text, text, int)",
      "settle_channel_run_claim(uuid, uuid, uuid, boolean)",
      "release_channel_run_claim(uuid, uuid)",
    ]) {
      const esc = sig.replace(/[()]/g, (c) => `\\${c}`);
      expect(code).toMatch(new RegExp(`revoke all on function ${esc}\\s+from public, anon, authenticated`, "i"));
      expect(code).toMatch(new RegExp(`grant execute on function ${esc}\\s+to service_role`, "i"));
    }
  });

  it("pins search_path on every security definer", () => {
    const definers = code.match(/security definer[^$]*/gi) ?? [];
    expect(definers.length).toBe(3);
    for (const d of definers) expect(d).toMatch(/set search_path = public, pg_temp/i);
  });
});
