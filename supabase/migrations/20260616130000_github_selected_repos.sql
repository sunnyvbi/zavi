
begin;

alter table connector_metadata
  add column if not exists selected_repo_ids bigint[];

alter table connector_metadata
  drop constraint if exists connector_metadata_selected_repos_subset_chk;
alter table connector_metadata
  add constraint connector_metadata_selected_repos_subset_chk
  check (
    selected_repo_ids is null
    or (
      slug = 'github'
      and repo_ids is not null
      and selected_repo_ids <@ repo_ids
    )
  );

create or replace function set_github_selected_repos(
  p_tenant_id   uuid,
  p_repo_ids    bigint[]
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_prev        bigint[];
  v_repo_ids    bigint[];
  v_updated     integer;
  v_actor       uuid := auth.uid();
begin
  perform _assert_tenant_admin(p_tenant_id);

  if p_repo_ids is null then
    raise exception 'set_github_selected_repos: p_repo_ids required (use clear_github_selected_repos to unscope)'
      using errcode = '22023';
  end if;

  select selected_repo_ids, repo_ids
    into v_prev, v_repo_ids
    from connector_metadata
    where tenant_id = p_tenant_id and slug = 'github';

  if v_repo_ids is null then
    raise exception 'set_github_selected_repos: github not connected for tenant'
      using errcode = '23514';
  end if;

  if exists (
    select 1 from unnest(p_repo_ids) as sid where sid <> all(v_repo_ids)
  ) then
    raise exception 'set_github_selected_repos: one or more repo ids are not in the installation''s accessible repos'
      using errcode = '23514';
  end if;

  update connector_metadata
    set selected_repo_ids = p_repo_ids
    where tenant_id = p_tenant_id and slug = 'github';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'set_github_selected_repos: github not connected for tenant'
      using errcode = '23514';
  end if;

  insert into tenant_config_audit
    (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
  values
    (p_tenant_id, v_actor, 'set', 'github.selected_repos',
     case when v_prev is null then null else array_to_string(v_prev, ',') end,
     array_to_string(p_repo_ids, ','),
     jsonb_build_object('count', coalesce(array_length(p_repo_ids, 1), 0)));
end $$;

revoke all on function set_github_selected_repos(uuid, bigint[]) from public;
grant execute on function set_github_selected_repos(uuid, bigint[]) to authenticated;

create or replace function clear_github_selected_repos(
  p_tenant_id   uuid
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_prev     bigint[];
  v_updated  integer;
  v_actor    uuid := auth.uid();
begin
  perform _assert_tenant_admin(p_tenant_id);

  select selected_repo_ids
    into v_prev
    from connector_metadata
    where tenant_id = p_tenant_id and slug = 'github';

  update connector_metadata
    set selected_repo_ids = null
    where tenant_id = p_tenant_id and slug = 'github';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return;
  end if;

  insert into tenant_config_audit
    (tenant_id, actor_user_id, action, target, prev_value, next_value)
  values
    (p_tenant_id, v_actor, 'clear', 'github.selected_repos',
     case when v_prev is null then null else array_to_string(v_prev, ',') end,
     null);
end $$;

revoke all on function clear_github_selected_repos(uuid) from public;
grant execute on function clear_github_selected_repos(uuid) to authenticated;

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
  v_current_selected bigint[];
  v_pruned_selected  bigint[];
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

  select selected_repo_ids
    into v_current_selected
    from connector_metadata
    where tenant_id = p_tenant_id and slug = 'github';

  if v_current_selected is not null then
    select coalesce(array_agg(sid), array[]::bigint[])
      into v_pruned_selected
      from unnest(v_current_selected) as sid
      where sid = any(coalesce(p_repo_ids, array[]::bigint[]));

    if v_pruned_selected is distinct from v_current_selected then
      update connector_metadata
        set selected_repo_ids = v_pruned_selected
        where tenant_id = p_tenant_id and slug = 'github';
      insert into tenant_config_audit
        (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
      values
        (p_tenant_id,
         '00000000-0000-0000-0000-000000000000'::uuid,
         'set', 'github.selected_repos',
         array_to_string(v_current_selected, ','),
         array_to_string(v_pruned_selected, ','),
         jsonb_build_object('source', 'set_github_connection_refresh',
                            'reason', 'repos_removed_from_connected_list'));
    end if;
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
