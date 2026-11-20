import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260906191500_growth_plan_tables.sql"),
  "utf8",
);

const TABLES = ["growth_plan", "growth_plan_bets", "growth_plan_changes"];

const RPCS = ["log_growth_plan_change", "set_growth_plan", "set_growth_plan_bet"];

describe("20260906191500_growth_plan_tables.sql", () => {
  it("creates the three Slice-1 tables and NOT the four the spec defers", () => {
    for (const t of TABLES) {
      expect(sql, `${t} must be created`).toMatch(
        new RegExp(`create table if not exists ${t}\\b`, "i"),
      );
    }
    for (const deferred of [
      "growth_plan_outcomes",
      "growth_plan_learnings",
      "growth_plan_rejections",
      "growth_competitor_notes",
    ]) {
      expect(sql, `${deferred} must NOT ship in Slice 1`).not.toMatch(
        new RegExp(`create table[^;]*${deferred}`, "i"),
      );
    }
  });

  it("enables RLS on all three and grants SELECT only to tenant members", () => {
    for (const t of TABLES) {
      expect(sql).toMatch(new RegExp(`alter table ${t}\\s+enable row level security`, "i"));
      expect(sql).toMatch(new RegExp(`create policy ${t}_select on ${t}\\s+for select`, "i"));
    }
    const policyCount = (sql.match(/create policy \w+_select on/gi) ?? []).length;
    const scopedCount = (sql.match(/from tenant_users\s+where user_id = auth\.uid\(\)/gi) ?? []).length;
    expect(policyCount).toBe(TABLES.length);
    expect(scopedCount).toBe(TABLES.length);
  });

  it("has NO insert/update/delete policy — writes go through the RPCs or nowhere", () => {
    expect(sql).not.toMatch(/create policy[^;]*\bfor (insert|update|delete|all)\b/i);
    expect(sql).not.toMatch(/using \(true\)|with check \(true\)/i);
  });

  it("makes falsifier NOT NULL on bets (an optional falsifier is one nobody sets)", () => {
    const bets = sql.slice(
      sql.indexOf("create table if not exists growth_plan_bets"),
      sql.indexOf("create index if not exists growth_plan_bets_plan_idx"),
    );
    expect(bets).toMatch(/falsifier\s+text not null/i);
  });

  it("enforces at most ONE live plan per tenant at the database", () => {
    expect(sql).toMatch(
      /create unique index if not exists growth_plan_one_live_per_tenant\s+on growth_plan \(tenant_id\) where status = 'live'/i,
    );
  });

  it("is additive on autopilot_goals — three nullable columns, no backfill", () => {
    expect(sql).toMatch(/add column if not exists falsifier\s+text/i);
    expect(sql).toMatch(/add column if not exists status_changed_by\s+text/i);
    expect(sql).toMatch(/add column if not exists status_changed_at\s+timestamptz/i);
    expect(sql).not.toMatch(/create table[^;]*growth_goals/i);
    expect(sql).not.toMatch(/update autopilot_goals\s+set status_changed_by/i);
  });

  it("pins pg_temp and revokes execute from anon/authenticated on every RPC", () => {
    for (const fn of RPCS) {
      expect(sql).toMatch(
        new RegExp(`create or replace function ${fn}\\(`, "i"),
      );
      expect(sql).toMatch(
        new RegExp(`revoke all on function ${fn}\\([^)]*\\) from public, anon, authenticated`, "i"),
      );
      expect(sql).toMatch(
        new RegExp(`grant execute on function ${fn}\\([^)]*\\) to service_role`, "i"),
      );
    }
    const secdef = (sql.match(/security definer set search_path = ([^\n]+)/gi) ?? []);
    expect(secdef.length).toBe(RPCS.length);
    for (const line of secdef) expect(line).toMatch(/pg_temp/i);
  });

  it("appends a change-log row inside the same function as the write", () => {
    const setPlan = sql.slice(
      sql.indexOf("create or replace function set_growth_plan("),
      sql.indexOf("create or replace function set_growth_plan_bet("),
    );
    expect(setPlan).toMatch(/perform log_growth_plan_change\(/i);
    expect(setPlan).toMatch(/set status = 'superseded'/i);

    const setBet = sql.slice(sql.indexOf("create or replace function set_growth_plan_bet("));
    expect(setBet).toMatch(/perform log_growth_plan_change\(/i);
    expect(setBet).toMatch(/where id = p_bet_id and tenant_id = p_tenant_id/i);
  });

  it("proves a bet's plan belongs to the same tenant before inserting it", () => {
    const setBet = sql.slice(sql.indexOf("create or replace function set_growth_plan_bet("));
    const insertBranch = setBet.slice(0, setBet.indexOf("insert into growth_plan_bets"));
    expect(insertBranch).toMatch(
      /select 1 from growth_plan\s+where id = p_plan_id and tenant_id = p_tenant_id/i,
    );
    expect(insertBranch).toMatch(/then\s+return null;/i);
  });

  it("logs EVERY field that moved on a bet, not only status", () => {
    const setBet = sql.slice(sql.indexOf("create or replace function set_growth_plan_bet("));
    for (const field of ["'status'", "'rejected_reason'", "'priority'"]) {
      expect(setBet, `${field} must be logged`).toContain(field);
    }
    expect(setBet).toMatch(/p_rejected_reason is distinct from v_prev_reason/i);
    expect(setBet).toMatch(/p_priority is distinct from v_prev_priority/i);
  });

  it("runs as one transaction", () => {
    expect(sql).toMatch(/^\s*begin;/m);
    expect(sql.trimEnd()).toMatch(/commit;$/);
  });
});
