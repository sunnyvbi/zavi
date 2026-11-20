import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260612004737_click_allowlistable_and_never_auto_column.sql",
  ),
  "utf-8",
);

const ddl = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("20260612004737_click_allowlistable_and_never_auto_column.sql", () => {
  it("adds never_auto + click_allowlistable columns (not null default false, idempotent)", () => {
    expect(ddl).toMatch(
      /add column if not exists never_auto boolean not null default false/i,
    );
    expect(ddl).toMatch(
      /add column if not exists click_allowlistable boolean not null default false/i,
    );
  });

  it("backfills never_auto=true for browser.action + growth-lead.outreach-drafts", () => {
    expect(ddl).toMatch(
      /update decision_classes\s*set never_auto = true\s*where slug in \('browser\.action', 'growth-lead\.outreach-drafts'\)/i,
    );
  });

  it("backfills click_allowlistable=true ONLY for the safe non-money set, GUARDED on approval-default + not never_auto", () => {
    expect(ddl).toMatch(
      /set click_allowlistable = true\s*where slug in \('send_email', 'post_slack_message', 'create_jira_issue'\)/i,
    );
    expect(ddl).toMatch(/and default_autonomy = 'approval'/i);
    expect(ddl).toMatch(/and never_auto = false/i);
    expect(ddl).not.toMatch(/refund_stripe/);
    expect(ddl).not.toMatch(/meta_ads/);
    expect(ddl).not.toMatch(/google_ads/);
    expect(ddl).not.toMatch(/ban_user/);
  });

  it("effective_autonomy clamps on the never_auto COLUMN before consulting any override", () => {
    expect(ddl).toMatch(
      /create or replace function effective_autonomy\(\s*p_tenant_id uuid,\s*p_decision_class text/i,
    );
    expect(ddl).toMatch(/language plpgsql security definer set search_path = public stable/i);
    expect(ddl).toMatch(
      /if v_never_auto is true then\s*return 'approval'::decision_autonomy;\s*end if;/i,
    );
    const clampIdx = ddl.search(/if v_never_auto is true then\s*return 'approval'/i);
    const overrideIdx = ddl.search(/from tenant_decision_class_overrides/i);
    expect(clampIdx).toBeGreaterThan(-1);
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(clampIdx).toBeLessThan(overrideIdx);
    expect(ddl).not.toMatch(/= any \(array\['browser\.action'/i);
  });

  it("effective_autonomy keeps grants (authenticated + service_role)", () => {
    expect(ddl).toMatch(/revoke all on function effective_autonomy\(uuid, text\) from public/i);
    expect(ddl).toMatch(
      /grant execute on function effective_autonomy\(uuid, text\) to authenticated, service_role/i,
    );
  });

  it("set_tenant_autonomy rejects a non-'approval' override on a never_auto COLUMN class + keeps membership gate", () => {
    expect(ddl).toMatch(/if auth\.uid\(\) is null then\s*raise exception 'not authenticated'/i);
    expect(ddl).toMatch(/not a member of tenant/i);
    expect(ddl).toMatch(
      /if v_never_auto is true and p_autonomy <> 'approval'::decision_autonomy then\s*raise exception/i,
    );
    expect(ddl).toMatch(/revoke all on function set_tenant_autonomy\(uuid, text, decision_autonomy\) from public/i);
    expect(ddl).toMatch(
      /grant execute on function set_tenant_autonomy\(uuid, text, decision_autonomy\) to authenticated/i,
    );
  });

  it("allowlist_class_for_tenant — owner-gated, eligibility-gated, service_role-only", () => {
    expect(ddl).toMatch(
      /create or replace function allowlist_class_for_tenant\(\s*p_tenant_id uuid,\s*p_decision_class text,\s*p_actor_user_id uuid/i,
    );
    expect(ddl).toMatch(/language plpgsql security definer set search_path = public/i);
    expect(ddl).toMatch(/from tenant_users\s*where user_id = p_actor_user_id and tenant_id = p_tenant_id/i);
    expect(ddl).toMatch(/v_role not in \('owner', 'admin'\)/i);
    expect(ddl).toMatch(/'reason', 'not_owner'/i);
    expect(ddl).toMatch(/v_click_allowlistable is not true or v_never_auto is true/i);
    expect(ddl).toMatch(/'reason', 'not_allowlistable'/i);
    expect(ddl).toMatch(/autonomy = excluded\.autonomy/i);
    expect(ddl).toMatch(/'auto'::decision_autonomy/i);
    expect(ddl).toMatch(/'ok', true/i);
    expect(ddl).toMatch(/revoke all on function allowlist_class_for_tenant\(uuid, text, uuid\) from public/i);
    expect(ddl).toMatch(/revoke all on function allowlist_class_for_tenant\(uuid, text, uuid\) from authenticated/i);
    expect(ddl).toMatch(/grant execute on function allowlist_class_for_tenant\(uuid, text, uuid\) to service_role/i);
  });

  it("is non-destructive on the autonomy tables (no DROP, no ALTER of overrides table)", () => {
    expect(ddl).not.toMatch(/drop\s+(table|function|type)\b/i);
    expect(ddl).not.toMatch(/alter\s+table\s+tenant_decision_class_overrides/i);
  });
});
