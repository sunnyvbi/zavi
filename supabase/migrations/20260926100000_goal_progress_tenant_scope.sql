
create or replace function public.update_goal_progress(
  p_tenant_id     uuid,
  p_goal_id       uuid,
  p_current_value numeric
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_target numeric; v_status text;
begin
  if p_tenant_id is null or p_goal_id is null or p_current_value is null then
    raise exception 'update_goal_progress: tenant_id/goal_id/current_value required'
      using errcode = '22023';
  end if;
  select target_value, status into v_target, v_status
  from autopilot_goals where id = p_goal_id and tenant_id = p_tenant_id;
  if v_target is null then
    return;
  end if;
  if v_status = 'met' or v_status = 'missed' then
    update autopilot_goals
       set current_value = p_current_value, updated_at = now()
     where id = p_goal_id and tenant_id = p_tenant_id;
    return;
  end if;
  update autopilot_goals
     set current_value = p_current_value,
         status = case when p_current_value >= v_target then 'met' else status end,
         updated_at = now()
   where id = p_goal_id and tenant_id = p_tenant_id;
end $$;

revoke all on function public.update_goal_progress(uuid, uuid, numeric) from public, anon, authenticated;
grant execute on function public.update_goal_progress(uuid, uuid, numeric) to service_role;

create or replace function public.update_goal_progress(
  p_goal_id       uuid,
  p_current_value numeric
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return;
end $$;

revoke all on function public.update_goal_progress(uuid, numeric) from public, anon, authenticated;
grant execute on function public.update_goal_progress(uuid, numeric) to service_role;
