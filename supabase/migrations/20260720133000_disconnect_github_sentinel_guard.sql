
begin;

create or replace function disconnect_github(
  p_tenant_id uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
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

  if v_login = 'Praxis-build' then
    raise exception 'github connection is build-managed and cannot be disconnected'
      using errcode = 'P0001';
  end if;

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

commit;
