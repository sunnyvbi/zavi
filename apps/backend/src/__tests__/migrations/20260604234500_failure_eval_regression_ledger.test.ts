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
const MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "20260604234500_failure_eval_regression_ledger.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");

describe(
  "failure-eval regression ledger migration",
  () => {
    it("creates both tables: global-identity + per-tenant occurrences", () => {
      expect(sql).toMatch(
        /create table if not exists regression_signatures\b/,
      );
      expect(sql).toMatch(
        /create table if not exists regression_signature_occurrences\b/,
      );
    });

    it("regression_signatures uses signature as PRIMARY KEY (global identity)", () => {
      expect(sql).toMatch(/signature\s+text\s+primary key/);
    });

    it("occurrences dedup on run_id UNIQUE (multi-event firing safe)", () => {
      expect(sql).toMatch(/run_id\s+uuid\s+not null\s+unique/);
      expect(sql).toMatch(/on conflict \(run_id\) do nothing/);
    });

    it("enables RLS on both tables", () => {
      expect(sql).toMatch(
        /alter table regression_signatures enable row level security/,
      );
      expect(sql).toMatch(
        /alter table regression_signature_occurrences enable row level security/,
      );
    });

    it("has NO authed-client policy on either table (RLS default-deny)", () => {
      expect(sql).not.toMatch(/create policy\s+\w+\s+on regression_signatures/);
      expect(sql).not.toMatch(
        /create policy\s+\w+\s+on regression_signature_occurrences/,
      );
    });

    it("both write RPCs are security-definer with pinned search_path", () => {
      const defs = sql.match(
        /language plpgsql security definer set search_path = public/g,
      );
      expect(defs).not.toBeNull();
      expect((defs ?? []).length).toBeGreaterThanOrEqual(2);
    });

    it("register_regression_signature re-derives tenant from agent_runs (C8), no caller tenant param", () => {
      const fn = sql.slice(
        sql.indexOf("function register_regression_signature"),
      );
      expect(fn).toMatch(/select tenant_id[\s\S]*from agent_runs where id = p_run_id/);
      const sigLine = sql.slice(
        sql.indexOf("function register_regression_signature"),
        sql.indexOf(") returns table"),
      );
      expect(sigLine).not.toMatch(/p_tenant/);
    });

    it("inline recurrence is EXACTLY-ONCE: conditional flip + row-count gate (no stale pre-read)", () => {
      expect(sql).toMatch(/set status = 'regressed'/);
      expect(sql).toMatch(/where signature = p_signature and status = 'armed'/);
      expect(sql).toMatch(/get diagnostics v_flipped = row_count/);
      expect(sql).toMatch(/v_recurrence\s*:=\s*\(v_flipped = 1\)/);
      expect(sql).not.toMatch(/if v_status = 'armed' then/);
    });

    it("arm_regression_signature only flips pending + writes praxis_logs audit", () => {
      const fn = sql.slice(sql.indexOf("function arm_regression_signature"));
      expect(fn).toMatch(/where signature = p_signature and status = 'pending'/);
      expect(fn).toMatch(/insert into praxis_logs/);
      expect(fn).toMatch(/regression_signature_armed/);
    });

    it("both RPCs revoke public + authenticated and grant service_role only", () => {
      for (const f of [
        "register_regression_signature",
        "arm_regression_signature",
      ]) {
        expect(sql).toMatch(
          new RegExp(`revoke all on function ${f}\\([^)]*\\) from public`),
        );
        expect(sql).toMatch(
          new RegExp(`revoke all on function ${f}\\([^)]*\\) from authenticated`),
        );
        expect(sql).toMatch(
          new RegExp(
            `grant execute on function ${f}\\([^)]*\\) to service_role`,
          ),
        );
      }
    });

    it("content-free: failure class is a code_class enum, no raw error/prompt/output column", () => {
      expect(sql).toMatch(/code_class\s+text\s+not null/);
      const tableBlocks = sql.slice(
        sql.indexOf("create table if not exists regression_signatures"),
        sql.indexOf("create or replace function register_regression_signature"),
      );
      expect(tableBlocks).not.toMatch(/\b(error_text|raw_error|prompt|output_text|slack_text)\b/);
    });
  },
);
