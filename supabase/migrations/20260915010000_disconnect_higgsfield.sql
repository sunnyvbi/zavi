
begin;

create or replace function public.disconnect_higgsfield(
  p_tenant_id uuid
) returns void
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_actor        uuid := auth.uid();
  v_workspace_id text;
  v_old          uuid;
  v_deleted      integer;
begin
  perform _assert_tenant_admin(p_tenant_id);

  select team_id into v_workspace_id
    from public.connector_metadata
    where tenant_id = p_tenant_id and slug = 'higgsfield';

  select vault_secret_id into v_old
    from public.secrets
    where tenant_id = p_tenant_id and key = 'higgsfield.access_token';
  if v_old is not null then
    delete from vault.secrets where id = v_old;
    delete from public.secrets
      where tenant_id = p_tenant_id and key = 'higgsfield.access_token';
  end if;

  delete from public.connector_metadata
    where tenant_id = p_tenant_id and slug = 'higgsfield';
  get diagnostics v_deleted = row_count;

  if v_deleted = 0 then
    return;
  end if;

  update public.tenant_mcp_servers
    set enabled = false
    where tenant_id = p_tenant_id and server_id = 'higgsfield';

  insert into public.tenant_config_audit
    (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
  values
    (p_tenant_id, v_actor, 'clear', 'higgsfield.connection', v_workspace_id, null,
     jsonb_build_object('source', 'disconnect_higgsfield'));
end $$;

revoke all on function public.disconnect_higgsfield(uuid) from public;
grant execute on function public.disconnect_higgsfield(uuid) to authenticated;

commit;
