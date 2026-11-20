
alter table connector_metadata
  add column if not exists installation_id  bigint,
  add column if not exists account_login    text,
  add column if not exists account_type     text,
  add column if not exists repo_ids         bigint[],
  add column if not exists repo_full_names  text[];

create or replace function set_github_connection(
  p_tenant_id          uuid,
  p_installation_id    bigint,
  p_account_login      text,
  p_account_type       text,
  p_repo_ids           bigint[],
  p_repo_full_names    text[],
  p_scopes             text[]
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_existing_login text;
  v_existing_type  text;
begin
  if p_account_login = '' or p_account_type = '' then
    select account_login, account_type
      into v_existing_login, v_existing_type
      from connector_metadata
      where tenant_id = p_tenant_id and slug = 'github';
  end if;

  insert into connector_metadata (
    tenant_id, slug, installation_id, account_login, account_type,
    repo_ids, repo_full_names, scopes, connected_at
  )
  values (
    p_tenant_id, 'github', p_installation_id,
    coalesce(nullif(p_account_login, ''), v_existing_login, ''),
    coalesce(nullif(p_account_type,  ''), v_existing_type,  ''),
    p_repo_ids, p_repo_full_names, p_scopes, now()
  )
  on conflict (tenant_id, slug) do update set
    installation_id  = excluded.installation_id,
    account_login    = coalesce(nullif(excluded.account_login, ''), connector_metadata.account_login),
    account_type     = coalesce(nullif(excluded.account_type,  ''), connector_metadata.account_type),
    repo_ids         = excluded.repo_ids,
    repo_full_names  = excluded.repo_full_names,
    scopes           = excluded.scopes,
    connected_at     = excluded.connected_at;

  insert into tenant_mcp_servers (tenant_id, server_id, transport, enabled)
  values (p_tenant_id, 'github', 'internal', true)
  on conflict (tenant_id, server_id) do update set
    transport = excluded.transport,
    enabled   = true;
end $$;

revoke all on function set_github_connection(uuid, bigint, text, text, bigint[], text[], text[]) from public;

create or replace function revoke_github_connection(
  p_tenant_id uuid
) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from connector_metadata
    where tenant_id = p_tenant_id and slug = 'github';

  update tenant_mcp_servers
    set enabled = false
    where tenant_id = p_tenant_id and server_id = 'github';
end $$;

revoke all on function revoke_github_connection(uuid) from public;
