
begin;

create or replace function close_channel_actions_on_cgo_pause(
  p_tenant_id    uuid,
  p_channel_slug text,
  p_run_id       uuid,
  p_why          text
) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_note   text;
  v_row    record;
  v_key    text;
  v_closed int := 0;
begin
  if p_tenant_id is null or nullif(trim(p_channel_slug), '') is null or p_run_id is null then
    return 0;
  end if;

  if not exists (
    select 1 from tenant_channels
     where tenant_id = p_tenant_id
       and channel_slug = p_channel_slug
       and not plan_selected
       and plan_selected_set_by is distinct from 'founder'
       and autorun_set_by is distinct from 'founder'
  ) then
    return 0;
  end if;

  v_note := left('Closed when Zavi paused this channel'
                 || coalesce(': ' || nullif(trim(p_why), ''), ''), 1000);

  for v_row in
    select id from channel_actions
     where tenant_id = p_tenant_id
       and channel_slug = p_channel_slug
       and status in ('pending', 'snoozed')
       and exec_status is distinct from 'queued'
       and exec_status is distinct from 'dispatching'
     for update
  loop
    v_key := 'cgo_pause:' || p_run_id || ':' || v_row.id;
    if exists (select 1 from channel_action_events where action_id = v_row.id and event_key = v_key) then
      continue;
    end if;

    update channel_actions
       set status = 'stale', status_at = now(), note = v_note
     where id = v_row.id;

    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, run_id, note, event_key)
    values
      (p_tenant_id, v_row.id, 'stale_flagged', 'system', p_run_id, v_note, v_key);

    v_closed := v_closed + 1;
  end loop;

  return v_closed;
end $$;

revoke all on function close_channel_actions_on_cgo_pause(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function close_channel_actions_on_cgo_pause(uuid, text, uuid, text) to service_role;

create or replace function set_channel_in_plan(
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

  if p_in_plan then
    select coalesce(max(plan_sort_order), 0) + 1 into v_next
      from tenant_channels
     where tenant_id = p_tenant_id and plan_selected;

    if exists (
      select 1 from tenant_channels
       where tenant_id = p_tenant_id
         and channel_slug = p_channel_slug
         and plan_selected
         and plan_selected_set_by = 'plan'
    ) then
      return 'already_in_plan';
    end if;

    insert into tenant_channels
      (tenant_id, channel_slug, plan_selected, plan_selected_set_by, plan_sort_order,
       autorun, autorun_set_by)
    values
      (p_tenant_id, p_channel_slug, true, 'founder', v_next, false, 'founder')
    on conflict (tenant_id, channel_slug) do update
      set plan_selected        = true,
          plan_selected_set_by = 'founder',
          plan_sort_order      = coalesce(tenant_channels.plan_sort_order, v_next),
          autorun_set_by       = case when tenant_channels.autorun
                                      then tenant_channels.autorun_set_by
                                      else 'founder' end,
          cgo_reason           = null,
          cgo_set_at           = null;

    select true into v_ok
      from tenant_channels
     where tenant_id = p_tenant_id
       and channel_slug = p_channel_slug
       and plan_selected
       and plan_selected_set_by = 'founder';
    return case when coalesce(v_ok, false) then 'ok' else 'failed' end;
  end if;

  if not exists (
    select 1 from tenant_channels
     where tenant_id = p_tenant_id
       and channel_slug = p_channel_slug
       and plan_selected
       and plan_selected_set_by = 'founder'
  ) then
    return 'not_founder';
  end if;

  update tenant_channels
     set plan_selected        = false,
         plan_selected_set_by = null,
         plan_sort_order      = null
   where tenant_id = p_tenant_id
     and channel_slug = p_channel_slug;

  select true into v_ok
    from tenant_channels
   where tenant_id = p_tenant_id
     and channel_slug = p_channel_slug
     and not plan_selected;
  return case when coalesce(v_ok, false) then 'ok' else 'failed' end;
end $$;

revoke all on function set_channel_in_plan(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function set_channel_in_plan(uuid, text, boolean)
  to service_role;

commit;
