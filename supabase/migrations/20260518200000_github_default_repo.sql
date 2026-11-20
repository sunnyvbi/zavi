
begin;

alter table connector_metadata
  add column if not exists default_repo_full_name text;

alter table connector_metadata
  drop constraint if exists connector_metadata_default_repo_member_chk;
alter table connector_metadata
  add constraint connector_metadata_default_repo_member_chk
  check (
    default_repo_full_name is null
    or (
      slug = 'github'
      and repo_full_names is not null
      and default_repo_full_name = any(repo_full_names)
    )
  );

create index if not exists connector_metadata_default_repo_idx
  on connector_metadata (tenant_id, default_repo_full_name)
  where slug = 'github';

create table if not exists tenant_config_audit (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  actor_user_id   uuid not null,
  action          text not null check (length(action) between 1 and 64),
  target          text not null check (length(target) between 1 and 64),
  prev_value      text,
  next_value      text,
  meta            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists tenant_config_audit_tenant_idx
  on tenant_config_audit (tenant_id, created_at desc);
create index if not exists tenant_config_audit_actor_idx
  on tenant_config_audit (actor_user_id, created_at desc);

alter table tenant_config_audit enable row level security;

drop policy if exists tenant_config_audit_member_select on tenant_config_audit;
create policy tenant_config_audit_member_select
  on tenant_config_audit for select
  to authenticated
  using (
    exists (
      select 1 from tenant_users tu
      where tu.tenant_id = tenant_config_audit.tenant_id
        and tu.user_id   = auth.uid()
    )
  );

create or replace function set_github_default_repo(
  p_tenant_id        uuid,
  p_repo_full_name   text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_prev       text;
  v_updated    integer;
  v_actor      uuid := auth.uid();
begin
  perform _assert_tenant_admin(p_tenant_id);

  if p_repo_full_name is null or length(p_repo_full_name) = 0 then
    raise exception 'set_github_default_repo: repo_full_name required'
      using errcode = '22023';
  end if;

  select default_repo_full_name
    into v_prev
    from connector_metadata
    where tenant_id = p_tenant_id and slug = 'github';

  update connector_metadata
    set default_repo_full_name = p_repo_full_name
    where tenant_id = p_tenant_id
      and slug      = 'github'
      and repo_full_names is not null
      and p_repo_full_name = any(repo_full_names);

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'set_github_default_repo: repo_full_name not in connected repo_full_names (or github not connected)'
      using errcode = '23514';
  end if;

  insert into tenant_config_audit
    (tenant_id, actor_user_id, action, target, prev_value, next_value)
  values
    (p_tenant_id, v_actor, 'set', 'github.default_repo', v_prev, p_repo_full_name);
end $$;

revoke all on function set_github_default_repo(uuid, text) from public;
grant execute on function set_github_default_repo(uuid, text) to authenticated;

create or replace function clear_github_default_repo(
  p_tenant_id      uuid
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_updated    integer;
  v_actor      uuid := auth.uid();
begin
  perform _assert_tenant_admin(p_tenant_id);

  update connector_metadata
    set default_repo_full_name = null
    where tenant_id = p_tenant_id and slug = 'github';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return;
  end if;

  insert into tenant_config_audit
    (tenant_id, actor_user_id, action, target, prev_value, next_value)
  values
    (p_tenant_id, v_actor, 'clear', 'github.default_repo', null, null);
end $$;

revoke all on function clear_github_default_repo(uuid) from public;
grant execute on function clear_github_default_repo(uuid) to authenticated;

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
  v_current_default text;
begin
  if p_account_login = '' or p_account_type = '' then
    select account_login, account_type
      into v_existing_login, v_existing_type
      from connector_metadata
      where tenant_id = p_tenant_id and slug = 'github';
  end if;

  select default_repo_full_name
    into v_current_default
    from connector_metadata
    where tenant_id = p_tenant_id and slug = 'github';

  if v_current_default is not null
     and not (v_current_default = any(coalesce(p_repo_full_names, array[]::text[]))) then
    update connector_metadata
      set default_repo_full_name = null
      where tenant_id = p_tenant_id and slug = 'github';
    insert into tenant_config_audit
      (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
    values
      (p_tenant_id,
       '00000000-0000-0000-0000-000000000000'::uuid,
       'clear', 'github.default_repo', v_current_default, null,
       jsonb_build_object('source', 'set_github_connection_refresh',
                          'reason', 'repo_removed_from_connected_list'));
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

commit;
