import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
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

const file = readdirSync(MIGRATIONS_DIR).find((f) =>
  /^\d{14}_update_tenant_notification_settings\.sql$/.test(f),
);

if (!file) {
  throw new Error(
    "update_tenant_notification_settings migration not found — expected a 14-digit timestamp prefix file",
  );
}

const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");

describe("update_tenant_notification_settings migration", () => {
  describe("update RPC", () => {
    it("declares the function with the expected 3-arg signature", () => {
      expect(sql).toMatch(
        /create or replace function update_tenant_notification_settings\s*\(\s*p_notification_email text,\s*p_timezone text,\s*p_digest_frequency text\s*\)/,
      );
    });

    it("is security-definer with pinned search_path", () => {
      expect(sql).toMatch(
        /create or replace function update_tenant_notification_settings[\s\S]{0,400}security definer set search_path = public/,
      );
    });

    it("re-derives active_tenant_id from auth.uid()", () => {
      const fnBody =
        sql
          .split(/create or replace function update_tenant_notification_settings/i)[1]
          ?.split(/create or replace function/i)[0] ?? "";
      expect(fnBody).toMatch(/select active_tenant_id into v_tenant from profiles where user_id = auth\.uid\(\)/);
    });

    it("re-validates tenant_users membership (defense vs stale active_tenant)", () => {
      const fnBody =
        sql
          .split(/create or replace function update_tenant_notification_settings/i)[1]
          ?.split(/create or replace function/i)[0] ?? "";
      expect(fnBody).toMatch(/select 1 from tenant_users/);
      expect(fnBody).toMatch(/tenant_id = v_tenant and user_id = auth\.uid\(\)/);
    });

    it("rejects digest_frequency values outside off|daily", () => {
      expect(sql).toMatch(/p_digest_frequency not in \('off', 'daily'\)/);
      expect(sql).toMatch(/invalid digest_frequency/);
    });

    it("does NOT accept 'weekly' v1 — must match column CHECK constraint", () => {
      const fnBody =
        sql
          .split(/create or replace function update_tenant_notification_settings/i)[1]
          ?.split(/create or replace function/i)[0] ?? "";
      expect(fnBody).not.toMatch(/'weekly'/);
    });

    it("validates timezone against pg_timezone_names (rejects garbage IANA strings at save time)", () => {
      expect(sql).toMatch(/pg_timezone_names where name = p_timezone/);
      expect(sql).toMatch(/invalid timezone/);
    });

    it("treats empty notification_email as NULL (clears the digest recipient)", () => {
      expect(sql).toMatch(/nullif\(trim\(p_notification_email\), ''\)/);
    });

    it("does NOT update phone or sms_enabled — those land with Slice 5", () => {
      const fnBody =
        sql
          .split(/create or replace function update_tenant_notification_settings/i)[1]
          ?.split(/create or replace function/i)[0] ?? "";
      expect(fnBody).not.toMatch(/notification_phone/);
      expect(fnBody).not.toMatch(/sms_enabled/);
    });
  });

  describe("get RPC", () => {
    it("declares the read function", () => {
      expect(sql).toMatch(
        /create or replace function get_tenant_notification_settings\(\)\s*returns table/,
      );
    });

    it("returns notification_email + timezone + digest_frequency + last_sent_at", () => {
      const fnBody =
        sql
          .split(/create or replace function get_tenant_notification_settings/i)[1]
          ?.split(/create or replace function/i)[0] ?? "";
      expect(fnBody).toMatch(/notification_email text/);
      expect(fnBody).toMatch(/timezone text/);
      expect(fnBody).toMatch(/digest_frequency text/);
      expect(fnBody).toMatch(/last_sent_at timestamptz/);
    });

    it("reads last_sent_at from tenant_brief_dispatches outcome=sent only", () => {
      const fnBody =
        sql
          .split(/create or replace function get_tenant_notification_settings/i)[1]
          ?.split(/create or replace function/i)[0] ?? "";
      expect(fnBody).toMatch(/from tenant_brief_dispatches/);
      expect(fnBody).toMatch(/outcome = 'sent'/);
    });

    it("is security-definer with explicit auth gate", () => {
      expect(sql).toMatch(
        /create or replace function get_tenant_notification_settings[\s\S]{0,400}security definer set search_path = public/,
      );
      const fnBody =
        sql
          .split(/create or replace function get_tenant_notification_settings/i)[1]
          ?.split(/create or replace function/i)[0] ?? "";
      expect(fnBody).toMatch(/select 1 from tenant_users/);
    });
  });

  describe("grants (matches tenant_commands pattern)", () => {
    it("revokes public + grants authenticated on both RPCs", () => {
      expect(sql).toMatch(
        /revoke all on function update_tenant_notification_settings\(text, text, text\) from public/,
      );
      expect(sql).toMatch(
        /grant execute on function update_tenant_notification_settings\(text, text, text\) to authenticated/,
      );
      expect(sql).toMatch(
        /revoke all on function get_tenant_notification_settings\(\) from public/,
      );
      expect(sql).toMatch(
        /grant execute on function get_tenant_notification_settings\(\) to authenticated/,
      );
    });
  });
});
