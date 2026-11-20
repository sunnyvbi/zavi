begin;

create or replace function public.disconnect_connector(
  p_tenant_id uuid,
  p_slug text,
  p_server_id text
) returns void
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_actor     uuid := auth.uid();
  v_team_id   text;
  v_connected boolean;
  v_key       text;
  v_old       uuid;
begin
  perform _assert_tenant_admin(p_tenant_id);

  if p_slug !~ '^[a-z0-9_]+$' then
    raise exception 'disconnect_connector: invalid slug %', p_slug;
  end if;

  select team_id into v_team_id
    from public.connector_metadata
    where tenant_id = p_tenant_id and slug = p_slug
    for update;
  v_connected := found;

  for v_key in
    select key from public.secrets
    where tenant_id = p_tenant_id
      and left(key, length(p_slug) + 1) = p_slug || '.'
  loop
    select vault_secret_id into v_old
      from public.secrets where tenant_id = p_tenant_id and key = v_key;
    if v_old is not null then
      delete from vault.secrets where id = v_old;
    end if;
    delete from public.secrets where tenant_id = p_tenant_id and key = v_key;
  end loop;

  if not v_connected then
    return;
  end if;

  delete from public.connector_metadata
    where tenant_id = p_tenant_id and slug = p_slug;

  update public.tenant_mcp_servers
    set enabled = false
    where tenant_id = p_tenant_id and server_id = p_server_id;

  insert into public.tenant_config_audit
    (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
  values
    (p_tenant_id, v_actor, 'clear', p_slug || '.connection', v_team_id, null,
     jsonb_build_object('source', 'disconnect_connector'));
end $$;

revoke all on function public.disconnect_connector(uuid, text, text) from public, anon;
grant execute on function public.disconnect_connector(uuid, text, text) to authenticated;

create or replace function public.refresh_connector_secrets(
  p_tenant_id uuid,
  p_slug text,
  p_secrets jsonb,
  p_expires_at timestamptz
) returns void
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_key text;
  v_val text;
  v_old_id uuid;
  v_new_id uuid;
begin
  perform 1 from public.connector_metadata
    where tenant_id = p_tenant_id and slug = p_slug
    for update;
  if not found then
    raise exception 'refresh_connector_secrets: connector % is not connected for tenant %',
      p_slug, p_tenant_id
      using errcode = 'no_data_found';
  end if;

  for v_key, v_val in select * from jsonb_each_text(p_secrets) loop
    if left(v_key, length(p_slug) + 1) <> p_slug || '.' then
      raise exception 'refresh_connector_secrets: secret key % is not prefixed %.', v_key, p_slug;
    end if;

    select vault_secret_id into v_old_id from public.secrets
    where tenant_id = p_tenant_id and key = v_key;
    if v_old_id is not null then
      delete from vault.secrets where id = v_old_id;
      delete from public.secrets where tenant_id = p_tenant_id and key = v_key;
    end if;

    v_new_id := vault.create_secret(v_val);
    insert into public.secrets (tenant_id, key, vault_secret_id)
    values (p_tenant_id, v_key, v_new_id);
  end loop;

  update public.connector_metadata
  set token_expires_at = p_expires_at
  where tenant_id = p_tenant_id and slug = p_slug;
end $$;

revoke all on function public.refresh_connector_secrets(uuid, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.refresh_connector_secrets(uuid, text, jsonb, timestamptz)
  to service_role;

commit;
