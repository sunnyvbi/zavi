import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(__dirname, "../../../../../supabase/migrations/20260628140000_resolve_slack_owner_dm.sql"),
  "utf-8",
);
const ddl = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("20260628140000_resolve_slack_owner_dm.sql", () => {
  it("creates resolve_slack_owner_dm(uuid) returning slack_user_id + team_id", () => {
    expect(ddl).toMatch(/create or replace function resolve_slack_owner_dm\(p_tenant_id uuid\)/i);
    expect(ddl).toMatch(/returns table\s*\(\s*slack_user_id text,\s*team_id text\s*\)/i);
  });
  it("resolves the OWNER (tenant_users.role='owner') via the email bridge to a slack identity", () => {
    expect(ddl).toMatch(/from tenant_users tu/i);
    expect(ddl).toMatch(/tu\.role = 'owner'/);
    expect(ddl).toMatch(/join auth\.users u on u\.id = tu\.user_id/i);
    expect(ddl).toMatch(/lower\(tm\.primary_email\) = lower\(u\.email\)/i);
    expect(ddl).toMatch(/tmi\.provider = 'slack'/);
    expect(ddl).toMatch(/tm\.status = 'active'/);
  });
  it("only returns a real slack id (non-null/non-empty) and is service_role-only", () => {
    expect(ddl).toMatch(/tmi\.external_id is not null/i);
    expect(ddl).toMatch(/security definer/i);
    expect(ddl).toMatch(/revoke all on function resolve_slack_owner_dm.* from public, authenticated, anon/i);
    expect(ddl).toMatch(/grant execute on function resolve_slack_owner_dm.* to service_role/i);
  });
});
