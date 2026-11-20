import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "supabase",
  "migrations",
);
const MIGRATION_PATH = join(MIGRATIONS_DIR, "20260605211530_admin_run_review.sql");

const sql = readFileSync(MIGRATION_PATH, "utf8");

describe("admin_run_review migration", () => {
  it("creates the table with NOT NULL tenant_id + agent_slug", () => {
    expect(sql).toMatch(/create table if not exists agent_run_review/);
    expect(sql).toMatch(/tenant_id\s+uuid\s+not null/);
    expect(sql).toMatch(/agent_slug\s+text\s+not null/);
  });

  it("constrains verdict to the three allowed values", () => {
    expect(sql).toMatch(
      /check \(verdict in \('score_correct', 'score_wrong', 'bug'\)\)/,
    );
  });

  it("one verdict per (run, staff) via UNIQUE", () => {
    expect(sql).toMatch(/unique \(run_id, staff_user_id\)/);
  });

  it("enables RLS with NO authed-client policy (default-deny)", () => {
    expect(sql).toMatch(/alter table agent_run_review enable row level security/);
    expect(sql).not.toMatch(/create policy/i);
  });

  it("record_agent_run_review is security-definer with pinned search_path", () => {
    expect(sql).toMatch(
      /create or replace function record_agent_run_review[\s\S]*?security definer set search_path = public/,
    );
  });

  it("re-derives tenant + slug FROM agent_runs by run_id (C8), no caller tenant param", () => {
    const fnStart = sql.indexOf("function record_agent_run_review(");
    const fnSig = sql.slice(fnStart, sql.indexOf(")", fnStart));
    expect(fnSig).not.toMatch(/p_tenant_id/);
    expect(sql).toMatch(
      /select tenant_id, agent_slug, quality_score, quality_model\s+into[\s\S]*?from agent_runs where id = p_run_id/,
    );
  });

  it("upsert is idempotent / mind-changeable on (run_id, staff_user_id)", () => {
    expect(sql).toMatch(/on conflict \(run_id, staff_user_id\) do update/);
  });

  it("both RPCs grant service_role only (revoke public + authenticated)", () => {
    expect(sql).toMatch(
      /revoke all on function record_agent_run_review[\s\S]*?from public/,
    );
    expect(sql).toMatch(
      /revoke all on function record_agent_run_review[\s\S]*?from authenticated/,
    );
    expect(sql).toMatch(
      /grant execute on function record_agent_run_review[\s\S]*?to service_role/,
    );
    expect(sql).toMatch(
      /grant execute on function list_judge_calibration[\s\S]*?to service_role/,
    );
  });

  it("stores no run output / prompt column (content-free)", () => {
    expect(sql).not.toMatch(/output_text/);
    expect(sql).not.toMatch(/\bprompt\b/);
  });

  it("list_judge_calibration only aggregates score verdicts, never 'bug'", () => {
    expect(sql).toMatch(/create or replace function list_judge_calibration/);
    expect(sql).toMatch(
      /where verdict in \('score_correct', 'score_wrong'\)/,
    );
  });
});
