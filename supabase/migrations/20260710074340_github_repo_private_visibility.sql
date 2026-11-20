
begin;

alter table connector_metadata
  add column if not exists repo_private boolean[];

create or replace function set_github_connection(
  p_tenant_id          uuid,
  p_installation_id    bigint,
  p_account_login      text,
  p_account_type       text,
  p_repo_ids           bigint[],
  p_repo_full_names    text[],
  p_scopes             text[],
  p_repo_private       boolean[] default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
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
    repo_ids, repo_full_names, repo_private, scopes, connected_at
  )
  values (
    p_tenant_id, 'github', p_installation_id,
    coalesce(nullif(p_account_login, ''), v_existing_login, ''),
    coalesce(nullif(p_account_type,  ''), v_existing_type,  ''),
    p_repo_ids, p_repo_full_names, p_repo_private, p_scopes, now()
  )
  on conflict (tenant_id, slug) do update set
    installation_id  = excluded.installation_id,
    account_login    = coalesce(nullif(excluded.account_login, ''), connector_metadata.account_login),
    account_type     = coalesce(nullif(excluded.account_type,  ''), connector_metadata.account_type),
    repo_ids         = excluded.repo_ids,
    repo_full_names  = excluded.repo_full_names,
    repo_private     = excluded.repo_private,
    scopes           = excluded.scopes,
    connected_at     = excluded.connected_at;

  insert into tenant_mcp_servers (tenant_id, server_id, transport, enabled)
  values (p_tenant_id, 'github', 'internal', true)
  on conflict (tenant_id, server_id) do update set
    transport = excluded.transport,
    enabled   = true;
end $$;

create or replace function disconnect_github(
  p_tenant_id uuid
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_actor   uuid := auth.uid();
  v_login   text;
  v_deleted integer;
begin
  perform _assert_tenant_admin(p_tenant_id);

  select account_login
    into v_login
    from connector_metadata
    where tenant_id = p_tenant_id and slug = 'github';

  delete from connector_metadata
    where tenant_id = p_tenant_id and slug = 'github';
  get diagnostics v_deleted = row_count;

  if v_deleted = 0 then
    return;
  end if;

  update tenant_mcp_servers
    set enabled = false
    where tenant_id = p_tenant_id and server_id = 'github';

  insert into tenant_config_audit
    (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
  values
    (p_tenant_id, v_actor, 'clear', 'github.connection', v_login, null,
     jsonb_build_object('source', 'disconnect_github'));
end $$;

revoke all on function disconnect_github(uuid) from public;
grant execute on function disconnect_github(uuid) to authenticated;

revoke execute on function set_github_connection(uuid, bigint, text, text, bigint[], text[], text[], boolean[]) from public, anon, authenticated;
grant  execute on function set_github_connection(uuid, bigint, text, text, bigint[], text[], text[], boolean[]) to service_role;

revoke execute on function set_github_connection(uuid, bigint, text, text, bigint[], text[], text[]) from public, anon, authenticated;
grant  execute on function set_github_connection(uuid, bigint, text, text, bigint[], text[], text[]) to service_role;

commit;
