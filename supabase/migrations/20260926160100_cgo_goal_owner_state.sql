
alter table autopilot_goals
  add column if not exists cgo_status_line text,
  add column if not exists cgo_status_at   timestamptz;

create or replace function propose_next_autopilot_goal(
  p_tenant_id     uuid,
  p_objective     text,
  p_target_metric text,
  p_target_value  numeric,
  p_due_date      date default null,
  p_rationale     text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_tenant_id is null or p_objective is null or p_target_metric is null
     or p_target_value is null then
    raise exception 'propose_next_autopilot_goal: tenant_id/objective/target_metric/target_value required'
      using errcode = '22023';
  end if;
  update autopilot_goals
     set status = 'missed'
   where tenant_id = p_tenant_id and status = 'proposed';
  insert into autopilot_goals (
    tenant_id, objective, target_metric, target_value, baseline_value,
    current_value, due_date, priority, source, status, metadata
  ) values (
    p_tenant_id, p_objective, p_target_metric, p_target_value, null,
    null, p_due_date, 50, 'agent_proposed', 'proposed',
    jsonb_build_object('proposed_by', 'cgo',
                       'rationale', coalesce(p_rationale, ''))
  ) returning id into v_id;
  return v_id;
end $$;

revoke all on function propose_next_autopilot_goal(uuid, text, text, numeric, date, text) from public, anon, authenticated;
grant execute on function propose_next_autopilot_goal(uuid, text, text, numeric, date, text) to service_role;

create or replace function set_channel_in_plan_by_cgo(
  p_tenant_id    uuid,
  p_channel_slug text,
  p_in_plan      boolean
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_next int;
  v_ok   boolean;
begin
  if p_tenant_id is null
     or nullif(trim(p_channel_slug), '') is null
     or p_in_plan is null then
    return 'failed';
  end if;

  if exists (
    select 1 from tenant_channels
     where tenant_id = p_tenant_id
       and channel_slug = p_channel_slug
       and (plan_selected_set_by = 'founder' or autorun_set_by = 'founder')
  ) then
    return 'founder_owned';
  end if;

  if p_in_plan then
    if exists (
      select 1 from tenant_channels
       where tenant_id = p_tenant_id
         and channel_slug = p_channel_slug
         and plan_selected
    ) then
      return 'already_in_plan';
    end if;
    if exists (
      select 1 from tenant_channels
       where tenant_id = p_tenant_id
         and channel_slug = p_channel_slug
         and autorun
    ) then
      return 'runs_on_its_own';
    end if;

    select coalesce(max(plan_sort_order), 0) + 1 into v_next
      from tenant_channels
     where tenant_id = p_tenant_id and plan_selected;

    insert into tenant_channels
      (tenant_id, channel_slug, plan_selected, plan_selected_set_by, plan_sort_order, autorun)
    values
      (p_tenant_id, p_channel_slug, true, 'plan', v_next, false)
    on conflict (tenant_id, channel_slug) do update
      set plan_selected        = true,
          plan_selected_set_by = 'plan',
          plan_sort_order      = v_next
      where tenant_channels.plan_selected_set_by is distinct from 'founder'
        and tenant_channels.autorun_set_by is distinct from 'founder'
        and not coalesce(tenant_channels.autorun, false);

    select true into v_ok
      from tenant_channels
     where tenant_id = p_tenant_id
       and channel_slug = p_channel_slug
       and plan_selected
       and plan_selected_set_by = 'plan';
    return case when coalesce(v_ok, false) then 'ok' else 'failed' end;
  end if;

  if not exists (
    select 1 from tenant_channels
     where tenant_id = p_tenant_id
       and channel_slug = p_channel_slug
       and plan_selected
       and plan_selected_set_by = 'plan'
  ) then
    return 'not_plan';
  end if;

  update tenant_channels
     set plan_selected        = false,
         plan_selected_set_by = null,
         plan_sort_order      = null
   where tenant_id = p_tenant_id
     and channel_slug = p_channel_slug
     and plan_selected_set_by = 'plan'
     and autorun_set_by is distinct from 'founder';

  select true into v_ok
    from tenant_channels
   where tenant_id = p_tenant_id
     and channel_slug = p_channel_slug
     and not plan_selected;
  return case when coalesce(v_ok, false) then 'ok' else 'failed' end;
end $$;

revoke all on function set_channel_in_plan_by_cgo(uuid, text, boolean) from public, anon, authenticated;
grant execute on function set_channel_in_plan_by_cgo(uuid, text, boolean) to service_role;
