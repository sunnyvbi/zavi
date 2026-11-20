import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_PATH = join(
  __dirname,
  "../../../../../supabase/migrations/20260926200000_connector_app_requests.sql",
);

describe("migration 20260926200000_connector_app_requests", () => {
  const sql = readFileSync(MIG_PATH, "utf8");

  it("creates the request table keyed once per tenant per app", () => {
    expect(sql).toMatch(/create table if not exists connector_app_requests/i);
    expect(sql).toMatch(/primary key \(tenant_id, app_slug\)/i);
    expect(sql).toMatch(/references tenants\(id\) on delete cascade/i);
  });

  it("is service-role only: RLS on, no policies, revoked from browser roles", () => {
    expect(sql).toMatch(/alter table connector_app_requests enable row level security/i);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).toMatch(/revoke all on (table )?connector_app_requests from public, anon, authenticated/i);
    expect(sql).toMatch(/grant all on (table )?connector_app_requests to service_role/i);
  });

  it("adds composio_auth_config_id to connector_metadata", () => {
    expect(sql).toMatch(/alter table connector_metadata add column if not exists composio_auth_config_id text/i);
  });

  it("set_composio_app_connection stores p_auth_config_id and stays a superset of the 20260521 body", () => {
    expect(sql).toMatch(/drop function if exists set_composio_app_connection\(uuid, text, text, text\)/i);
    expect(sql).toMatch(/p_auth_config_id text default null/i);
    expect(sql).toMatch(/insert into connector_metadata \(tenant_id, slug, team_id, connected_at, composio_auth_config_id\)/i);
    expect(sql).toMatch(/composio_auth_config_id = excluded\.composio_auth_config_id/i);
    expect(sql).toMatch(/raise exception 'set_composio_app_connection: all params required'/i);
    expect(sql).toMatch(/insert into tenant_mcp_servers \(tenant_id, server_id, transport, url, command, args\)/i);
    expect(sql).toMatch(/enabled\s+= true/i);
    expect(sql).toMatch(/security definer set search_path = public, pg_temp/i);
  });

  it("revokes the new signature from public, anon, authenticated and grants service_role only", () => {
    expect(sql).toMatch(/revoke all on function set_composio_app_connection\(uuid, text, text, text, text\) from public, anon, authenticated/i);
    expect(sql).toMatch(/grant execute on function set_composio_app_connection\(uuid, text, text, text, text\) to service_role/i);
  });
});
