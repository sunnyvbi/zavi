
begin;

create or replace function tenant_kind_downgrade_guard()
returns trigger language plpgsql as $$
begin
  if old.kind = 'real' and new.kind = 'test'
     and coalesce(current_setting('app.allow_tenant_kind_downgrade', true), 'off') <> 'on'
  then
    raise exception
      'tenant % (kind=real) may not be downgraded to kind=test: this is the exact step that makes a real tenant deletable. If this is a deliberate, human-authorized removal, run "SET LOCAL app.allow_tenant_kind_downgrade = ''on''" in the same transaction first. Agents/scripts must NOT set this.',
      old.slug
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists tenants_kind_downgrade_guard on tenants;
create trigger tenants_kind_downgrade_guard
  before update of kind on tenants
  for each row execute function tenant_kind_downgrade_guard();

drop function if exists activate_tenant_lite(uuid, text, text, boolean);

create or replace function activate_tenant_lite(
  p_user_id uuid,
  p_slug text,
  p_display_name text,
  p_allow_additional boolean default false,
  p_kind text default 'real'
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
  if p_kind is null or p_kind not in ('real', 'test') then
    raise exception 'p_kind must be ''real'' or ''test'' (got %)', p_kind using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('activate_tenant_lite:' || p_user_id::text, 0));

  if not p_allow_additional then
    select active_tenant_id into v_existing_active from profiles where user_id = p_user_id;
    if v_existing_active is not null then
      raise exception 'user % already has an active tenant', p_user_id using errcode = '45001';
    end if;
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
    insert into tenants (slug, display_name, kind)
    values (p_slug, p_display_name, p_kind)
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

commit;
