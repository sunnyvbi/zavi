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
  "20260609002907_selfimprove_finalize_and_reap_leases.sql",
);

const sql = readFileSync(MIGRATION_PATH, "utf8");

const finalizeBody = sql.slice(
  sql.indexOf("function finalize_improvement_request"),
  sql.indexOf("function reap_stale_improvement_leases"),
);
const reaperBody = sql.slice(sql.indexOf("function reap_stale_improvement_leases"));

describe(
  "finalize + reaper migration",
  () => {
    it("finalize_improvement_request(bigint, text) exists, security-definer, pinned search_path", () => {
      expect(sql).toMatch(
        /create or replace function finalize_improvement_request\(\s*p_request_id bigint,\s*p_status\s+text/,
      );
      expect(finalizeBody).toMatch(
        /language plpgsql security definer set search_path = public/,
      );
    });

    it("finalize validates the terminal-status enum (surfaced/done/skipped) and rejects others", () => {
      expect(finalizeBody).toMatch(
        /not in \('surfaced',\s*'done',\s*'skipped'\)/,
      );
      expect(finalizeBody).toMatch(/raise exception/);
      expect(finalizeBody).not.toMatch(/in \([^)]*'pending'[^)]*\)/);
    });

    it("finalize is no-clobber: only a row with status = 'leased' is transitioned", () => {
      expect(finalizeBody).toMatch(/where id = p_request_id/);
      expect(finalizeBody).toMatch(/and status = 'leased'/);
    });

    it("reaper(int default 120) exists, security-definer, pinned search_path", () => {
      expect(sql).toMatch(
        /create or replace function reap_stale_improvement_leases\(\s*p_ttl_minutes int default 120/,
      );
      expect(reaperBody).toMatch(
        /language plpgsql security definer set search_path = public/,
      );
    });

    it("reaper only re-queues LEASED rows older than the TTL (never a fresh lease)", () => {
      expect(reaperBody).toMatch(/set status\s+= 'pending'/);
      expect(reaperBody).toMatch(/where status = 'leased'/);
      expect(reaperBody).toMatch(/leased_at < now\(\) - make_interval/);
      expect(reaperBody).toMatch(/greatest\(coalesce\(p_ttl_minutes, 120\), 1\)/);
      expect(reaperBody).toMatch(/leased_at\s+= null/);
      expect(reaperBody).toMatch(/leased_by\s+= null/);
    });

    it("both RPCs revoke public + authenticated and grant service_role only", () => {
      for (const fn of [
        "finalize_improvement_request\\(bigint, text\\)",
        "reap_stale_improvement_leases\\(int\\)",
      ]) {
        expect(sql).toMatch(new RegExp(`revoke all on function ${fn} from public`));
        expect(sql).toMatch(
          new RegExp(`revoke all on function ${fn} from authenticated`),
        );
        expect(sql).toMatch(
          new RegExp(`grant execute on function ${fn} to service_role`),
        );
        expect(sql).not.toMatch(
          new RegExp(`grant execute on function ${fn} to authenticated`),
        );
      }
    });

    it("content-free: no raw prompt/output/diff column touched", () => {
      const code = sql
        .split("\n")
        .map((line) => line.replace(/--.*$/, ""))
        .join("\n");
      expect(code).not.toMatch(
        /\b(prompt|output_text|raw_output|diff|patch|error_text|slack_text|body_markdown|content)\b/,
      );
    });
  },
);
