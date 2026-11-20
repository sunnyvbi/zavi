
create or replace function accept_invite(p_invite_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_invite tenant_member_invites;
  v_caller_email text;
  v_slug text;
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

revoke all on function accept_invite(uuid) from public;
grant execute on function accept_invite(uuid) to authenticated;
