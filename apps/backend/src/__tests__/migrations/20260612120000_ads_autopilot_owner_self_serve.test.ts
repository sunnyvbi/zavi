import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260612120000_ads_autopilot_owner_self_serve.sql",
  ),
  "utf-8",
);

const ddl = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("20260612120000_ads_autopilot_owner_self_serve.sql", () => {
  it("creates set_tenant_ads_autopilot security-definer RPC with the locked signature", () => {
    expect(ddl).toMatch(
      /create or replace function set_tenant_ads_autopilot\(\s*p_tenant_id uuid,\s*p_actor_user_id uuid,\s*p_platform text,\s*p_enabled boolean,\s*p_max_daily_budget_usd numeric/i,
    );
    expect(ddl).toMatch(/language plpgsql security definer set search_path = public/i);
    expect(ddl).toMatch(/returns jsonb/i);
  });

  it("owner/admin-gates the actor → not_owner for a non-owner/non-member", () => {
    expect(ddl).toMatch(/from tenant_users\s*where user_id = p_actor_user_id and tenant_id = p_tenant_id/i);
    expect(ddl).toMatch(/if v_role is null or v_role not in \('owner', 'admin'\) then/i);
    expect(ddl).toMatch(/jsonb_build_object\('ok', false, 'reason', 'not_owner'\)/i);
  });

  it("enforces the self-serve ceiling read from system_config (default 500) → over_self_serve_max with max", () => {
    expect(ddl).toMatch(
      /coalesce\(\(blob->>'ads_autopilot_self_serve_max_usd'\)::numeric, 500\)/i,
    );
    expect(ddl).toMatch(/from system_config where id = 1/i);
    expect(ddl).toMatch(/if p_max_daily_budget_usd > v_ceiling then/i);
    expect(ddl).toMatch(
      /jsonb_build_object\('ok', false, 'reason', 'over_self_serve_max', 'max', v_ceiling\)/i,
    );
  });

  it("writes tenant_ads_write_caps (the table the ads dispatch reads), NOT the generic class-cap", () => {
    expect(ddl).toMatch(/insert into tenant_ads_write_caps\s*\(/i);
    expect(ddl).toMatch(/on conflict \(tenant_id, platform\)/i);
    expect(ddl).toMatch(/max_daily_budget_usd = excluded\.max_daily_budget_usd/i);
    expect(ddl).not.toMatch(/max_daily_usd/i);
    expect(ddl).not.toMatch(/set_tenant_class_caps/i);
  });

  it("sets sane non-null defaults on the other two dials when enabling (pct 0.50, aggregate 2× budget)", () => {
    expect(ddl).toMatch(/when p_enabled then 0\.50 else null end/i);
    expect(ddl).toMatch(/when p_enabled then 2 \* p_max_daily_budget_usd else null end/i);
  });

  it("reconciles by DELETE-ing a downgrading override on the budget auto-class", () => {
    expect(ddl).toMatch(/delete from tenant_decision_class_overrides/i);
    expect(ddl).toMatch(/'meta_ads\.update_ad_set_budget'/i);
    expect(ddl).toMatch(/'google_ads\.update_campaign_budget'/i);
    expect(ddl).toMatch(
      /autonomy in \('approval'::decision_autonomy, 'forbidden'::decision_autonomy\)/i,
    );
  });

  it("clamps the RESUME classes (set_status_review) never_auto=true — and NOT the pause classes", () => {
    expect(ddl).toMatch(
      /update decision_classes\s*set never_auto = true\s*where slug in \('meta_ads\.set_status_review', 'google_ads\.set_status_review'\)/i,
    );
    expect(ddl).not.toMatch(/set never_auto = true[\s\S]*'meta_ads\.set_status'[^_]/i);
  });

  it("seeds ads_autopilot_self_serve_max_usd=500 only if absent (does not clobber a tuned value)", () => {
    expect(ddl).toMatch(
      /jsonb_set\(blob, '\{ads_autopilot_self_serve_max_usd\}', '500'::jsonb, true\)/i,
    );
    expect(ddl).toMatch(/not \(blob \? 'ads_autopilot_self_serve_max_usd'\)/i);
  });

  it("is service_role-only (revoked from public + authenticated)", () => {
    expect(ddl).toMatch(
      /revoke all on function set_tenant_ads_autopilot\(uuid, uuid, text, boolean, numeric\) from public/i,
    );
    expect(ddl).toMatch(
      /revoke all on function set_tenant_ads_autopilot\(uuid, uuid, text, boolean, numeric\) from authenticated/i,
    );
    expect(ddl).toMatch(
      /grant execute on function set_tenant_ads_autopilot\(uuid, uuid, text, boolean, numeric\) to service_role/i,
    );
  });
});
