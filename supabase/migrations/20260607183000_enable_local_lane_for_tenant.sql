
create function enable_local_lane_for_tenant(
  p_tenant_id      uuid,
  p_label          text,
  p_token_hash     text,
  p_token_salt     text,
  p_token_prefix   text,
  p_actor_user_id  uuid,
  p_actor_email    text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_token_id uuid;
  v_revoked  int;
begin
  if not exists (select 1 from tenants where id = p_tenant_id) then
    raise exception 'tenant % not found', p_tenant_id using errcode = '22023';
  end if;

  perform 1 from tenants where id = p_tenant_id for update;

  update mac_worker_tokens
     set revoked_at = now()
   where revoked_at is null
     and id in (
       select token_id from mac_worker_token_tenants where tenant_id = p_tenant_id
     )
     and id not in (
       select token_id from mac_worker_token_tenants where tenant_id <> p_tenant_id
     );
  get diagnostics v_revoked = row_count;

  insert into mac_worker_tokens(token_hash, token_salt, token_prefix, label)
  values (p_token_hash, p_token_salt, p_token_prefix, p_label)
  returning id into v_token_id;

  insert into mac_worker_token_tenants(token_id, tenant_id)
  values (v_token_id, p_tenant_id);

  insert into tenant_local_lane (tenant_id, enabled, updated_by, updated_at)
  values (p_tenant_id, true, 'staff:' || p_actor_email, now())
  on conflict (tenant_id) do update
    set enabled = true,
        updated_by = excluded.updated_by,
        updated_at = now();

  insert into staff_audit_log(
    actor_user_id, actor_email, action, target_table, target_id, tenant_id, meta
  ) values (
    p_actor_user_id, p_actor_email, 'local_lane.enable_one_click',
    'mac_worker_tokens', v_token_id::text, p_tenant_id,
    jsonb_build_object(
      'token_prefix', p_token_prefix,
      'label', p_label,
      'revoked_prior', v_revoked
    )
  );

  return v_token_id;
end $$;

revoke all on function enable_local_lane_for_tenant(uuid, text, text, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function enable_local_lane_for_tenant(uuid, text, text, text, text, uuid, text)
  to service_role;
