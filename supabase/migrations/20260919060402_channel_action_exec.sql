
begin;

alter table channel_actions add column if not exists exec_claim_id   uuid;
alter table channel_actions add column if not exists exec_claimed_at timestamptz;

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

  insert into channel_actions
    (tenant_id, channel_slug, run_id, position, run_of, blocking, action_type,
     title, title_key, body, exec_class, exec_payload, score, score_inputs, scored_at)
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
     now())
  returning id into v_id;

  insert into channel_action_events
    (tenant_id, action_id, event, actor_kind, run_id, event_key)
  values
    (v_tenant, v_id, 'proposed', 'channel_run', p_run_id, 'proposed:' || v_id)
  on conflict (action_id, event_key) do nothing;

  return jsonb_build_object('ok', true, 'id', v_id, 'replayed', false, 'position', v_pos);
end $$;

create or replace function approve_channel_action(
  p_tenant_id     uuid,
  p_action_id     uuid,
  p_event_key     text,
  p_actor_user_id uuid default null,
  p_source        text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row     channel_actions%rowtype;
  v_key     text := left(nullif(trim(p_event_key), ''), 200);
  v_attempt int;
begin
  if p_tenant_id is null or p_action_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_key is null then
    return jsonb_build_object('ok', false, 'code', 'event_key_required');
  end if;
  if p_source is not null and p_source <> 'staff' then
    return jsonb_build_object('ok', false, 'code', 'invalid_source');
  end if;

  select * into v_row from channel_actions where id = p_action_id for update;
  if not found or v_row.tenant_id is distinct from p_tenant_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if p_actor_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'approver_required');
  end if;
  if not exists (
    select 1 from tenant_users tu
     where tu.tenant_id = p_tenant_id and tu.user_id = p_actor_user_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if v_row.exec_class is null then
    return jsonb_build_object('ok', false, 'code', 'not_executable');
  end if;

  if exists (select 1 from channel_action_events
              where action_id = p_action_id and event_key = v_key) then
    select count(*) into v_attempt from channel_action_events
     where action_id = p_action_id and event = 'approved';
    return jsonb_build_object('ok', true, 'replayed', true, 'attempt', v_attempt,
                              'exec_class', v_row.exec_class);
  end if;

  if v_row.exec_status in ('queued', 'dispatching') then
    select count(*) into v_attempt from channel_action_events
     where action_id = p_action_id and event = 'approved';
    return jsonb_build_object('ok', true, 'replayed', true, 'queued', true,
                              'attempt', v_attempt,
                              'exec_status', v_row.exec_status);
  end if;
  if v_row.exec_status = 'executed' then
    return jsonb_build_object('ok', false, 'code', 'already_executed');
  end if;
  if v_row.status not in ('pending', 'snoozed') then
    return jsonb_build_object('ok', false, 'code', 'illegal_transition',
                              'from', v_row.status, 'to', 'approved');
  end if;

  update channel_actions
     set exec_status        = 'queued',
         exec_result        = null,
         exec_claim_id      = null,
         exec_claimed_at    = null,
         approved_by        = p_actor_user_id,
         approved_by_source = p_source
   where id = p_action_id;

  insert into channel_action_events
    (tenant_id, action_id, event, actor_kind, actor_user_id, event_key)
  values
    (p_tenant_id, p_action_id, 'approved', 'founder', p_actor_user_id, v_key);

  select count(*) into v_attempt from channel_action_events
   where action_id = p_action_id and event = 'approved';

  return jsonb_build_object('ok', true, 'replayed', false, 'attempt', v_attempt,
                            'exec_class', v_row.exec_class);
end $$;

create or replace function claim_channel_action_exec(
  p_action_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row   channel_actions%rowtype;
  v_claim uuid := gen_random_uuid();
begin
  update channel_actions
     set exec_status     = 'dispatching',
         exec_claim_id   = v_claim,
         exec_claimed_at = now()
   where id = p_action_id
     and exec_status = 'queued'
  returning * into v_row;

  if found then
    return jsonb_build_object(
      'ok', true,
      'claim_id', v_claim,
      'tenant_id', v_row.tenant_id,
      'channel_slug', v_row.channel_slug,
      'exec_class', v_row.exec_class,
      'exec_payload', v_row.exec_payload,
      'approved_by', v_row.approved_by,
      'approved_by_source', v_row.approved_by_source,
      'agent_run_id', v_row.run_id);
  end if;

  select * into v_row from channel_actions where id = p_action_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  return jsonb_build_object(
    'ok', false, 'code', 'not_queued',
    'tenant_id', v_row.tenant_id,
    'exec_status', v_row.exec_status,
    'lease_expired',
      v_row.exec_status = 'dispatching'
      and (v_row.exec_claimed_at is null
           or v_row.exec_claimed_at < now() - interval '10 minutes'));
end $$;

drop function if exists settle_channel_action_exec(uuid, uuid, boolean, jsonb, text);
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
      (p_tenant_id, p_action_id, 'executed', 'founder', v_row.approved_by, v_row.run_id,
       v_note, v_key);
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

revoke all on function record_channel_exec_action(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function record_channel_exec_action(uuid, uuid, jsonb) to service_role;

revoke all on function approve_channel_action(uuid, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function approve_channel_action(uuid, uuid, text, uuid, text) to service_role;

revoke all on function claim_channel_action_exec(uuid)
  from public, anon, authenticated;
grant execute on function claim_channel_action_exec(uuid) to service_role;

revoke all on function settle_channel_action_exec(uuid, uuid, boolean, jsonb, text, uuid)
  from public, anon, authenticated;
grant execute on function settle_channel_action_exec(uuid, uuid, boolean, jsonb, text, uuid)
  to service_role;

update decisions d
   set status = 'archived', archived_at = now()
 where d.status = 'proposed'
   and d.decision_class = 'channel.recipe_step'
   and exists (
     select 1 from agent_runs r
      where r.id = d.agent_run_id
        and r.tenant_id = d.tenant_id
        and r.channel_slug in ('google_ads', 'x_organic')
   );

update decisions d
   set status = 'archived', archived_at = now()
 where d.status = 'proposed'
   and d.decision_class like 'google\_ads.%'
   and exists (
     select 1 from agent_runs r
      where r.id = d.agent_run_id
        and r.tenant_id = d.tenant_id
        and r.channel_slug = 'google_ads'
   );

commit;
