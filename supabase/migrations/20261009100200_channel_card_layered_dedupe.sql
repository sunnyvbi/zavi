
begin;

alter table channel_actions add column if not exists target_key text check (target_key is null or char_length(target_key) <= 300);

create index if not exists channel_actions_open_target_idx on channel_actions (tenant_id, channel_slug, target_key) where status in ('pending', 'snoozed') and target_key is not null;
create index if not exists channel_actions_open_by_channel_idx on channel_actions (tenant_id, channel_slug, proposed_at desc) where status in ('pending', 'snoozed');

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
  v_family  text;
  v_norm    jsonb;
  v_target  text;
  v_judged  uuid[];
  v_want    uuid;
  v_repeat  uuid;
  v_status  text;
  v_untouched boolean;
  v_retire  uuid[] := '{}';
  v_retired uuid[] := '{}';
  v_unseen  uuid;
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

  perform pg_advisory_xact_lock(hashtextextended('channel_card:' || v_tenant || ':' || v_channel, 0));

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

  v_family := regexp_replace(v_class, '_review$', '');
  v_norm   := v_payload - 'rationale' - 'decision_evidence' - 'about';
  v_target := left(nullif(trim(p_action->>'target_key'), ''), 300);
  if jsonb_typeof(p_action->'judged_ids') = 'array' then
    select coalesce(array_agg(e::uuid), '{}'::uuid[]) into v_judged
      from jsonb_array_elements_text(p_action->'judged_ids') as j(e)
     where e ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  end if;
  if (p_action->>'repeat_of') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_want := (p_action->>'repeat_of')::uuid;
  end if;
  v_obj := coalesce(nullif(v_payload->>'criterion_id', ''), nullif(v_payload->>'ad_id', ''),
                    nullif(v_payload->>'object_id', ''), nullif(v_payload->>'ad_set_id', ''),
                    nullif(v_payload->>'ad_group_id', ''), nullif(v_payload->>'campaign_id', ''));
  if v_type in ('update_ad', 'pause_ad') and v_obj is not null then
    v_subject := concat_ws('|', v_payload->>'level', v_payload->>'parent_id', v_obj);
  end if;

  if v_judged is not null and v_target is not null then
    select id into v_unseen
      from channel_actions
     where tenant_id = v_tenant
       and channel_slug = v_channel
       and status in ('pending', 'snoozed')
       and target_key = v_target
       and not (id = any(v_judged))
       and id is distinct from v_want
     limit 1;
    if v_unseen is not null then
      return jsonb_build_object('ok', false, 'code', 'rematch', 'reason', 'unseen_same_target');
    end if;
  end if;

  if v_want is not null then
    select id, status,
           (status in ('pending', 'snoozed')
            and (status = 'pending' or snoozed_until is null or snoozed_until <= now())
            and (exec_status is null
                 or (exec_status = 'failed'
                     and coalesce(exec_result->>'code', '') not in ('exec_partial', 'exec_outcome_unknown')
                     and not (coalesce(exec_result, '{}'::jsonb) ? 'interrupted')
                     and not (coalesce(exec_result, '{}'::jsonb) ? 'lease_expired')))
            and coalesce(exec_result->>'bucket', '') <> 'partial_risk'
            and edited_body is null
            and steps_done = '[]'::jsonb)
      into v_repeat, v_status, v_untouched
      from channel_actions
     where id = v_want
       and tenant_id = v_tenant
       and channel_slug = v_channel
     for update;
    if v_repeat is not null and v_status not in ('pending', 'snoozed') then
      return jsonb_build_object('ok', false, 'code', 'rematch', 'reason', 'repeat_closed');
    end if;
    if v_repeat is not null and not v_untouched then
      return jsonb_build_object('ok', true, 'id', v_repeat, 'replayed', false, 'kept', true);
    end if;
    if v_repeat is not null then
      v_retire := array[v_repeat];
    end if;
  end if;

  for v_old, v_untouched in
    select id,
           ((status = 'pending' or snoozed_until is null or snoozed_until <= now())
            and (exec_status is null
                 or (exec_status = 'failed'
                     and coalesce(exec_result->>'code', '') not in ('exec_partial', 'exec_outcome_unknown')
                     and not (coalesce(exec_result, '{}'::jsonb) ? 'interrupted')
                     and not (coalesce(exec_result, '{}'::jsonb) ? 'lease_expired')))
            and coalesce(exec_result->>'bucket', '') <> 'partial_risk'
            and edited_body is null
            and steps_done = '[]'::jsonb)
      from channel_actions
     where tenant_id = v_tenant
       and channel_slug = v_channel
       and status in ('pending', 'snoozed')
       and exec_class is not null
       and regexp_replace(exec_class, '_review$', '') = v_family
       and id is distinct from v_repeat
       and ((v_subject is not null
             and action_type in ('update_ad', 'pause_ad')
             and concat_ws('|', exec_payload->>'level', exec_payload->>'parent_id',
                   coalesce(nullif(exec_payload->>'criterion_id', ''), nullif(exec_payload->>'ad_id', ''),
                            nullif(exec_payload->>'object_id', ''), nullif(exec_payload->>'ad_set_id', ''),
                            nullif(exec_payload->>'ad_group_id', ''), nullif(exec_payload->>'campaign_id', '')))
                 = v_subject)
            or ((v_norm - 'name' - 'campaign_name') <> '{}'::jsonb
                and (exec_payload - 'rationale' - 'decision_evidence' - 'about') = v_norm))
     order by proposed_at desc, id desc
     for update
  loop
    if not v_untouched then
      return jsonb_build_object('ok', true, 'id', v_old, 'replayed', false, 'kept', true);
    end if;
    v_retire := v_retire || v_old;
  end loop;

  if cardinality(v_retire) > 0 then
    with retired as (
      update channel_actions
         set status = 'stale', status_at = now(),
             note = left('Replaced by a newer version: ' || v_title, 1000)
       where tenant_id = v_tenant
         and channel_slug = v_channel
         and id = any(v_retire)
         and status in ('pending', 'snoozed')
         and (status = 'pending' or snoozed_until is null or snoozed_until <= now())
         and (exec_status is null
              or (exec_status = 'failed'
                  and coalesce(exec_result->>'code', '') not in ('exec_partial', 'exec_outcome_unknown')
                  and not (coalesce(exec_result, '{}'::jsonb) ? 'interrupted')
                  and not (coalesce(exec_result, '{}'::jsonb) ? 'lease_expired')))
         and coalesce(exec_result->>'bucket', '') <> 'partial_risk'
         and edited_body is null
         and steps_done = '[]'::jsonb
      returning id, proposed_at
    )
    select coalesce(array_agg(id order by proposed_at desc, id desc), '{}'::uuid[]) into v_retired from retired;
    v_repeat := case when v_repeat = any(v_retired) then v_repeat else v_retired[1] end;
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
     card_kind, primary_label, done_label, how_to, repeat_of, target_key)
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
     v_kind, v_primary, v_done, v_howto, v_repeat, v_target)
  returning id into v_id;

  foreach v_old in array v_retired
  loop
    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, run_id, note, event_key)
    values
      (v_tenant, v_old, 'stale_flagged', 'channel_run', p_run_id,
       left('Replaced by a newer version: ' || v_title, 1000), 'replaced:' || v_id)
    on conflict (action_id, event_key) do nothing;
    v_replaced := v_replaced + 1;
  end loop;

  insert into channel_action_events
    (tenant_id, action_id, event, actor_kind, run_id, event_key)
  values
    (v_tenant, v_id, 'proposed', 'channel_run', p_run_id, 'proposed:' || v_id)
  on conflict (action_id, event_key) do nothing;

  return jsonb_build_object('ok', true, 'id', v_id, 'replayed', false, 'position', v_pos,
                            'replaced', v_replaced, 'repeat_of', v_repeat);
