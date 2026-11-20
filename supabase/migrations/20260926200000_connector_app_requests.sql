
begin;

create table if not exists connector_app_requests (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  app_slug     text not null check (app_slug ~ '^[a-z0-9_-]{1,64}$'),
  requested_by uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (tenant_id, app_slug)
);
alter table connector_app_requests enable row level security;
revoke all on table connector_app_requests from public, anon, authenticated;
grant all on table connector_app_requests to service_role;

alter table connector_metadata add column if not exists composio_auth_config_id text;

drop function if exists set_composio_app_connection(uuid, text, text, text);

create or replace function set_composio_app_connection(
  p_tenant_id uuid,
  p_toolkit text,
  p_connected_account_id text,
  p_url text,
  p_auth_config_id text default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_slug text := 'composio.' || lower(p_toolkit);
begin
  if p_tenant_id is null or p_toolkit is null or p_connected_account_id is null or p_url is null then
    raise exception 'set_composio_app_connection: all params required';
  end if;

  insert into connector_metadata (tenant_id, slug, team_id, connected_at, composio_auth_config_id)
  values (p_tenant_id, v_slug, p_connected_account_id, now(), p_auth_config_id)
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id,
                connected_at = excluded.connected_at,
                composio_auth_config_id = excluded.composio_auth_config_id;

  insert into tenant_mcp_servers (tenant_id, server_id, transport, url, command, args)
  values (p_tenant_id, 'composio', 'streamable-http'::mcp_transport, p_url, null, null)
  on conflict (tenant_id, server_id)
  do update set transport = excluded.transport,
                url       = excluded.url,
                command   = excluded.command,
                args      = excluded.args,
                enabled   = true;
end $$;

revoke all on function set_composio_app_connection(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function set_composio_app_connection(uuid, text, text, text, text) to service_role;

commit;
