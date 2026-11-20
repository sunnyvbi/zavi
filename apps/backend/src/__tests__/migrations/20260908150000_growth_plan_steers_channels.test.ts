import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260908150000_growth_plan_steers_channels.sql",
  ),
  "utf8",
);

const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("20260908150000_growth_plan_steers_channels.sql", () => {
  it("replaces growth_plan_bets.priority with an ASCENDING sort_order", () => {
    expect(sql).toMatch(/add column if not exists sort_order int/i);
    expect(sql).toMatch(/alter table growth_plan_bets drop column if exists priority/i);
  });

  it("leaves exactly ONE polarity — no descending index survives", () => {
    expect(code).not.toMatch(/priority\s+desc/i);
    expect(code).not.toMatch(/sort_order\s+desc/i);
    expect(code).toMatch(
      /create index if not exists growth_plan_bets_plan_idx\s+on growth_plan_bets \(plan_id, status, sort_order\)/i,
    );
  });

  it("does not name the column `rank` — reserved, and PostgREST mis-resolves it", () => {
    expect(code).not.toMatch(/add column if not exists rank\b/i);
    expect(code).not.toMatch(/\brank\s+int\b/i);
  });

  it("inverts on backfill rather than copying — a copy would silently reverse order", () => {
    expect(sql).toMatch(/set sort_order = 100 - least\(greatest\(priority, 0\), 100\)/i);
  });

  it("gives the plan its OWN ordering column instead of writing tenant_channels.priority", () => {
    expect(sql).toMatch(/add column if not exists plan_sort_order int/i);
    expect(sql).not.toMatch(/update tenant_channels[\s\S]{0,200}set[\s\S]{0,80}\bpriority\s*=/i);
  });

  it("keeps plan selection and founder permission as SEPARATE columns", () => {
    expect(sql).toMatch(/add column if not exists plan_selected\s+boolean not null default false/i);
    expect(sql).toMatch(/add column if not exists autorun\s+boolean not null default false/i);
    expect(sql).toMatch(/add column if not exists autorun_set_by\s+text/i);
    expect(sql).toMatch(/autorun_set_by in \('plan', 'founder'\)/i);
  });

  it("defaults autorun OFF — a schema default is not consent to spend", () => {
    expect(sql).toMatch(/autorun\s+boolean not null default false/i);
  });

  it("recreates set_growth_plan_bet, because dropping the column orphans the function", () => {
    expect(sql).toMatch(
      /drop function if exists set_growth_plan_bet\(uuid, uuid, uuid, text, text, text, text, text, text, int, text, text\)/i,
    );
    expect(sql).toMatch(/create or replace function set_growth_plan_bet\(/i);
    expect(sql).toMatch(/p_sort_order\s+int/i);
    const fn = sql.slice(sql.indexOf("create or replace function set_growth_plan_bet("));
    expect(fn).not.toMatch(/\bpriority\b/i);
  });

  it("keeps the security-definer posture on the recreated function", () => {
    const fn = sql.slice(sql.indexOf("create or replace function set_growth_plan_bet("));
    expect(fn).toMatch(/security definer set search_path = public, pg_temp/i);
    expect(fn).toMatch(
      /revoke all on function set_growth_plan_bet\([^)]*\) from public, anon, authenticated/i,
    );
  });

  it("keeps the cross-tenant guard on the recreated function", () => {
    const fn = sql.slice(sql.indexOf("create or replace function set_growth_plan_bet("));
    expect(fn).toMatch(/select 1 from growth_plan\s+where id = p_plan_id and tenant_id = p_tenant_id/i);
    expect(fn).toMatch(/where id = p_bet_id and tenant_id = p_tenant_id/i);
  });
});
