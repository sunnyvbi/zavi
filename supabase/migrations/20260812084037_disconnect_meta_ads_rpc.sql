
begin;

create or replace function disconnect_meta_ads(
  p_tenant_id uuid
) returns void
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_actor      uuid := auth.uid();
  v_ad_account text;
  v_old        uuid;
  v_deleted    integer;
begin
  perform _assert_tenant_admin(p_tenant_id);

  select team_id
    into v_ad_account
    from connector_metadata
    where tenant_id = p_tenant_id and slug = 'meta_ads';

  select vault_secret_id into v_old
    from secrets where tenant_id = p_tenant_id and key = 'meta_ads.access_token';
  if v_old is not null then
    delete from vault.secrets where id = v_old;
    delete from secrets where tenant_id = p_tenant_id and key = 'meta_ads.access_token';
  end if;

  select vault_secret_id into v_old
    from secrets where tenant_id = p_tenant_id and key = 'meta_ads.ad_account_id';
  if v_old is not null then
    delete from vault.secrets where id = v_old;
    delete from secrets where tenant_id = p_tenant_id and key = 'meta_ads.ad_account_id';
  end if;

  delete from connector_metadata
    where tenant_id = p_tenant_id and slug = 'meta_ads';
  get diagnostics v_deleted = row_count;

  if v_deleted = 0 then
    return;
  end if;

  update tenant_mcp_servers
    set enabled = false
    where tenant_id = p_tenant_id and server_id = 'meta_ads';

  insert into tenant_config_audit
    (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
  values
    (p_tenant_id, v_actor, 'clear', 'meta_ads.connection', v_ad_account, null,
     jsonb_build_object('source', 'disconnect_meta_ads'));
end $$;

revoke all on function disconnect_meta_ads(uuid) from public;
grant execute on function disconnect_meta_ads(uuid) to authenticated;

commit;
