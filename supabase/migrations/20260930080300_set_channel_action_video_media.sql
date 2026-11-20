
create or replace function set_channel_action_video_media(
  p_action_id uuid,
  p_tenant_id uuid,
  p_run_id    uuid,
  p_claim_id  uuid,
  p_ok        boolean,
  p_media     jsonb,
  p_error     text,
  p_code      text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row   channel_actions%rowtype;
  v_note  text := left(nullif(trim(p_error), ''), 1000);
  v_code  text := case when p_code ~ '^[a-z_]{1,40}$' then p_code else null end;
  v_owner boolean;
  v_n     int;
  v_key   text;
begin
  if p_action_id is null or p_tenant_id is null or p_run_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  select * into v_row from channel_actions where id = p_action_id for update;
  if not found
     or v_row.tenant_id is distinct from p_tenant_id
     or v_row.run_id is distinct from p_run_id
     or v_row.exec_class is distinct from 'generated_video.render.v1' then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if p_ok and (jsonb_typeof(p_media) is distinct from 'object'
               or p_media->>'kind' is distinct from 'video'
               or coalesce(p_media->>'storage_path', '') not like (p_tenant_id::text || '/%')) then
    return jsonb_build_object('ok', false, 'code', 'invalid_media');
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
      return jsonb_build_object('ok', false, 'code', 'lease_held');
    end if;
  end if;

  select count(*) into v_n from channel_action_events
   where action_id = p_action_id and event in ('executed', 'exec_failed');
  v_key := 'exec:' || p_action_id || ':' || (v_n + 1);

  if p_ok then
    update channel_actions
       set body        = jsonb_set(coalesce(body, '{}'::jsonb), '{media}', p_media, true),
           exec_status = 'executed',
           executed_at = now(),
           exec_result = jsonb_build_object('delivered', true),
           note        = null
     where id = p_action_id;
    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, actor_user_id, run_id, note, event_key)
    values
      (p_tenant_id, p_action_id, 'executed', 'founder', v_row.approved_by, v_row.run_id, null, v_key);
  else
    update channel_actions
       set exec_status = 'failed',
           exec_result = jsonb_build_object('error', v_note)
                         || case when v_code is null then '{}'::jsonb
                                 else jsonb_build_object('code', v_code) end,
           note        = coalesce(v_note, note)
     where id = p_action_id;
    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, actor_user_id, run_id, note, event_key)
    values
      (p_tenant_id, p_action_id, 'exec_failed', 'system', null, v_row.run_id, v_note, v_key);
  end if;

  return jsonb_build_object('ok', true, 'executed', p_ok);
end $$;

revoke all on function set_channel_action_video_media(uuid, uuid, uuid, uuid, boolean, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function set_channel_action_video_media(uuid, uuid, uuid, uuid, boolean, jsonb, text, text)
  to service_role;
