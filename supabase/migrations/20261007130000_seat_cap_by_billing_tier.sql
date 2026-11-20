
insert into tenant_seat_limits (tier, max_seats) values
  ('free',    1),
  ('starter', 3),
  ('growth',  3),
  ('pro',     10)
on conflict (tier) do update set max_seats = excluded.max_seats;

create or replace function invite_member(
  p_email text,
  p_role text,
  p_agent_slugs text[]
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_email_normalized text;
  v_existing_seats int;
  v_open_invites int;
  v_max int;
  v_tier text;
  v_invite_id uuid;
  v_slugs text[];
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select app_active_tenant() into v_tenant;
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  perform _assert_tenant_admin(v_tenant);

  if p_role is null or p_role not in ('admin','member','viewer') then
    raise exception 'invalid role %; must be admin, member or viewer', p_role using errcode = '22023';
  end if;

  v_email_normalized := lower(trim(coalesce(p_email, '')));
  if v_email_normalized = '' then
    raise exception 'email required' using errcode = '22023';
  end if;

  v_slugs := array[]::text[];

  v_tier := _tenant_tier(v_tenant);
  select max_seats into v_max from tenant_seat_limits where tier = v_tier;
  if v_max is null then
    raise exception 'no seat limit defined for tier %', v_tier using errcode = '22023';
  end if;
  if v_max >= 0 then
    select count(*) into v_existing_seats from tenant_users where tenant_id = v_tenant;
    select count(*) into v_open_invites from tenant_member_invites
      where tenant_id = v_tenant
        and accepted_at is null
        and revoked_at is null;
    if (v_existing_seats + v_open_invites) >= v_max then
      raise exception 'seat_cap_exceeded — tier % allows % seats (%/% used)',
        v_tier, v_max, v_existing_seats + v_open_invites, v_max
        using errcode = '42501';
    end if;
  end if;

  insert into tenant_member_invites (tenant_id, email, role, invited_by, agent_slugs)
  values (v_tenant, v_email_normalized, p_role, auth.uid(), v_slugs)
  on conflict (tenant_id, lower(email))
    where accepted_at is null and revoked_at is null
  do update set
    role         = excluded.role,
    invited_by   = excluded.invited_by,
    agent_slugs  = excluded.agent_slugs,
    invited_at   = now()
  returning id into v_invite_id;

  return v_invite_id;
end $$;
revoke all on function invite_member(text, text, text[]) from public, anon, authenticated;
grant execute on function invite_member(text, text, text[]) to authenticated;

create or replace function accept_invite(p_invite_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_invite tenant_member_invites;
  v_caller_email text;
  v_slug text;
  v_tier text;
  v_max int;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select email into v_caller_email from auth.users where id = auth.uid();
  if v_caller_email is null then
    raise exception 'caller email unknown' using errcode = '42501';
  end if;

  select * into v_invite from tenant_member_invites where id = p_invite_id;
  if v_invite.id is null then
    raise exception 'invite % not found', p_invite_id using errcode = '42704';
  end if;
  if v_invite.accepted_at is not null then
    raise exception 'invite already accepted' using errcode = '42501';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'invite revoked' using errcode = '42501';
  end if;
  if lower(v_caller_email) <> lower(v_invite.email) then
    raise exception 'invite is for a different email' using errcode = '42501';
  end if;

  if not exists (select 1 from tenant_users
                  where tenant_id = v_invite.tenant_id and user_id = auth.uid()) then
    v_tier := _tenant_tier(v_invite.tenant_id);
    select max_seats into v_max from tenant_seat_limits where tier = v_tier;
    if v_max is not null and v_max >= 0
       and (select count(*) from tenant_users where tenant_id = v_invite.tenant_id) >= v_max then
      raise exception 'seat_cap_exceeded — tier % allows % seats', v_tier, v_max
        using errcode = '42501';
    end if;
  end if;

  insert into tenant_users (user_id, tenant_id, role)
  values (auth.uid(), v_invite.tenant_id, v_invite.role)
  on conflict (user_id, tenant_id) do nothing;

  if v_invite.role = 'member' then
    foreach v_slug in array v_invite.agent_slugs loop
      insert into tenant_member_agents (tenant_id, user_id, agent_slug, added_by)
      values (v_invite.tenant_id, auth.uid(), v_slug, v_invite.invited_by)
      on conflict (tenant_id, user_id, agent_slug) do nothing;
    end loop;
  end if;

  update tenant_member_invites
     set accepted_at = now(),
         accepted_user_id = auth.uid()
   where id = p_invite_id;

  insert into profiles (user_id, active_tenant_id)
  values (auth.uid(), v_invite.tenant_id)
  on conflict (user_id) do update
    set active_tenant_id = excluded.active_tenant_id;
end $$;

revoke all on function accept_invite(uuid) from public, anon, authenticated;
grant execute on function accept_invite(uuid) to authenticated;
