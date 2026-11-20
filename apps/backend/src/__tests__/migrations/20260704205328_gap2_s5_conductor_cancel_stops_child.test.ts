import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260704205328_gap2_s5_conductor_cancel_stops_child.sql",
  ),
  "utf-8",
);

describe("20260704205328_gap2_s5_conductor_cancel_stops_child.sql", () => {
  it("rebuilds cancel_conductor_run(uuid, uuid) returning jsonb (same signature — no reader break)", () => {
    expect(sql).toMatch(
      /create or replace function cancel_conductor_run\(\s*p_tenant_id\s+uuid,\s*p_conductor_run_id\s+uuid\s*\)\s+returns jsonb/i,
    );
  });

  it("stays security-definer with search_path public", () => {
    expect(sql).toMatch(
      /language plpgsql\s+security definer\s+set search_path = public/i,
    );
  });

  it("flips stop_requested=true on the in-flight stage child(ren)", () => {
    expect(sql).toMatch(
      /update agent_runs\s+set stop_requested = true/i,
    );
  });

  it("only stops IN-FLIGHT children (queued|running) — never re-touches terminal runs", () => {
    expect(sql).toMatch(/and status in \('queued', 'running'\)/i);
  });

  it("resolves children via dispatch_history (source_run_id = conductor_run_id -> target_run_id)", () => {
    expect(sql).toMatch(
      /from dispatch_history dh\s+where dh\.tenant_id = p_tenant_id\s+and dh\.source_run_id = p_conductor_run_id\s+and dh\.target_run_id is not null/i,
    );
  });

  it("tenant-scopes the child-stop write (defense-in-depth on the service-role UPDATE)", () => {
    expect(sql).toMatch(
      /update agent_runs\s+set stop_requested = true\s+where tenant_id = p_tenant_id/i,
    );
  });

  it("records stopped_children in the WORM evidence AND the return payload (audit scope)", () => {
    expect(sql).toMatch(/'stopped_children',\s*v_stopped_children/);
    const occurrences = sql.match(/'stopped_children',\s*v_stopped_children/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it("only stops children AFTER the atomic conductor flip succeeds (guarded on v_updated)", () => {
    const flipIdx = sql.search(/returning id into v_updated/i);
    const stopIdx = sql.search(/update agent_runs\s+set stop_requested = true/i);
    expect(flipIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeGreaterThan(flipIdx);
  });

  it("preserves tenant-binding on the conductor lookup + flip", () => {
    expect(sql).toMatch(
      /from conductor_runs\s+where id = p_conductor_run_id\s+and tenant_id = p_tenant_id/i,
    );
    expect(sql).toMatch(
      /update conductor_runs[\s\S]+where id = p_conductor_run_id\s+and tenant_id = p_tenant_id/i,
    );
    expect(sql).toMatch(/and status in \('provisioning', 'active'\)/i);
  });

  it("preserves the WORM append (no direct ledger INSERT)", () => {
    expect(sql).toMatch(/append_autopilot_action\(/);
    expect(sql).not.toMatch(/insert into autopilot_action_ledger/i);
  });

  it("preserves idempotency on already-terminal runs", () => {
    expect(sql).toMatch(/if v_prior_status in \('halted', 'done', 'failed'\)/i);
  });

  it("preserves the grant scope (service_role only, revoked from public, never authenticated/anon)", () => {
    expect(sql).toMatch(
      /revoke all on function cancel_conductor_run\(uuid, uuid\) from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function cancel_conductor_run\(uuid, uuid\) to service_role/i,
    );
    expect(sql).not.toMatch(/grant execute on function cancel_conductor_run.+to authenticated/i);
    expect(sql).not.toMatch(/grant execute on function cancel_conductor_run.+to anon/i);
  });
});
