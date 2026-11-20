import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260531161323_slack_multi_workspace.sql",
);
const sql = readFileSync(MIGRATION_PATH, "utf-8");

function stripComments(s: string): string {
  return s.replace(/--.*$/gm, "");
}
const exec = stripComments(sql);

function fnBody(rpc: string): string {
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${rpc}\\s*\\(`,
    "i",
  );
  const m = re.exec(exec);
  if (!m) return "";
  const tail = exec.slice(m.index);
  const end = /\$\$\s*;/.exec(tail);
  return end ? tail.slice(0, end.index + end[0].length) : tail;
}
const setSlackBody = fnBody("set_slack_connection");

describe("20260531161323_slack_multi_workspace.sql — static guards", () => {
  it("creates slack_workspaces with composite PK (tenant_id, team_id)", () => {
    expect(exec).toMatch(/create table slack_workspaces/i);
    expect(exec).toMatch(/primary key\s*\(\s*tenant_id\s*,\s*team_id\s*\)/i);
  });

  it("slack_workspaces has UNIQUE(team_id) — a workspace maps to AT MOST one tenant", () => {
    expect(exec).toMatch(/unique\s*\(\s*team_id\s*\)/i);
  });

  it("slack_workspaces has the check(length(team_id) > 0) guard", () => {
    expect(exec).toMatch(/check\s*\(\s*length\s*\(\s*team_id\s*\)\s*>\s*0\s*\)/i);
  });

  it("enforces exactly-one-primary via a partial unique index", () => {
    expect(exec).toMatch(
      /create unique index slack_workspaces_one_primary\s+on slack_workspaces\s*\(\s*tenant_id\s*\)\s+where is_primary/i,
    );
  });

  it("enables RLS + a member-of-tenant SELECT policy on slack_workspaces", () => {
    expect(exec).toMatch(/alter table slack_workspaces enable row level security/i);
    expect(exec).toMatch(
      /create policy slack_workspaces_member_select on slack_workspaces[\s\S]+?for select using/i,
    );
  });

  it("set_slack_connection keeps the 6-arg signature (no new params on the Vault path)", () => {
    expect(setSlackBody).toMatch(/p_bot_user_id text/i);
    expect(setSlackBody).toMatch(/p_tenant_id uuid/);
    expect(setSlackBody).toMatch(/p_team_id text/);
    expect(setSlackBody).toMatch(/p_scopes text\[\]/);
  });

  it("KEEPS the tenant_mcp_servers upsert (dropping it unregisters every Slack tool)", () => {
    expect(setSlackBody).toMatch(
      /insert into tenant_mcp_servers[\s\S]+?on conflict[\s\S]+?enabled\s*=\s*true/i,
    );
  });

  it("KEEPS revoke-from-public (does not widen who can call the Vault-write RPC)", () => {
    expect(exec).toMatch(
      /revoke all on function set_slack_connection\(uuid, text, text, text, text\[\], text\) from public/i,
    );
    expect(exec).not.toMatch(/grant execute on function set_slack_connection[^;]*to (authenticated|anon)/i);
  });

  it("DIFF (1): rotates the PER-TEAM key slack.bot_token:<team_id>, not the bare key", () => {
    expect(setSlackBody).toMatch(/'slack\.bot_token:'\s*\|\|\s*p_team_id/i);
    expect(setSlackBody).toMatch(/key\s*=\s*v_key/i);
  });

  it("DIFF (1): does NOT delete the bare 'slack.bot_token' key (no cross-team clobber)", () => {
    expect(setSlackBody).not.toMatch(/delete from secrets[\s\S]*key\s*=\s*'slack\.bot_token'(?!:)/i);
  });

  it("DIFF (2): upserts slack_workspaces on conflict (tenant_id, team_id) + computes is_primary", () => {
    expect(setSlackBody).toMatch(
      /insert into slack_workspaces[\s\S]+?on conflict\s*\(\s*tenant_id\s*,\s*team_id\s*\)/i,
    );
    expect(setSlackBody).toMatch(/set is_primary = false[\s\S]+?team_id <> p_team_id/i);
  });

  it("DIFF (3): writes the connector_metadata summary ONLY when primary", () => {
    expect(setSlackBody).toMatch(
      /if v_is_primary then[\s\S]+?insert into connector_metadata[\s\S]+?on conflict\s*\(\s*tenant_id\s*,\s*slug\s*\)/i,
    );
  });

  it("does NOT hand-roll the dead vault.delete_secret call (reconnect-500 bug class)", () => {
    expect(exec).not.toMatch(/vault\.delete_secret/i);
    expect(setSlackBody).toMatch(/delete from vault\.secrets where id\s*=/i);
  });

  it("adds team_id to slack_channels + slack_channel_members and swaps to composite PK", () => {
    expect(exec).toMatch(/alter table slack_channels\s+add column if not exists team_id text/i);
    expect(exec).toMatch(/alter table slack_channel_members\s+add column if not exists team_id text/i);
    expect(exec).toMatch(
      /alter table slack_channels\s+add\s+primary key\s*\(\s*tenant_id\s*,\s*team_id\s*,\s*channel_id\s*\)/i,
    );
    expect(exec).toMatch(
      /alter table slack_channel_members\s+add\s+primary key\s*\(\s*tenant_id\s*,\s*team_id\s*,\s*channel_id\s*,\s*slack_user_id\s*\)/i,
    );
  });

  it("widens team_member_identities unique to include team_id", () => {
    expect(exec).toMatch(/alter table team_member_identities add column if not exists team_id text/i);
    expect(exec).toMatch(
      /drop constraint team_member_identities_tenant_id_provider_external_id_key/i,
    );
    expect(exec).toMatch(
      /create unique index team_member_identities_tenant_provider_team_external_uniq[\s\S]+?provider[\s\S]+?team_id[\s\S]+?external_id/i,
    );
  });

  it("backfills slack_workspaces idempotently from the single connector row", () => {
    expect(exec).toMatch(
      /insert into slack_workspaces[\s\S]+?from connector_metadata cm[\s\S]+?where cm\.slug = 'slack'[\s\S]+?on conflict\s*\(\s*tenant_id\s*,\s*team_id\s*\)\s*do update/i,
    );
    expect(exec).toMatch(/>1 is_primary|>\s*1/i);
  });

  it("adds set_slack_workspace_meta as a service-role staff RPC (revoke from public)", () => {
    expect(exec).toMatch(/create or replace function set_slack_workspace_meta/i);
    expect(exec).toMatch(/revoke all on function set_slack_workspace_meta[^;]*from public/i);
    expect(exec).toMatch(/grant execute on function set_slack_workspace_meta[^;]*to service_role/i);
  });

  it("adds rotate_legacy_slack_keys as a service-role RPC that copies the vault pointer (no plaintext)", () => {
    expect(exec).toMatch(/create or replace function rotate_legacy_slack_keys/i);
    expect(exec).toMatch(/revoke all on function rotate_legacy_slack_keys[^;]*from public/i);
    expect(exec).toMatch(/grant execute on function rotate_legacy_slack_keys[^;]*to service_role/i);
    expect(exec).toMatch(/insert into secrets[\s\S]+?vault_secret_id[\s\S]+?on conflict[\s\S]+?do nothing/i);
    const rotateBody = fnBody("rotate_legacy_slack_keys");
    expect(rotateBody).not.toMatch(/vault\.create_secret/i);
  });
});
