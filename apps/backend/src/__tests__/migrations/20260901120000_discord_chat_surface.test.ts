
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260901120000_discord_chat_surface.sql"),
  "utf-8",
);

const FUNCTIONS = [
  "set_discord_connection",
  "create_discord_link_token",
  "consume_discord_link_token",
  "claim_discord_gateway_lease",
  "release_discord_gateway_lease",
  "ingest_and_enqueue_work",
];

describe("20260901120000_discord_chat_surface.sql", () => {
  it("consumes the link token ATOMICALLY (delete ... returning, not select-then-delete)", () => {
    expect(sql).toMatch(
      /delete from discord_link_tokens\s+where token = p_token and expires_at > now\(\)\s+returning \* into v_row/i,
    );
    expect(sql).not.toMatch(/select \* into v_row\s+from discord_link_tokens/i);
  });

  it("takes the Zavi tenant from the TOKEN ROW, never from a gateway-supplied param", () => {
    expect(sql).toMatch(
      /create or replace function consume_discord_link_token\(\s*p_token text,\s*p_guild_id text/i,
    );
    expect(sql).toMatch(/set_discord_connection\(\s*v_row\.tenant_id/i);
  });

  it("refuses to re-bind a guild that is live under a DIFFERENT tenant", () => {
    expect(sql).toMatch(/v_existing_tenant is not null and v_existing_tenant <> v_row\.tenant_id/i);
    expect(sql).toMatch(/return 'guild_already_bound'/i);
  });

  it("refuses a SECOND guild for a tenant explicitly (never a silent swap)", () => {
    expect(sql).toMatch(/v_existing_guild is not null and v_existing_guild <> p_guild_id/i);
    expect(sql).toMatch(/return 'tenant_already_bound'/i);
  });

  it("guards cross-tenant guild routing with UNIQUE(guild_id)", () => {
    expect(sql).toMatch(/constraint discord_guilds_guild_unique unique \(guild_id\)/i);
  });

  it("records who bound the guild (Zavi minter + Discord poster)", () => {
    for (const col of ["bound_by_user_id", "bound_by_discord_user_id", "bound_by_discord_username"]) {
      expect(sql).toMatch(new RegExp(`^\\s*${col} `, "im"));
    }
  });

  it("gateway lease: one row, claim succeeds only when free/expired/ours, release is holder-scoped", () => {
    expect(sql).toMatch(/id int primary key check \(id = 1\)/i);
    expect(sql).toMatch(/where l\.holder = excluded\.holder or l\.expires_at < now\(\)/i);
    expect(sql).toMatch(/delete from discord_gateway_lease where id = 1 and holder = p_holder/i);
  });

  it("ingest_and_enqueue_work runs ingest_event + enqueue_work_item in ONE function body", () => {
    const body = sql.split("create or replace function ingest_and_enqueue_work(")[1] ?? "";
    expect(body).toMatch(/v_ingest_id := ingest_event\(/i);
    expect(body).toMatch(/v_work_id := enqueue_work_item\(/i);
    expect(body.indexOf("'duplicate', true")).toBeLessThan(body.indexOf("enqueue_work_item("));
  });

  it("pins search_path on every security-definer function and revokes public execute", () => {
    const fns = sql.match(/security definer set search_path = public, pg_temp/gi) ?? [];
    expect(fns.length).toBe(FUNCTIONS.length);
    for (const fn of FUNCTIONS) {
      expect(sql).toMatch(new RegExp(`revoke all on function ${fn}\\(`, "i"));
    }
  });

  it("enables RLS on all four new tables", () => {
    for (const t of [
      "discord_guilds",
      "discord_link_tokens",
      "discord_gateway_lease",
      "discord_reply_claims",
    ]) {
      expect(sql).toMatch(new RegExp(`alter table ${t} enable row level security`, "i"));
    }
  });

  it("admits trigger='discord' to BOTH closed CHECK constraints, additively", () => {
    const checks = sql.match(/check \(trigger in \([^)]*'discord'\)\)/gi) ?? [];
    expect(checks.length).toBe(2);
    for (const t of [
      "manual",
      "cron",
      "slack",
      "webhook",
      "a2a",
      "chat",
      "handoff",
      "mcp",
      "email",
      "teams",
      "playbook",
      "telegram",
    ]) {
      for (const c of checks) expect(c).toContain(`'${t}'`);
    }
  });
});
