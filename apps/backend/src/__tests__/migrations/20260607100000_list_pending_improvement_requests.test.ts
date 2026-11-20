import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "supabase",
  "migrations",
  "20260607100000_list_pending_improvement_requests.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");

describe(
  "list_pending_improvement_requests migration",
  () => {
    it("creates the RPC with p_limit int default 20", () => {
      expect(sql).toMatch(
        /create or replace function list_pending_improvement_requests\(/,
      );
      expect(sql).toMatch(/p_limit\s+int\s+default 20/);
    });

    it("is security-definer with pinned search_path", () => {
      expect(sql).toMatch(
        /language plpgsql security definer set search_path = public/,
      );
    });

    it("is content-free (C14): explicit RETURNS TABLE columns, never select *", () => {
      const body = sql
        .slice(sql.indexOf("function list_pending_improvement_requests"))
        .split("\n")
        .map((line) => line.replace(/--.*$/, ""))
        .join("\n");
      expect(body).not.toMatch(/select\s+\*/i);
      expect(sql).toMatch(/returns table \(/);
      for (const col of [
        "id",
        "tenant_id",
        "agent_slug",
        "cluster_signature",
        "run_ids",
        "digest_reason",
        "window",
      ]) {
        expect(sql).toMatch(new RegExp(`\\b${col}\\b`));
      }
      expect(body).not.toMatch(
        /\b(prompt|output_text|raw_output|diff|patch|error_text|raw_error|slack_text|body_markdown|content)\b/,
      );
    });

    it("reads only pending rows, oldest-first", () => {
      const body = sql.slice(
        sql.indexOf("function list_pending_improvement_requests"),
      );
      expect(body).toMatch(/where air\.status = 'pending'/);
      expect(body).toMatch(/order by air\.created_at asc/);
    });

    it("leases claimed rows under FOR UPDATE SKIP LOCKED (concurrent-safe)", () => {
      const body = sql.slice(
        sql.indexOf("function list_pending_improvement_requests"),
      );
      expect(body).toMatch(/for update skip locked/);
      expect(body).toMatch(/set status\s+= 'leased'/);
    });

    it("revokes public + authenticated and grants service_role only", () => {
      expect(sql).toMatch(
        /revoke all on function list_pending_improvement_requests\([^)]*\) from public/,
      );
      expect(sql).toMatch(
        /revoke all on function list_pending_improvement_requests\([^)]*\) from authenticated/,
      );
      expect(sql).toMatch(
        /grant execute on function list_pending_improvement_requests\([^)]*\) to service_role/,
      );
      expect(sql).not.toMatch(
        /grant execute on function list_pending_improvement_requests\([^)]*\) to authenticated/,
      );
    });
  },
);
