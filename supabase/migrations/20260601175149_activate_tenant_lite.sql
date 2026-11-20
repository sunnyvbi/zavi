
create or replace function activate_tenant_lite(
  p_user_id uuid,
  p_slug text,
  p_display_name text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant_id uuid;
  v_existing_owner uuid;
  v_existing_active uuid;
begin
  if p_user_id is null then
    raise exception 'p_user_id required' using errcode = '22023';
  end if;
  if p_slug is null or length(trim(p_slug)) = 0 then
    raise exception 'p_slug required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('activate_tenant_lite:' || p_user_id::text, 0));
  select active_tenant_id into v_existing_active from profiles where user_id = p_user_id;
  if v_existing_active is not null then
    raise exception 'user % already has an active tenant', p_user_id using errcode = '45001';
  end if;

  select id into v_tenant_id from tenants where slug = p_slug;

  if v_tenant_id is not null then
    select user_id into v_existing_owner
    from tenant_users
    where tenant_id = v_tenant_id and user_id = p_user_id;
    if v_existing_owner is null then
      raise exception 'tenant slug % is taken by another user; pick a different slug', p_slug
        using errcode = '23505';
    end if;
  else
    insert into tenants (slug, display_name)
    values (p_slug, p_display_name)
    returning id into v_tenant_id;
  end if;

  insert into tenant_users (user_id, tenant_id, role)
  values (p_user_id, v_tenant_id, 'owner')
  on conflict (user_id, tenant_id) do nothing;

  insert into profiles (user_id, active_tenant_id, onboarded_at)
  values (p_user_id, v_tenant_id, now())
  on conflict (user_id) do update
    set active_tenant_id = excluded.active_tenant_id,
        onboarded_at = coalesce(profiles.onboarded_at, excluded.onboarded_at);

  return v_tenant_id;
end $$;

revoke all on function activate_tenant_lite(uuid, text, text) from public;
grant execute on function activate_tenant_lite(uuid, text, text) to service_role;
