
create or replace function set_email_member_enabled(p_user_id uuid, p_enabled boolean)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_actor       uuid := auth.uid();
  v_tenant_id   uuid;
  v_role        text;
  v_target_role text;
begin
  if v_actor is null then
    raise exception 'not_authenticated';
  end if;

  v_tenant_id := public.app_active_tenant();
  if v_tenant_id is null then
    raise exception 'no_tenant_membership';
  end if;

  select tu.role into v_role
    from public.tenant_users tu
   where tu.user_id = v_actor and tu.tenant_id = v_tenant_id;

  if v_role is null then
    raise exception 'no_tenant_membership';
  end if;

  if v_role not in ('owner', 'admin') then
    raise exception 'admin_only';
  end if;

  select tu.role into v_target_role
    from public.tenant_users tu
   where tu.user_id = p_user_id and tu.tenant_id = v_tenant_id;

  if v_target_role is null then
    raise exception 'target_not_a_member';
  end if;

  if not p_enabled and v_target_role = 'owner' then
    raise exception 'owner_email_always_on';
  end if;

  if p_enabled then
    delete from public.tenant_email_member_disabled d
     where d.tenant_id = v_tenant_id and d.user_id = p_user_id;
  else
    insert into public.tenant_email_member_disabled (tenant_id, user_id, disabled_by)
    values (v_tenant_id, p_user_id, v_actor)
    on conflict (tenant_id, user_id) do nothing;
  end if;

  return p_enabled;
end $$;

revoke all on function set_email_member_enabled(uuid, boolean) from public, anon, authenticated;
grant execute on function set_email_member_enabled(uuid, boolean) to authenticated;
grant execute on function set_email_member_enabled(uuid, boolean) to service_role;

comment on function set_email_member_enabled(uuid, boolean) is
  'Settings write (OWNER|ADMIN): turn one member''s AgentMail access ON/OFF. Tenant re-derived from the session; the target must be a member of it. An OWNER can never be turned OFF (owner_email_always_on). EMAIL access only — the person remains a full workspace member.';

create or replace function list_email_member_disabled()
returns setof uuid
language plpgsql stable security definer
set search_path = public, pg_temp as $$
declare
  v_user_id   uuid := auth.uid();
  v_tenant_id uuid;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  v_tenant_id := public.app_active_tenant();
  if v_tenant_id is null then
    raise exception 'no_tenant_membership';
  end if;

  if not exists (
    select 1 from public.tenant_users tu
    where tu.user_id = v_user_id and tu.tenant_id = v_tenant_id
  ) then
    raise exception 'no_tenant_membership';
  end if;

  return query
    select d.user_id
    from public.tenant_email_member_disabled d
    join public.tenant_users tu
      on tu.user_id = d.user_id and tu.tenant_id = d.tenant_id
    where d.tenant_id = v_tenant_id
      and tu.role <> 'owner';
end $$;

revoke all on function list_email_member_disabled() from public, anon, authenticated;
grant execute on function list_email_member_disabled() to authenticated;
grant execute on function list_email_member_disabled() to service_role;

comment on function list_email_member_disabled() is
  'Settings read: user_ids in the caller''s tenant whose email access is OFF. Absence from this set = ON. Owners are never in it.';

create or replace function disabled_member_emails(p_tenant_id uuid)
returns setof text
language sql stable security definer
set search_path = public, auth, pg_temp as $$
  select lower(u.email)
  from tenant_email_member_disabled d
  join tenant_users tu on tu.user_id = d.user_id and tu.tenant_id = d.tenant_id
  join auth.users u on u.id = d.user_id
  where d.tenant_id = p_tenant_id
    and tu.role <> 'owner'
    and u.email is not null;
$$;

revoke all on function disabled_member_emails(uuid) from public, anon, authenticated;
grant execute on function disabled_member_emails(uuid) to service_role;

comment on function disabled_member_emails(uuid) is
  'AgentMail gate: addresses whose member has email access OFF. Owners are never returned (owner email is always on). A hit here is a HARD REFUSAL in both directions and MUST be checked BEFORE the allowlist — an explicit per-person deny outranks a broad domain allow, or the toggle silently no-ops for anyone at an allowlisted domain.';

delete from tenant_email_member_disabled d
 using tenant_users tu
 where tu.user_id = d.user_id
   and tu.tenant_id = d.tenant_id
   and tu.role = 'owner';
