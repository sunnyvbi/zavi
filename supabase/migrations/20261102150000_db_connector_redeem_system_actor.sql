create or replace function public.redeem_db_connector_pair_code(
  p_tenant_id uuid, p_code_id uuid, p_code_hash text, p_token_hash text, p_machine text, p_version text
) returns uuid
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_used uuid;
  v_conn uuid;
  v_key text;
  v_old uuid;
  v_by uuid;
begin
  if p_tenant_id is null or p_code_id is null then
    raise exception 'tenant and code are required' using errcode = '22023';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'bad hash' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('operator_db_connection:' || p_tenant_id::text));
  update public.db_connector_pair_codes set used_at = now()
   where id = p_code_id and tenant_id = p_tenant_id and code_hash = p_code_hash
     and used_at is null and expires_at > now()
  returning id, created_by into v_used, v_by;
  if v_used is null then
    return null;
  end if;

  delete from public.db_connectors where tenant_id = p_tenant_id;
  insert into public.db_connectors (tenant_id, token_hash, pair_code_id, machine_name, version, last_seen_at, created_by)
  values (p_tenant_id, p_token_hash, p_code_id, left(p_machine, 120), left(p_version, 40), now(), v_by)
  returning id into v_conn;

  for v_key in
    select key from public.secrets where tenant_id = p_tenant_id and left(key, 12) = 'operator_db.'
  loop
    select vault_secret_id into v_old from public.secrets where tenant_id = p_tenant_id and key = v_key;
    if v_old is not null then
      delete from vault.secrets where id = v_old;
    end if;
    delete from public.secrets where tenant_id = p_tenant_id and key = v_key;
  end loop;

  update public.tenant_db_config set mode = 'connector', updated_at = now() where tenant_id = p_tenant_id;
  perform public._reset_db_policy_for_transition(p_tenant_id);

  insert into public.connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at, managed_by)
  values (p_tenant_id, 'operator_db', 'connector', 'Your database', array['read']::text[], now(), null)
  on conflict (tenant_id, slug) do update
    set team_id = 'connector', team_name = 'Your database', scopes = array['read']::text[],
        connected_at = now(), managed_by = null;
  update public.tenant_mcp_servers set enabled = true where tenant_id = p_tenant_id and server_id = 'operator_db';
  update public.tenant_db_settings set managed_db_opt_out_at = null, updated_at = now()
   where tenant_id = p_tenant_id and managed_db_opt_out_at is not null;
  delete from public.db_rediscovery_backfill where tenant_id = p_tenant_id and requested_at is null;

  insert into public.tenant_config_audit (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
  values (p_tenant_id, v_by, case when v_by is null then 'set-system' else 'set' end, 'operator_db.connector', null, null,
          jsonb_build_object('source', 'redeem_db_connector_pair_code'));
  return v_conn;
end $$;
revoke all on function public.redeem_db_connector_pair_code(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.redeem_db_connector_pair_code(uuid, uuid, text, text, text, text) to service_role;
