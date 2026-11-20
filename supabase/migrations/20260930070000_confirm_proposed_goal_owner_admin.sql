
create or replace function confirm_proposed_goal(p_goal_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_tenant uuid; v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'auth required' using errcode = '42501'; end if;

  select tenant_id into v_tenant from autopilot_goals
   where id = p_goal_id and status = 'proposed';
  if v_tenant is null then
    raise exception 'no proposed goal %', p_goal_id using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from tenant_users
     where tenant_id = v_tenant and user_id = v_uid and role in ('owner', 'admin')
  ) then
    raise exception 'only an owner or admin can accept a goal' using errcode = '42501';
  end if;

  update autopilot_goals
     set status = 'active', source = 'founder'
   where id = p_goal_id;
  return p_goal_id;
end $$;

revoke all on function confirm_proposed_goal(uuid) from public, anon, authenticated;
grant execute on function confirm_proposed_goal(uuid) to authenticated, service_role;
