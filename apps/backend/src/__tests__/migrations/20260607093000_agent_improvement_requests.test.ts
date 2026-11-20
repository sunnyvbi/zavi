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
  "20260607093000_agent_improvement_requests.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");

describe(
  "agent_improvement_requests migration",
  () => {
    it("creates the table with a tenant_id column", () => {
      expect(sql).toMatch(
        /create table if not exists agent_improvement_requests\b/,
      );
      expect(sql).toMatch(/tenant_id\s+uuid\s+not null/);
    });

    it("is content-free (C14): no raw prompt/output/diff/error column", () => {
      const tableBlock = sql
        .slice(
          sql.indexOf("create table if not exists agent_improvement_requests"),
          sql.indexOf("create index"),
        )
        .split("\n")
        .map((line) => line.replace(/--.*$/, ""))
        .join("\n");
      expect(tableBlock).not.toMatch(
        /\b(prompt|output_text|raw_output|diff|patch|error_text|raw_error|slack_text|body_markdown|content)\b/,
      );
      expect(sql).toMatch(/digest_reason\s+text\s+not null/);
    });

    it("idempotency: UNIQUE (tenant_id, agent_slug, cluster_signature, window)", () => {
      expect(sql).toMatch(
        /unique \(tenant_id, agent_slug, cluster_signature, "?window"?\)/,
      );
    });

    it("status is ENUM-constrained with default 'pending'", () => {
      expect(sql).toMatch(/status\s+text\s+not null\s+default 'pending'/);
      expect(sql).toMatch(
        /check \(status in \('pending', 'leased', 'done', 'surfaced', 'skipped'\)\)/,
      );
    });

    it("enables RLS and has NO authed-client policy (default-deny)", () => {
      expect(sql).toMatch(
        /alter table agent_improvement_requests enable row level security/,
      );
      expect(sql).not.toMatch(
        /create policy\s+\w+\s+on agent_improvement_requests/,
      );
    });

    it("create_improvement_request is security-definer with pinned search_path", () => {
      expect(sql).toMatch(
        /language plpgsql security definer set search_path = public/,
      );
    });

    it("C8: re-derives tenant from agent_runs per run_id and rejects a foreign tenant (42501)", () => {
      const fn = sql.slice(
        sql.indexOf("function create_improvement_request"),
      );
      expect(fn).toMatch(/foreach v_run_id in array p_run_ids loop/);
      expect(fn).toMatch(
        /select tenant_id into v_run_tenant from agent_runs where id = v_run_id/,
      );
      expect(fn).toMatch(/v_run_tenant <> p_tenant_id/);
      expect(fn).toMatch(/using errcode = '42501'/);
    });

    it("idempotent insert (on conflict do nothing) returns inserted:false on replay", () => {
      expect(sql).toMatch(
        /on conflict \(tenant_id, agent_slug, cluster_signature, "?window"?\) do nothing/,
      );
      expect(sql).toMatch(/return query select v_request_id, \(v_inserted = 1\)/);
    });

    it("RPC revokes public + authenticated and grants service_role only", () => {
      expect(sql).toMatch(
        /revoke all on function create_improvement_request\([^)]*\) from public/,
      );
      expect(sql).toMatch(
        /revoke all on function create_improvement_request\([^)]*\) from authenticated/,
      );
      expect(sql).toMatch(
        /grant execute on function create_improvement_request\([^)]*\) to service_role/,
      );
    });
  },
);
