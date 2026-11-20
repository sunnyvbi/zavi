
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260831120000_telegram_chat_surface.sql"),
  "utf-8",
);

describe("20260831120000_telegram_chat_surface.sql", () => {
  it("consumes the link token ATOMICALLY (delete ... returning, not select-then-delete)", () => {
    expect(sql).toMatch(
      /delete from telegram_link_tokens\s+where token = p_token and expires_at > now\(\)\s+returning \* into v_row/i,
    );
    expect(sql).not.toMatch(/select \* into v_row\s+from telegram_link_tokens/i);
  });

  it("checks token expiry in SQL, not only in the caller", () => {
    expect(sql).toMatch(/expires_at > now\(\)/i);
  });

  it("takes the Zavi tenant from the TOKEN ROW, never from a webhook-supplied param", () => {
    expect(sql).toMatch(
      /create or replace function consume_telegram_link_token\(\s*p_token text,\s*p_chat_id bigint/i,
    );
    expect(sql).toMatch(/set_telegram_connection\(\s*v_row\.tenant_id/i);
  });

  it("refuses to re-bind a chat that is live under a DIFFERENT tenant", () => {
    expect(sql).toMatch(/v_existing_tenant is not null and v_existing_tenant <> v_row\.tenant_id/i);
    expect(sql).toMatch(/return 'chat_already_bound'/i);
  });

  it("guards cross-tenant chat routing with UNIQUE(chat_id)", () => {
    expect(sql).toMatch(/constraint telegram_chats_chat_unique unique \(chat_id\)/i);
  });

  it("pins search_path on every security-definer function and revokes public execute", () => {
    const fns = sql.match(/security definer set search_path = public, pg_temp/gi) ?? [];
    expect(fns.length).toBe(3);
    for (const fn of [
      "set_telegram_connection",
      "create_telegram_link_token",
      "consume_telegram_link_token",
    ]) {
      expect(sql).toMatch(new RegExp(`revoke all on function ${fn}\\(`, "i"));
    }
  });

  it("enables RLS on all three new tables", () => {
    for (const t of ["telegram_chats", "telegram_link_tokens", "telegram_reply_claims"]) {
      expect(sql).toMatch(new RegExp(`alter table ${t} enable row level security`, "i"));
    }
  });

  it("admits trigger='telegram' to BOTH closed CHECK constraints, additively", () => {
    const checks = sql.match(/check \(trigger in \([^)]*'telegram'\)\)/gi) ?? [];
    expect(checks.length).toBe(2);
    for (const t of ["manual", "cron", "slack", "webhook", "a2a", "chat", "handoff", "mcp", "email", "teams", "playbook"]) {
      for (const c of checks) expect(c).toContain(`'${t}'`);
    }
  });
});
