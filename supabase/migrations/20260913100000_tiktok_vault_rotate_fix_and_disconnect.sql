
begin;

create or replace function public.set_tiktok_connection(
  p_tenant_id uuid, p_access_token text, p_refresh_token text, p_open_id text,
  p_scopes text[], p_expires_at timestamptz
) returns void language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare k record; old_id uuid; new_id uuid;
begin
  for k in select * from (values ('tiktok.access_token',p_access_token),('tiktok.refresh_token',p_refresh_token)) x(key,value) loop
    select vault_secret_id into old_id from secrets where tenant_id=p_tenant_id and key=k.key;
    if old_id is not null then delete from vault.secrets where id=old_id; delete from secrets where tenant_id=p_tenant_id and key=k.key; end if;
    new_id := vault.create_secret(k.value);
    insert into secrets(tenant_id,key,vault_secret_id) values(p_tenant_id,k.key,new_id);
  end loop;
  insert into connector_metadata(tenant_id,slug,team_id,team_name,scopes,connected_at,token_expires_at)
  values(p_tenant_id,'tiktok',p_open_id,'TikTok',p_scopes,now(),p_expires_at)
  on conflict(tenant_id,slug) do update set team_id=excluded.team_id,scopes=excluded.scopes,connected_at=excluded.connected_at,token_expires_at=excluded.token_expires_at;
  insert into tenant_mcp_servers(tenant_id,server_id,transport,enabled) values(p_tenant_id,'tiktok','internal',true)
  on conflict(tenant_id,server_id) do update set transport='internal',enabled=true;
end $$;
revoke all on function public.set_tiktok_connection(uuid,text,text,text,text[],timestamptz) from public;
grant execute on function public.set_tiktok_connection(uuid,text,text,text,text[],timestamptz) to service_role;

create or replace function public.refresh_tiktok_connection(p_tenant_id uuid,p_access_token text,p_refresh_token text,p_expires_at timestamptz)
returns void language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare k record; old_id uuid; new_id uuid;
begin
  for k in select * from (values ('tiktok.access_token',p_access_token),('tiktok.refresh_token',p_refresh_token)) x(key,value) loop
    select vault_secret_id into old_id from secrets where tenant_id=p_tenant_id and key=k.key;
    if old_id is not null then delete from vault.secrets where id=old_id; delete from secrets where tenant_id=p_tenant_id and key=k.key; end if;
    new_id := vault.create_secret(k.value); insert into secrets(tenant_id,key,vault_secret_id) values(p_tenant_id,k.key,new_id);
  end loop;
  update connector_metadata set token_expires_at=p_expires_at where tenant_id=p_tenant_id and slug='tiktok';
end $$;
revoke all on function public.refresh_tiktok_connection(uuid,text,text,timestamptz) from public;
grant execute on function public.refresh_tiktok_connection(uuid,text,text,timestamptz) to service_role;

create or replace function public.disconnect_tiktok(
  p_tenant_id uuid
) returns void
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_actor   uuid := auth.uid();
  v_open_id text;
  v_old     uuid;
  v_key     text;
  v_deleted integer;
begin
  perform _assert_tenant_admin(p_tenant_id);

  select team_id into v_open_id
    from connector_metadata
    where tenant_id = p_tenant_id and slug = 'tiktok';

  foreach v_key in array array['tiktok.access_token', 'tiktok.refresh_token'] loop
    select vault_secret_id into v_old
      from secrets where tenant_id = p_tenant_id and key = v_key;
    if v_old is not null then
      delete from vault.secrets where id = v_old;
      delete from secrets where tenant_id = p_tenant_id and key = v_key;
    end if;
  end loop;

  delete from connector_metadata
    where tenant_id = p_tenant_id and slug = 'tiktok';
  get diagnostics v_deleted = row_count;

  if v_deleted = 0 then
    return;
  end if;

  update tenant_mcp_servers
    set enabled = false
    where tenant_id = p_tenant_id and server_id = 'tiktok';

  insert into tenant_config_audit
    (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
  values
    (p_tenant_id, v_actor, 'clear', 'tiktok.connection', v_open_id, null,
     jsonb_build_object('source', 'disconnect_tiktok'));
end $$;

revoke all on function public.disconnect_tiktok(uuid) from public;
grant execute on function public.disconnect_tiktok(uuid) to authenticated;

commit;
