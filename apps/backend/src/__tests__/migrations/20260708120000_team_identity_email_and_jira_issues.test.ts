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
  /^\d{14}_team_identity_email_and_jira_issues\.sql$/.test(f),
);
if (!file) {
  throw new Error(
    "team_identity_email_and_jira_issues migration not found — expected 14-digit timestamp prefix file",
  );
}
const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");

describe("team_identity_email_and_jira_issues migration", () => {
  it("adds nullable recent_issue_keys text[] to team_member_identities (idempotent)", () => {
    expect(sql).toMatch(/alter table team_member_identities/i);
    expect(sql).toMatch(/add column if not exists recent_issue_keys text\[\]/i);
  });

  it("adds nullable avatar_url text to team_member_identities (idempotent)", () => {
    expect(sql).toMatch(/add column if not exists avatar_url text/i);
  });

  it("rebuilds list_team_members as security-definer with pinned search_path", () => {
    expect(sql).toMatch(
      /create or replace function list_team_members[\s\S]{0,400}security definer set search_path = public/,
    );
  });

  it("list_team_members still enforces tenant_users membership", () => {
    const fnBody = sql
      .split(/create or replace function list_team_members/i)[1] ?? "";
    expect(fnBody).toMatch(/select 1 from tenant_users/i);
    expect(fnBody).toMatch(/user_id = auth\.uid\(\)/);
  });

  it("external_email is admin-gated (owner/admin only, else NULL)", () => {
    const fnBody = sql
      .split(/create or replace function list_team_members/i)[1] ?? "";
    expect(fnBody).toMatch(/role in \('owner','admin'\)/);
    expect(fnBody).toMatch(
      /'external_email',\s*case when v_is_admin then i\.external_email else null end/,
    );
  });

  it("surfaces recent_issue_keys in the identity jsonb", () => {
    const fnBody = sql
      .split(/create or replace function list_team_members/i)[1] ?? "";
    expect(fnBody).toMatch(/'recent_issue_keys',\s*i\.recent_issue_keys/);
  });

  it("surfaces avatar_url in the identity jsonb", () => {
    const fnBody = sql
      .split(/create or replace function list_team_members/i)[1] ?? "";
    expect(fnBody).toMatch(/'avatar_url',\s*i\.avatar_url/);
  });

  it("re-asserts the authenticated grant (revoke public + grant authenticated)", () => {
    expect(sql).toMatch(/revoke all on function list_team_members\(\) from public/);
    expect(sql).toMatch(
      /grant execute on function list_team_members\(\) to authenticated/,
    );
  });
});
