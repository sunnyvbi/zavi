import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260518190319_slack_mcp_server_upsert.sql",
);
const sql = readFileSync(MIGRATION_PATH, "utf-8");

describe("20260518190319_slack_mcp_server_upsert.sql — static guards", () => {
  it("replaces set_slack_connection with the 6-arg signature", () => {
    expect(sql).toMatch(/create or replace function set_slack_connection\s*\(/i);
    expect(sql).toContain("p_bot_user_id text");
  });

  it("new function body includes the tenant_mcp_servers upsert", () => {
    expect(sql).toMatch(
      /insert into tenant_mcp_servers[\s\S]+?on conflict[\s\S]+?enabled\s*=\s*true/i,
    );
  });

  it("upsert targets server_id='slack' specifically", () => {
    expect(sql).toMatch(/values\s*\([^)]*'slack'/);
  });

  it("backfill block guards against revoked tokens (joins secrets table)", () => {
    expect(sql).toMatch(/from connector_metadata[\s\S]+?where cm\.slug = 'slack'/i);
    expect(sql).toMatch(
      /exists\s*\(\s*select 1 from secrets[\s\S]+?key = 'slack\.bot_token'/i,
    );
  });

  it("backfill is idempotent (ON CONFLICT DO NOTHING)", () => {
    expect(sql).toMatch(/on conflict\s*\(\s*tenant_id\s*,\s*server_id\s*\)\s*do nothing/i);
  });

  it("does NOT touch vault.secrets or tokens outside the existing flow", () => {
    expect(sql).not.toMatch(/vault\.delete_secret/);
    expect(sql).not.toMatch(/drop.+secrets/);
    expect(sql).not.toMatch(/alter.+secrets/);
  });

  it("references the source-of-truth investigation plan", () => {
    expect(sql).toContain("2026-05-18-agent-quality-investigation.md");
  });
});
