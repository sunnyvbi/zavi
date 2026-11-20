
create type mcp_transport as enum ('internal', 'streamable-http', 'stdio');

create table tenant_mcp_servers (
  tenant_id uuid not null references tenants(id) on delete cascade,
  server_id text not null,
  transport mcp_transport not null,
  url text,
  command text,
  args text[],
  enabled boolean not null default true,
  created_at timestamptz default now(),
  primary key (tenant_id, server_id)
);

alter table tenant_mcp_servers enable row level security;

create policy tenant_mcp_servers_member_select on tenant_mcp_servers
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = tenant_mcp_servers.tenant_id
    )
  );

create or replace function enable_mcp_server(
  p_tenant_id uuid,
  p_server_id text,
  p_transport mcp_transport,
  p_url text,
  p_command text,
  p_args text[]
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
  end if;
  insert into tenant_mcp_servers (
    tenant_id, server_id, transport, url, command, args
  ) values (
    p_tenant_id, p_server_id, p_transport, p_url, p_command, p_args
  )
  on conflict (tenant_id, server_id)
  do update set
    transport = excluded.transport,
    url = excluded.url,
    command = excluded.command,
    args = excluded.args,
    enabled = true;
end $$;
revoke all on function enable_mcp_server(uuid, text, mcp_transport, text, text, text[]) from public;
grant execute on function enable_mcp_server(uuid, text, mcp_transport, text, text, text[]) to authenticated;
