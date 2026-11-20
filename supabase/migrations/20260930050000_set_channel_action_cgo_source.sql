
begin;

drop function if exists set_channel_action(uuid, uuid, text, text, timestamptz, text, uuid);

create or replace function set_channel_action(
  p_tenant_id     uuid,
  p_action_id     uuid,
  p_status        text,
  p_note          text,
  p_snoozed_until timestamptz,
  p_event_key     text,
  p_actor_user_id uuid default null,
  p_source        text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row  channel_actions%rowtype;
  v_note text := left(nullif(trim(p_note), ''), 1000);
  v_key  text := left(nullif(trim(p_event_key), ''), 200);
begin
  if p_tenant_id is null or p_action_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_key is null then
    return jsonb_build_object('ok', false, 'code', 'event_key_required');
  end if;
  if p_status is null or p_status not in ('acted', 'rejected', 'snoozed', 'redo_requested') then
    return jsonb_build_object('ok', false, 'code', 'invalid_status');
  end if;
  if p_source is not null and p_source is distinct from 'cgo' then
    return jsonb_build_object('ok', false, 'code', 'invalid_source');
  end if;
  if p_source = 'cgo' and (p_actor_user_id is not null or p_status not in ('acted', 'rejected')) then
    return jsonb_build_object('ok', false, 'code', 'invalid_source');
  end if;

  select * into v_row from channel_actions where id = p_action_id for update;
  if not found or v_row.tenant_id is distinct from p_tenant_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if p_actor_user_id is not null and not exists (
    select 1 from tenant_users tu
     where tu.tenant_id = p_tenant_id and tu.user_id = p_actor_user_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if exists (select 1 from channel_action_events
              where action_id = p_action_id and event_key = v_key) then
    return jsonb_build_object('ok', true, 'replayed', true, 'status', v_row.status);
  end if;

  if v_row.exec_status in ('queued', 'dispatching') then
    return jsonb_build_object('ok', false, 'code', 'exec_in_flight',
                              'exec_status', v_row.exec_status);
  end if;

  if v_row.status not in ('pending', 'snoozed') then
    return jsonb_build_object('ok', false, 'code', 'illegal_transition',
                              'from', v_row.status, 'to', p_status);
  end if;

  if p_status = 'snoozed' and (p_snoozed_until is null or p_snoozed_until <= now()) then
    return jsonb_build_object('ok', false, 'code', 'snooze_until_required');
  end if;
  if p_status = 'redo_requested' and v_note is null then
    return jsonb_build_object('ok', false, 'code', 'note_required');
  end if;

  if p_status <> 'redo_requested' then
    update channel_actions
       set status        = p_status,
           status_at     = now(),
           note          = case
                             when v_note is not null then v_note
                             when p_status in ('acted', 'rejected')
                                  and v_row.exec_status = 'failed' then null
                             else note
                           end,
           snoozed_until = case when p_status = 'snoozed' then p_snoozed_until else null end
     where id = p_action_id;
  else
    update channel_actions set note = v_note where id = p_action_id;
  end if;

  insert into channel_action_events
    (tenant_id, action_id, event, actor_kind, actor_user_id, note, event_key, snoozed_until)
  values
    (p_tenant_id, p_action_id, p_status,
     case when p_source = 'cgo' then 'system' else 'founder' end,
     p_actor_user_id, v_note, v_key,
     case when p_status = 'snoozed' then p_snoozed_until else null end);

  return jsonb_build_object(
    'ok', true, 'replayed', false,
    'status', case when p_status = 'redo_requested' then v_row.status else p_status end);
end $$;

revoke all on function set_channel_action(uuid, uuid, text, text, timestamptz, text, uuid, text)
  from public, anon, authenticated;
grant execute on function set_channel_action(uuid, uuid, text, text, timestamptz, text, uuid, text)
  to service_role;

commit;