end $$;

revoke all on function record_channel_exec_action(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function record_channel_exec_action(uuid, uuid, jsonb) to service_role;

create or replace function record_channel_run_actions(
  p_tenant_id uuid,
  p_run_id    uuid,
  p_actions   jsonb,
  p_metrics   jsonb,
  p_stale     jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant    uuid;
  v_channel   text;
  v_day       date := (now() at time zone 'utc')::date;
  v_a         jsonb;
  v_m         jsonb;
  v_s         jsonb;
  v_ord       bigint;
  v_n         int;
  v_id        uuid;
  v_inserted  int := 0;
  v_skipped   int := 0;
  v_coerced   int := 0;
  v_metrics   int := 0;
  v_m_dropped int := 0;
  v_st_ok     int := 0;
  v_st_drop   int := 0;
  v_type      text;
  v_title     text;
  v_impact    int;
  v_reason    text;
  v_repeat    uuid;
  v_redo      uuid;
  v_pos       int;
  v_of        int;
  v_baseline  jsonb := '{}'::jsonb;
  v_ids       jsonb := '[]'::jsonb;
  v_key       text;
  v_wk        text;
  v_evidence  text;
  v_target    uuid;
  v_kind      text;
  v_primary   text;
  v_done      text;
  v_howto     jsonb;
  v_kept_open uuid[] := '{}';
  v_refused   int := 0;
  v_tkey      text;
  v_title_key text;
  v_judged    uuid[];
  v_want      uuid;
  v_rstatus   text;
  v_untouched boolean;
  v_rematch   jsonb := '[]'::jsonb;
  v_retired_here uuid[] := '{}';
  v_l1        uuid[];
  v_l1_old    uuid;
  v_kept      uuid;
  v_replaced  int := 0;
begin
  select tenant_id, channel_slug into v_tenant, v_channel
    from agent_runs where id = p_run_id;

  if v_tenant is null then
    return jsonb_build_object('inserted', 0, 'metrics', 0, 'stale_accepted', 0,
                              'stale_dropped', 0, 'skipped_reason', 'no_run');
  end if;
  if p_tenant_id is distinct from v_tenant then
    raise exception 'record_channel_run_actions: run % belongs to tenant %, not %',
      p_run_id, v_tenant, p_tenant_id using errcode = 'P0001';
  end if;
  if v_channel is null then
    return jsonb_build_object('inserted', 0, 'metrics', 0, 'stale_accepted', 0,
                              'stale_dropped', 0, 'skipped_reason', 'unstamped_run');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('channel_card:' || v_tenant || ':' || v_channel, 0));

  if jsonb_typeof(p_actions) = 'array' then
    v_n := jsonb_array_length(p_actions);
    for v_a, v_ord in select e, o from jsonb_array_elements(p_actions) with ordinality as t(e, o)
    loop
      exit when v_ord > 20;
      if nullif(trim(v_a->>'title'), '') is null or jsonb_typeof(v_a->'body') is distinct from 'object' then
        continue;
      end if;
      if (v_a->>'redo_of') ~* '^[0-9a-f-]{36}$' then
        continue;
      end if;
      v_pos := case when jsonb_typeof(v_a->'position') = 'number'
                     and (v_a->>'position')::numeric >= 1
                    then (v_a->>'position')::numeric::int else v_ord::int end;
      if exists (select 1 from channel_actions where run_id = p_run_id and tenant_id = v_tenant and position = v_pos) then
        continue;
      end if;
      v_tkey := left(nullif(trim(v_a->>'target_key'), ''), 300);
      v_want := null;
      if (v_a->>'repeat_of') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        v_want := (v_a->>'repeat_of')::uuid;
      end if;
      v_judged := null;
      if jsonb_typeof(v_a->'judged_ids') = 'array' then
        select coalesce(array_agg(e::uuid), '{}'::uuid[]) into v_judged
          from jsonb_array_elements_text(v_a->'judged_ids') as j(e)
         where e ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
      end if;
      if v_judged is not null and v_tkey is not null and exists (
           select 1 from channel_actions
            where tenant_id = v_tenant
              and channel_slug = v_channel
              and status in ('pending', 'snoozed')
              and target_key = v_tkey
              and run_id <> p_run_id
              and not (id = any(v_judged))
              and id is distinct from v_want) then
        v_rematch := v_rematch || to_jsonb(v_pos);
        continue;
      end if;
      if v_want is not null and v_a->'repeat_matched' = 'true'::jsonb then
        v_rstatus := null;
        select status into v_rstatus from channel_actions
         where id = v_want and tenant_id = v_tenant and channel_slug = v_channel
         for update;
        if v_rstatus is not null and v_rstatus not in ('pending', 'snoozed') then
          v_rematch := v_rematch || to_jsonb(v_pos);
        end if;
      end if;
    end loop;
    if jsonb_array_length(v_rematch) > 0 then
      return jsonb_build_object('rematch', true, 'positions', v_rematch);
    end if;
  end if;

  if jsonb_typeof(p_metrics) = 'array' then
    for v_m, v_ord in select e, o from jsonb_array_elements(p_metrics) with ordinality as t(e, o)
    loop
      if v_ord > 12 then v_m_dropped := v_m_dropped + 1; continue; end if;
      v_key := nullif(trim(v_m->>'key'), '');
      if v_key is null or char_length(v_key) > 80
         or jsonb_typeof(v_m->'value') is distinct from 'number'
         or nullif(trim(v_m->>'source'), '') is null then
        v_m_dropped := v_m_dropped + 1;
        continue;
      end if;
      v_wk := coalesce(v_m->>'window_kind', 'point');
      if v_wk not in ('point','day','rolling_7d','rolling_30d') then v_wk := 'point'; end if;

      insert into channel_metrics
        (tenant_id, channel_slug, metric_key, value, unit, window_kind, day,
         source, grounded, run_id)
      values
        (v_tenant, v_channel, v_key, (v_m->>'value')::numeric,
         left(nullif(trim(v_m->>'unit'), ''), 24), v_wk, v_day,
         left(trim(v_m->>'source'), 200),
         coalesce((v_m->>'grounded')::boolean, false), p_run_id)
      on conflict (tenant_id, channel_slug, metric_key, window_kind, day) do update
        set value = excluded.value, unit = excluded.unit, source = excluded.source,
            grounded = excluded.grounded, run_id = excluded.run_id;
      v_metrics := v_metrics + 1;

      if coalesce((v_m->>'grounded')::boolean, false) then
        v_baseline := v_baseline || jsonb_build_object(v_key, jsonb_build_object(
          'value', (v_m->>'value')::numeric, 'window_kind', v_wk, 'day', v_day));
      end if;
    end loop;
  end if;

  if jsonb_typeof(p_stale) = 'array' then
    for v_s, v_ord in select e, o from jsonb_array_elements(p_stale) with ordinality as t(e, o)
    loop
      v_evidence := left(nullif(trim(v_s->>'evidence'), ''), 1000);
      v_target := null;
      if v_ord <= 30 and v_evidence is not null
         and (v_s->>'action_id') ~* '^[0-9a-f-]{36}$' then
        update channel_actions
           set status = 'stale', status_at = now(), note = v_evidence
         where id = (v_s->>'action_id')::uuid
           and tenant_id = v_tenant
           and channel_slug = v_channel
           and status in ('pending', 'snoozed')
           and exec_status is distinct from 'queued'
           and exec_status is distinct from 'dispatching'
           and (status = 'pending' or snoozed_until is null or snoozed_until <= now())
           and exec_class is null
           and edited_body is null
           and steps_done = '[]'::jsonb
        returning id into v_target;
      end if;
      if v_target is null then
        v_st_drop := v_st_drop + 1;
        if (v_s->>'action_id') ~* '^[0-9a-f-]{36}$' and exists (
             select 1 from channel_actions
              where id = (v_s->>'action_id')::uuid
                and tenant_id = v_tenant and channel_slug = v_channel
                and status in ('pending', 'snoozed')) then
          v_kept_open := v_kept_open || (v_s->>'action_id')::uuid;
        end if;
        continue;
      end if;
      v_retired_here := v_retired_here || v_target;
      insert into channel_action_events
        (tenant_id, action_id, event, actor_kind, run_id, note, event_key)
      values
        (v_tenant, v_target, 'stale_flagged', 'channel_run', p_run_id, v_evidence,
         'stale:' || p_run_id)
      on conflict (action_id, event_key) do nothing;
      v_st_ok := v_st_ok + 1;
    end loop;
  end if;

  if jsonb_typeof(p_actions) = 'array' then
    v_n := jsonb_array_length(p_actions);
    for v_a, v_ord in select e, o from jsonb_array_elements(p_actions) with ordinality as t(e, o)
    loop
      if v_ord > 20 then v_skipped := v_skipped + 1; continue; end if;
      v_title := left(nullif(trim(v_a->>'title'), ''), 300);
      if v_title is null or jsonb_typeof(v_a->'body') is distinct from 'object' then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      v_type := v_a->>'action_type';
      if v_type is null or v_type not in (
           'text_post','image_post','video_post','reply','send_message',
           'create_ad','update_ad','pause_ad','fix','check','setup','page','other') then
        v_type := 'other';
        v_coerced := v_coerced + 1;
      end if;

      v_pos := case when jsonb_typeof(v_a->'position') = 'number'
                     and (v_a->>'position')::numeric >= 1
                    then (v_a->>'position')::numeric::int else v_ord::int end;
      v_of  := case when jsonb_typeof(v_a->'run_of') = 'number'
                     and (v_a->>'run_of')::numeric >= 1
                    then (v_a->>'run_of')::numeric::int else greatest(v_n, 1) end;

      v_reason := left(nullif(trim(v_a->>'impact_reason'), ''), 240);
      v_impact := case when jsonb_typeof(v_a->'impact') = 'number'
                        and (v_a->>'impact')::numeric between 1 and 5
                        and v_reason is not null
                       then (v_a->>'impact')::numeric::int end;
      if v_impact is null then v_reason := null; end if;

      v_repeat := null;
      if (v_a->>'repeat_of') ~* '^[0-9a-f-]{36}$' then
        select id into v_repeat from channel_actions
         where id = (v_a->>'repeat_of')::uuid
           and tenant_id = v_tenant and channel_slug = v_channel;
      end if;
      if v_repeat is not null and v_repeat = any(v_kept_open) then
        v_refused := v_refused + 1;
        continue;
      end if;
      v_redo := null;
      if (v_a->>'redo_of') ~* '^[0-9a-f-]{36}$' then
        select id into v_redo from channel_actions
         where id = (v_a->>'redo_of')::uuid
           and tenant_id = v_tenant and channel_slug = v_channel;
      end if;

      v_tkey := left(nullif(trim(v_a->>'target_key'), ''), 300);
      v_title_key := coalesce(nullif(v_a->>'title_key', ''),
                              lower(regexp_replace(v_title, '\s+', ' ', 'g')));
      v_l1 := '{}';
      v_kept := null;
      if v_redo is null and (v_a->>'redo_of') is null
         and not exists (select 1 from channel_actions where run_id = p_run_id and tenant_id = v_tenant and position = v_pos) then
        if v_repeat is not null and not (v_repeat = any(v_retired_here)) then
          select status,
                 ((status = 'pending' or snoozed_until is null or snoozed_until <= now())
                  and (exec_status is null
                       or (exec_status = 'failed'
                           and coalesce(exec_result->>'code', '') not in ('exec_partial', 'exec_outcome_unknown')
                           and not (coalesce(exec_result, '{}'::jsonb) ? 'interrupted')
                           and not (coalesce(exec_result, '{}'::jsonb) ? 'lease_expired')))
                  and coalesce(exec_result->>'bucket', '') <> 'partial_risk'
                  and edited_body is null
                  and steps_done = '[]'::jsonb)
            into v_rstatus, v_untouched
            from channel_actions
           where id = v_repeat
             and tenant_id = v_tenant
             and channel_slug = v_channel
           for update;
          if v_rstatus in ('pending', 'snoozed')
             and (not v_untouched or v_a->'repeat_matched' = 'true'::jsonb) then
            v_kept := v_repeat;
          end if;
        end if;
        if v_kept is null and v_tkey is not null then
          for v_l1_old, v_untouched in
            select id,
                   ((status = 'pending' or snoozed_until is null or snoozed_until <= now())
                    and exec_status is distinct from 'queued'
                    and exec_status is distinct from 'dispatching'
                    and edited_body is null
                    and steps_done = '[]'::jsonb)
              from channel_actions
             where tenant_id = v_tenant
               and channel_slug = v_channel
               and status in ('pending', 'snoozed')
               and target_key = v_tkey and action_type = v_type and title_key = v_title_key
               and exec_class is null
               and run_id <> p_run_id
               and id is distinct from v_repeat
             order by proposed_at desc, id desc
             for update
          loop
            if not v_untouched then
              v_kept := v_l1_old;
              exit;
            end if;
            v_l1 := v_l1 || v_l1_old;
          end loop;
        end if;
        if v_kept is not null then
          v_refused := v_refused + 1;
          v_ids := v_ids || jsonb_build_object('position', v_pos, 'id', v_kept, 'kept', true);
          continue;
        end if;
        if cardinality(v_l1) > 0 then
          with retired as (
            update channel_actions
               set status = 'stale', status_at = now(),
                   note = left('Replaced by a newer version: ' || v_title, 1000)
             where id = any(v_l1)
               and tenant_id = v_tenant
               and channel_slug = v_channel
               and status in ('pending', 'snoozed')
               and exec_status is distinct from 'queued'
               and exec_status is distinct from 'dispatching'
               and (status = 'pending' or snoozed_until is null or snoozed_until <= now())
               and exec_class is null
               and edited_body is null
               and steps_done = '[]'::jsonb
            returning id, proposed_at
          )
          select coalesce(array_agg(id order by proposed_at desc, id desc), '{}'::uuid[]) into v_l1 from retired;
          v_repeat := coalesce(v_repeat, v_l1[1]);
        end if;
      end if;

      v_kind    := nullif(trim(v_a->>'card_kind'), '');
      v_primary := left(nullif(trim(v_a->>'primary_label'), ''), 60);
      v_done    := left(nullif(trim(v_a->>'done_label'), ''), 60);
      v_howto   := v_a->'how_to';
      if v_kind is null or v_kind not in ('executes','post','plan','message','ad_manual','copy_to_site','task')
         or v_primary is null or v_done is null then
        v_kind := null; v_primary := null; v_done := null;
      end if;
      if jsonb_typeof(v_howto) is distinct from 'array' or jsonb_array_length(v_howto) > 12 then
        v_howto := '[]'::jsonb;
      end if;

      insert into channel_actions
        (tenant_id, channel_slug, run_id, position, run_of, blocking, action_type,
         title, title_key, body, repeat_of, redo_of, baseline_metrics,
         impact, impact_reason, score, score_inputs, score_version, scored_at,
         card_kind, primary_label, done_label, how_to, target_key)
      values
        (v_tenant, v_channel, p_run_id, v_pos, v_of,
         coalesce((v_a->>'blocking')::boolean, false), v_type,
         v_title,
         coalesce(nullif(v_a->>'title_key', ''),
                  lower(regexp_replace(v_title, '\s+', ' ', 'g'))),
         v_a->'body', v_repeat, v_redo, v_baseline,
         v_impact, v_reason,
         case when jsonb_typeof(v_a->'score') = 'number'
              then greatest(0, least(100, (v_a->>'score')::numeric)) else 0 end,
         case when jsonb_typeof(v_a->'score_inputs') = 'object'
              then v_a->'score_inputs' else '{}'::jsonb end,
         case when jsonb_typeof(v_a->'score_version') = 'number'
              then (v_a->>'score_version')::numeric::smallint else 1 end,
         now(),
         v_kind, v_primary, v_done, v_howto, v_tkey)
      on conflict (run_id, position) do nothing
      returning id into v_id;

      if v_id is null then
        select id into v_id from channel_actions
         where run_id = p_run_id and position = v_pos;
      else
        v_inserted := v_inserted + 1;
        insert into channel_action_events
          (tenant_id, action_id, event, actor_kind, run_id, event_key)
        values
          (v_tenant, v_id, 'proposed', 'channel_run', p_run_id, 'proposed:' || p_run_id)
        on conflict (action_id, event_key) do nothing;
        foreach v_l1_old in array v_l1
        loop
          insert into channel_action_events
            (tenant_id, action_id, event, actor_kind, run_id, note, event_key)
          values
            (v_tenant, v_l1_old, 'stale_flagged', 'channel_run', p_run_id,
             left('Replaced by a newer version: ' || v_title, 1000), 'replaced:' || v_id)
          on conflict (action_id, event_key) do nothing;
          v_replaced := v_replaced + 1;
        end loop;
      end if;
      v_ids := v_ids || jsonb_build_object('position', v_pos, 'id', v_id);
      v_id := null;
    end loop;
  end if;

  return jsonb_build_object(
    'inserted', v_inserted,
    'metrics', v_metrics,
    'stale_accepted', v_st_ok,
    'stale_dropped', v_st_drop,
    'skipped', v_skipped,
    'coerced', v_coerced,
    'metrics_dropped', v_m_dropped,
    'replacements_refused', v_refused,
    'replaced', v_replaced,
    'ids', v_ids
  );
end $$;

revoke all on function record_channel_run_actions(uuid, uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function record_channel_run_actions(uuid, uuid, jsonb, jsonb, jsonb)
  to service_role;

create or replace function list_open_card_channels(p_after_tenant uuid, p_after_channel text, p_limit int)
returns table (tenant_id uuid, channel_slug text, open_count int, keyless_count int)
language sql stable security definer set search_path = public, pg_temp as $$
  select a.tenant_id, a.channel_slug, count(*)::int, (count(*) filter (where a.target_key is null))::int
    from channel_actions a
   where a.status in ('pending', 'snoozed')
     and (p_after_tenant is null
          or (a.tenant_id, a.channel_slug) > (p_after_tenant, coalesce(p_after_channel, '')))
   group by a.tenant_id, a.channel_slug
   order by a.tenant_id, a.channel_slug
   limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

create or replace function stamp_channel_action_target_keys(p_tenant_id uuid, p_pairs jsonb)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n int;
begin
  if p_tenant_id is null or jsonb_typeof(p_pairs) is distinct from 'array' then
    raise exception 'stamp_channel_action_target_keys: tenant and a pairs array are required';
  end if;
  if jsonb_array_length(p_pairs) > 1000 then
    raise exception 'stamp_channel_action_target_keys: at most 1000 pairs per call';
  end if;
  with p as (
    select (e->>'id')::uuid as id, left(nullif(trim(e->>'target_key'), ''), 300) as k
      from jsonb_array_elements(p_pairs) as x(e)
     where (e->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ), u as (
    update channel_actions a
       set target_key = p.k
      from p
     where a.id = p.id
       and a.tenant_id = p_tenant_id
       and a.target_key is null
       and p.k is not null
    returning 1
  )
  select count(*)::int into v_n from u;
  return v_n;
end $$;

create or replace function chain_channel_action_repeat(p_tenant_id uuid, p_old_id uuid, p_new_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_channel text;
  v_old     channel_actions%rowtype;
  v_new     channel_actions%rowtype;
  v_status  text;
begin
  if p_tenant_id is null or p_old_id is null or p_new_id is null or p_old_id = p_new_id then
    return jsonb_build_object('ok', false, 'code', 'invalid');
  end if;
  select channel_slug into v_channel from channel_actions where id = p_new_id and tenant_id = p_tenant_id;
  if v_channel is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('channel_card:' || p_tenant_id || ':' || v_channel, 0));
  perform 1 from channel_actions
   where id in (p_old_id, p_new_id) and tenant_id = p_tenant_id
   order by id
   for update;
  select * into v_new from channel_actions where id = p_new_id and tenant_id = p_tenant_id;
  select * into v_old from channel_actions where id = p_old_id and tenant_id = p_tenant_id;
  if v_old.id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_old.channel_slug is distinct from v_channel then
    return jsonb_build_object('ok', false, 'code', 'cross_channel');
  end if;
  if v_old.status = 'stale' and exists (
       select 1 from channel_action_events
        where action_id = p_old_id and tenant_id = p_tenant_id and event_key = 'replaced:' || p_new_id) then
    return jsonb_build_object('ok', true, 'replayed', true);
  end if;
  if v_new.status not in ('pending', 'snoozed') then
    return jsonb_build_object('ok', false, 'code', 'new_not_open');
  end if;
  if v_old.status not in ('pending', 'snoozed') then
    return jsonb_build_object('ok', false, 'code', 'old_not_open');
  end if;
  if (v_old.proposed_at, v_old.id) >= (v_new.proposed_at, v_new.id) then
    return jsonb_build_object('ok', false, 'code', 'not_newer');
  end if;
  if v_old.repeat_of = p_new_id then
    return jsonb_build_object('ok', false, 'code', 'cycle');
  end if;

  with retired as (update channel_actions set status = 'stale', status_at = now(), note = left('Replaced by a newer version: ' || v_new.title, 1000) where id = p_old_id and tenant_id = p_tenant_id and channel_slug = v_channel and status in ('pending', 'snoozed') and (status = 'pending' or snoozed_until is null or snoozed_until <= now()) and (exec_status is null or (exec_status = 'failed' and coalesce(exec_result->>'code', '') not in ('exec_partial', 'exec_outcome_unknown') and not (coalesce(exec_result, '{}'::jsonb) ? 'interrupted') and not (coalesce(exec_result, '{}'::jsonb) ? 'lease_expired'))) and coalesce(exec_result->>'bucket', '') <> 'partial_risk' and edited_body is null and steps_done = '[]'::jsonb returning id) update channel_actions set repeat_of = p_old_id where id = p_new_id and tenant_id = p_tenant_id and repeat_of is null and exists (select 1 from retired);

  select status into v_status from channel_actions where id = p_old_id and tenant_id = p_tenant_id;
  if v_status is distinct from 'stale' then
    return jsonb_build_object('ok', false, 'code', 'touched');
  end if;
  insert into channel_action_events
    (tenant_id, action_id, event, actor_kind, run_id, note, event_key)
  values
    (p_tenant_id, p_old_id, 'stale_flagged', 'system', null,
     left('Replaced by a newer version: ' || v_new.title, 1000), 'replaced:' || p_new_id)
  on conflict (action_id, event_key) do nothing;
  return jsonb_build_object('ok', true, 'replayed', false,
                            'chained', (select repeat_of = p_old_id from channel_actions where id = p_new_id and tenant_id = p_tenant_id));
end $$;

revoke all on function list_open_card_channels(uuid, text, int) from public, anon, authenticated;
grant execute on function list_open_card_channels(uuid, text, int) to service_role;
revoke all on function stamp_channel_action_target_keys(uuid, jsonb) from public, anon, authenticated;
grant execute on function stamp_channel_action_target_keys(uuid, jsonb) to service_role;
revoke all on function chain_channel_action_repeat(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function chain_channel_action_repeat(uuid, uuid, uuid) to service_role;

commit;
