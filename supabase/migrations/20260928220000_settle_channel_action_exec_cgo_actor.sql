
create or replace function settle_channel_action_exec(
  p_tenant_id uuid,
  p_action_id uuid,
  p_ok        boolean,
  p_result    jsonb,
  p_error     text,
  p_claim_id  uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row    channel_actions%rowtype;
  v_note   text := left(nullif(trim(p_error), ''), 1000);
  v_n      int;
  v_key    text;
  v_owner  boolean;
begin
  select * into v_row from channel_actions where id = p_action_id for update;
  if not found or v_row.tenant_id is distinct from p_tenant_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  v_owner := p_claim_id is not null
             and v_row.exec_claim_id is not null
             and v_row.exec_claim_id = p_claim_id;

  if v_owner
     and v_row.exec_status = (case when p_ok then 'executed' else 'failed' end) then
    return jsonb_build_object('ok', true, 'executed', p_ok, 'replayed', true);
  end if;

  if v_row.exec_status is distinct from 'dispatching' then
    return jsonb_build_object('ok', false, 'code', 'not_dispatching',
                              'exec_status', v_row.exec_status);
  end if;

  if not v_owner then
    if p_ok then
      return jsonb_build_object('ok', false, 'code', 'not_owner');
    end if;
    if v_row.exec_claimed_at is not null
       and v_row.exec_claimed_at >= now() - interval '10 minutes' then
      return jsonb_build_object('ok', false, 'code', 'lease_held',
                                'exec_claimed_at', v_row.exec_claimed_at);
    end if;
  end if;

  select count(*) into v_n from channel_action_events
   where action_id = p_action_id and event in ('executed', 'exec_failed');
  v_key := 'exec:' || p_action_id || ':' || (v_n + 1);

  if p_ok then
    update channel_actions
       set status      = 'acted',
           status_at   = now(),
           exec_status = 'executed',
           executed_at = now(),
           exec_result = coalesce(p_result, '{}'::jsonb)
     where id = p_action_id;
    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, actor_user_id, run_id, note, event_key)
    values
      (p_tenant_id, p_action_id, 'executed',
       case when v_row.approved_by_source = 'cgo' then 'system' else 'founder' end,
       v_row.approved_by, v_row.run_id, v_note, v_key);
  else
    update channel_actions
       set exec_status = 'failed',
           exec_result = coalesce(p_result, '{}'::jsonb),
           note        = coalesce(v_note, note)
     where id = p_action_id;
    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, actor_user_id, run_id, note, event_key)
    values
      (p_tenant_id, p_action_id, 'exec_failed', 'system', null, v_row.run_id, v_note, v_key);
  end if;

  return jsonb_build_object('ok', true, 'executed', p_ok);
end $$;

revoke all on function settle_channel_action_exec(uuid, uuid, boolean, jsonb, text, uuid)
  from public, anon, authenticated;
grant execute on function settle_channel_action_exec(uuid, uuid, boolean, jsonb, text, uuid)
  to service_role;
