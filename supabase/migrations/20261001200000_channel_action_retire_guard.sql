
begin;

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
         card_kind, primary_label, done_label, how_to)
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
         v_kind, v_primary, v_done, v_howto)
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
    'ids', v_ids
  );
end $$;

revoke all on function record_channel_run_actions(uuid, uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function record_channel_run_actions(uuid, uuid, jsonb, jsonb, jsonb)
  to service_role;

commit;
