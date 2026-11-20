import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260530081605_autopilot_class_waivers.sql"),
  "utf-8",
);

const ddl = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("20260530081605_autopilot_class_waivers.sql", () => {
  it("adds the 3 waiver columns to the existing override table (additive only)", () => {
    expect(sql).toMatch(/alter table tenant_decision_class_overrides/i);
    expect(sql).toMatch(/add column if not exists waiver_expires_at\s+timestamptz/i);
    expect(sql).toMatch(/add column if not exists waiver_max_daily_usd\s+numeric/i);
    expect(sql).toMatch(
      /add column if not exists waiver_cooling_off_seconds\s+int\s+not null\s+default 0/i,
    );
    expect(ddl).not.toMatch(/drop\s+(table|function|type)\b/i);
  });

  it("grant_autopilot_waiver is security definer + service_role-only", () => {
    expect(sql).toMatch(/create or replace function grant_autopilot_waiver\(/i);
    expect(sql).toMatch(/language plpgsql security definer set search_path = public/i);
    expect(sql).toMatch(
      /revoke all on function grant_autopilot_waiver\(uuid, text, timestamptz, numeric, int\) from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function grant_autopilot_waiver\(uuid, text, timestamptz, numeric, int\) to service_role/i,
    );
    expect(sql).not.toMatch(
      /grant execute on function grant_autopilot_waiver\([^)]*\) to authenticated/i,
    );
  });

  it("grant_autopilot_waiver enforces the 7-day expiry ceiling", () => {
    expect(sql).toMatch(/v_max_expiry timestamptz := v_now \+ interval '7 days'/i);
    expect(sql).toMatch(/expires_at exceeds 7-day ceiling/i);
    expect(sql).toMatch(/expires_at must be in the future/i);
  });

  it("grant_autopilot_waiver enforces the $100 daily cap ceiling", () => {
    expect(sql).toMatch(/max_daily_usd must be >= 0/i);
    expect(sql).toMatch(/max_daily_usd exceeds \$100 ceiling/i);
    expect(ddl).toMatch(/p_max_daily_usd\s*>\s*100/);
  });

  it("grant_autopilot_waiver rejects negative cooling-off", () => {
    expect(sql).toMatch(/cooling_off_seconds must be >= 0/i);
  });

  it("grant_autopilot_waiver UPSERTs the row to autonomy='auto' + stamps waiver fields", () => {
    expect(sql).toMatch(/insert into tenant_decision_class_overrides/i);
    expect(sql).toMatch(/on conflict \(tenant_id, decision_class\) do update/i);
    expect(ddl).toMatch(
      /set autonomy\s*=\s*'auto'::decision_autonomy,[\s\S]*waiver_expires_at\s*=\s*excluded\.waiver_expires_at/i,
    );
    expect(ddl).toMatch(/waiver_max_daily_usd\s*=\s*excluded\.waiver_max_daily_usd/i);
    expect(ddl).toMatch(/waiver_cooling_off_seconds\s*=\s*excluded\.waiver_cooling_off_seconds/i);
    expect(ddl).not.toMatch(/do update[\s\S]*set[\s\S]*max_daily_usd\s*=\s*excluded\.max_daily_usd/i);
    expect(ddl).not.toMatch(/max_per_action_usd\s*=\s*excluded\.max_per_action_usd/i);
  });

  it("grant_autopilot_waiver appends a WORM ledger row with evidence.kind='waiver_grant'", () => {
    expect(sql).toMatch(/insert into autopilot_action_ledger/i);
    expect(sql).toMatch(/'kind',\s*'waiver_grant'/);
    expect(sql).toMatch(/'expires_at',\s*p_expires_at/);
    expect(sql).toMatch(/'max_daily_usd',\s*p_max_daily_usd/);
    expect(sql).toMatch(/'cooling_off_seconds',\s*p_cooling_off_seconds/);
  });

  it("revoke_autopilot_waiver is security definer + service_role-only", () => {
    expect(sql).toMatch(/create or replace function revoke_autopilot_waiver\(/i);
    expect(sql).toMatch(
      /revoke all on function revoke_autopilot_waiver\(uuid, text\) from public/i,
    );
    expect(sql).toMatch(
      /grant execute on function revoke_autopilot_waiver\(uuid, text\) to service_role/i,
    );
    expect(sql).not.toMatch(
      /grant execute on function revoke_autopilot_waiver\([^)]*\) to authenticated/i,
    );
  });

  it("revoke_autopilot_waiver clears waiver fields + reverts autonomy to default", () => {
    expect(ddl).toMatch(/update tenant_decision_class_overrides/i);
    expect(ddl).toMatch(/autonomy\s*=\s*v_default_autonomy/i);
    expect(ddl).toMatch(/waiver_expires_at\s*=\s*null/i);
    expect(ddl).toMatch(/waiver_max_daily_usd\s*=\s*null/i);
    expect(ddl).toMatch(/waiver_cooling_off_seconds\s*=\s*0/i);
    expect(ddl).toMatch(/select default_autonomy from decision_classes where slug = p_decision_class/i);
    expect(ddl).toMatch(/coalesce\(\s*\(select default_autonomy[\s\S]*?\),\s*'approval'::decision_autonomy/i);
  });

  it("revoke_autopilot_waiver is idempotent (returns had_waiver=false on no-op)", () => {
    expect(ddl).toMatch(/select waiver_expires_at into v_prior_expires_at/i);
    expect(ddl).toMatch(/v_had_waiver := v_prior_expires_at is not null/i);
    expect(ddl).toMatch(/jsonb_build_object\(\s*'ok',\s*true,\s*'had_waiver',\s*v_had_waiver\s*\)/i);
  });

  it("revoke_autopilot_waiver appends a WORM ledger row with evidence.kind='waiver_revoke'", () => {
    expect(sql).toMatch(/'kind',\s*'waiver_revoke'/);
    expect(sql).toMatch(/'had_waiver',\s*v_had_waiver/);
    expect(sql).toMatch(/'prior_expires_at',\s*v_prior_expires_at/);
  });

  it("uses the 'dispatch' ledger action (closest enum match for waiver policy)", () => {
    const matches = ddl.match(/p_tenant_id,\s*'dispatch'/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("is CREATE OR REPLACE only for the RPCs — no DROP", () => {
    expect(ddl).not.toMatch(/drop\s+function\b/i);
  });
});
