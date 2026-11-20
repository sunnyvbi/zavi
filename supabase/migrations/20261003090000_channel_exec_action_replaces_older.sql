
begin;

create or replace function record_channel_exec_action(
  p_tenant_id uuid,
  p_run_id    uuid,
  p_action    jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant  uuid;
  v_channel text;
  v_class   text;
  v_payload jsonb;
  v_title   text;
  v_type    text;
  v_pos     int;
  v_id      uuid;
  v_kind    text;
  v_primary text;
  v_done    text;
  v_howto   jsonb;
  v_obj     text;
  v_subject text;
  v_old     uuid;
  v_replaced int := 0;
begin
  select tenant_id, channel_slug into v_tenant, v_channel
    from agent_runs where id = p_run_id;
  if v_tenant is null then
    return jsonb_build_object('ok', false, 'code', 'no_run');
  end if;
  if p_tenant_id is distinct from v_tenant then
    raise exception 'record_channel_exec_action: run % belongs to tenant %, not %',
      p_run_id, v_tenant, p_tenant_id using errcode = 'P0001';
  end if;
  if v_channel is null then
    return jsonb_build_object('ok', false, 'code', 'unstamped_run');
  end if;

  v_class   := nullif(trim(p_action->>'exec_class'), '');
  v_title   := left(nullif(trim(p_action->>'title'), ''), 300);
  v_type    := p_action->>'action_type';
  if v_class is null or v_title is null
     or jsonb_typeof(p_action->'exec_payload') is distinct from 'object'
     or jsonb_typeof(p_action->'body') is distinct from 'object' then
    return jsonb_build_object('ok', false, 'code', 'invalid_action');
  end if;
  v_payload := p_action->'exec_payload';
  if v_type is null or v_type not in (
       'text_post','image_post','video_post','reply','send_message',
       'create_ad','update_ad','pause_ad','fix','check','setup','page','other') then
    v_type := 'other';
  end if;

  select id into v_id
    from channel_actions
   where run_id = p_run_id
     and tenant_id = v_tenant
     and exec_class = v_class
     and exec_payload = v_payload
   limit 1;
  if v_id is not null then
    return jsonb_build_object('ok', true, 'id', v_id, 'replayed', true);
  end if;

  select greatest(coalesce(max(position), 899) + 1, 900) into v_pos
    from channel_actions where run_id = p_run_id and position >= 900;

  v_kind    := nullif(trim(p_action->>'card_kind'), '');
  v_primary := left(nullif(trim(p_action->>'primary_label'), ''), 60);
  v_done    := left(nullif(trim(p_action->>'done_label'), ''), 60);
  v_howto   := p_action->'how_to';
  if v_kind is null or v_kind not in ('executes','post','plan','message','ad_manual','copy_to_site','task')
     or v_primary is null or v_done is null then
    v_kind := null; v_primary := null; v_done := null;
  end if;
  if jsonb_typeof(v_howto) is distinct from 'array' or jsonb_array_length(v_howto) > 12 then
    v_howto := '[]'::jsonb;
  end if;

  insert into channel_actions
    (tenant_id, channel_slug, run_id, position, run_of, blocking, action_type,
     title, title_key, body, exec_class, exec_payload, score, score_inputs, scored_at,
     card_kind, primary_label, done_label, how_to)
  values
    (v_tenant, v_channel, p_run_id, v_pos, v_pos,
     coalesce((p_action->>'blocking')::boolean, false), v_type,
     v_title,
     coalesce(nullif(p_action->>'title_key', ''),
              lower(regexp_replace(v_title, '\s+', ' ', 'g'))),
     p_action->'body', v_class, v_payload,
     case when jsonb_typeof(p_action->'score') = 'number'
          then greatest(0, least(100, (p_action->>'score')::numeric)) else 0 end,
     case when jsonb_typeof(p_action->'score_inputs') = 'object'
          then p_action->'score_inputs' else '{}'::jsonb end,
     now(),
     v_kind, v_primary, v_done, v_howto)
  returning id into v_id;

  v_obj := coalesce(nullif(v_payload->>'criterion_id', ''), nullif(v_payload->>'ad_id', ''),
                    nullif(v_payload->>'object_id', ''), nullif(v_payload->>'ad_set_id', ''),
                    nullif(v_payload->>'ad_group_id', ''), nullif(v_payload->>'campaign_id', ''));
  if v_type in ('update_ad', 'pause_ad') and v_obj is not null then
    v_subject := concat_ws('|', v_payload->>'level', v_payload->>'parent_id', v_obj);
    for v_old in
      update channel_actions
         set status = 'stale', status_at = now(),
             note = left('Replaced by a newer version: ' || v_title, 1000)
       where tenant_id = v_tenant
         and channel_slug = v_channel
         and exec_class = v_class
         and id <> v_id
         and status in ('pending', 'snoozed')
         and (status = 'pending' or snoozed_until is null or snoozed_until <= now())
         and (exec_status is null
              or (exec_status = 'failed'
                  and coalesce(exec_result->>'code', '') not in ('exec_partial', 'exec_outcome_unknown')
                  and not (coalesce(exec_result, '{}'::jsonb) ? 'interrupted')
                  and not (coalesce(exec_result, '{}'::jsonb) ? 'lease_expired')))
         and edited_body is null
         and steps_done = '[]'::jsonb
         and concat_ws('|', exec_payload->>'level', exec_payload->>'parent_id',
               coalesce(nullif(exec_payload->>'criterion_id', ''), nullif(exec_payload->>'ad_id', ''),
                        nullif(exec_payload->>'object_id', ''), nullif(exec_payload->>'ad_set_id', ''),
                        nullif(exec_payload->>'ad_group_id', ''), nullif(exec_payload->>'campaign_id', '')))
             = v_subject
      returning id
    loop
      insert into channel_action_events
        (tenant_id, action_id, event, actor_kind, run_id, note, event_key)
      values
        (v_tenant, v_old, 'stale_flagged', 'channel_run', p_run_id,
         left('Replaced by a newer version: ' || v_title, 1000), 'replaced:' || v_id)
      on conflict (action_id, event_key) do nothing;
      v_replaced := v_replaced + 1;
    end loop;
  end if;

  insert into channel_action_events
    (tenant_id, action_id, event, actor_kind, run_id, event_key)
  values
    (v_tenant, v_id, 'proposed', 'channel_run', p_run_id, 'proposed:' || v_id)
  on conflict (action_id, event_key) do nothing;

  return jsonb_build_object('ok', true, 'id', v_id, 'replayed', false, 'position', v_pos,
                            'replaced', v_replaced);
end $$;

revoke all on function record_channel_exec_action(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function record_channel_exec_action(uuid, uuid, jsonb) to service_role;

commit;
