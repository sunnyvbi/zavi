
begin;

create table channel_actions (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  channel_slug     text not null,
  run_id           uuid not null references agent_runs(id) on delete cascade,
  position         int  not null check (position >= 1),
  run_of           int  not null check (run_of >= 1),
  blocking         boolean not null default false,
  action_type      text not null check (action_type in (
                     'text_post','image_post','video_post','reply','send_message',
                     'create_ad','update_ad','pause_ad','fix','check','setup','page','other')),
  title            text not null check (char_length(title) between 1 and 300),
  title_key        text not null,
  body             jsonb not null,
  status           text not null default 'pending'
                     check (status in ('pending','acted','rejected','snoozed','redone','stale')),
  status_at        timestamptz,
  note             text check (note is null or char_length(note) <= 1000),
  snoozed_until    timestamptz,
  repeat_of        uuid references channel_actions(id) on delete set null,
  redo_of          uuid references channel_actions(id) on delete set null,
  baseline_metrics jsonb not null default '{}',
  impact           smallint check (impact between 1 and 5),
  impact_reason    text check (impact_reason is null or char_length(impact_reason) <= 240),
  score            numeric not null default 0,
  score_inputs     jsonb not null default '{}',
  score_version    smallint not null default 1,
  scored_at        timestamptz,
  proposed_at      timestamptz not null default now(),
  exec_class         text,
  exec_payload       jsonb,
  exec_status        text check (exec_status in ('queued','dispatching','executed','failed')),
  exec_result        jsonb,
  executed_at        timestamptz,
  approved_by        uuid,
  approved_by_source text,
  edited_body        jsonb,
  unique (run_id, position),
  unique (tenant_id, id)
);

create table channel_action_events (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references tenants(id) on delete cascade,
  action_id     uuid not null references channel_actions(id) on delete cascade,
  event         text not null check (event in (
                  'proposed','acted','rejected','snoozed','redo_requested','redone','stale_flagged',
                  'revised','approved','executed','exec_failed')),
  actor_kind    text not null check (actor_kind in ('founder','channel_run','system')),
  actor_user_id uuid,
  run_id        uuid,
  note          text check (note is null or char_length(note) <= 1000),
  event_key     text not null check (char_length(event_key) between 1 and 200),
  event_version smallint not null default 1,
  at            timestamptz not null default now(),
  unique (action_id, event_key)
);

create table channel_metrics (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  channel_slug   text not null,
  metric_key     text not null check (char_length(metric_key) between 1 and 80),
  value          numeric not null,
  unit           text check (unit is null or char_length(unit) <= 24),
  window_kind    text not null default 'point'
                   check (window_kind in ('point','day','rolling_7d','rolling_30d')),
  day            date not null,
  source         text not null check (char_length(source) between 1 and 200),
  grounded       boolean not null,
  run_id         uuid not null references agent_runs(id) on delete cascade,
  schema_version smallint not null default 1,
  unique (tenant_id, channel_slug, metric_key, window_kind, day)
);

alter table channel_actions       enable row level security;
alter table channel_action_events enable row level security;
alter table channel_metrics       enable row level security;

create policy channel_actions_member_select on channel_actions
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = channel_actions.tenant_id
    )
  );
create policy channel_actions_active_tenant_restrict
  on channel_actions as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

create policy channel_action_events_member_select on channel_action_events
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = channel_action_events.tenant_id
    )
  );
create policy channel_action_events_active_tenant_restrict
  on channel_action_events as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

create policy channel_metrics_member_select on channel_metrics
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = channel_metrics.tenant_id
    )
  );
create policy channel_metrics_active_tenant_restrict
  on channel_metrics as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

create view channel_runs with (security_invoker = true) as
select r.id            as run_id,
       r.tenant_id,
       r.channel_slug,
       r.agent_slug    as executor,
       r.trigger,
       r.status,
       r.cost_usd,
       r.enqueued_at,
       r.started_at,
       r.finished_at,
       md5(r.payload->>'recipe_body')      as recipe_hash,
       r.payload->>'redo_of_action_id'     as redo_of_action_id
  from agent_runs r
 where r.channel_slug is not null;

revoke all on channel_runs from anon;

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
      v_redo := null;
      if (v_a->>'redo_of') ~* '^[0-9a-f-]{36}$' then
        select id into v_redo from channel_actions
         where id = (v_a->>'redo_of')::uuid
           and tenant_id = v_tenant and channel_slug = v_channel;
      end if;

      insert into channel_actions
        (tenant_id, channel_slug, run_id, position, run_of, blocking, action_type,
         title, title_key, body, repeat_of, redo_of, baseline_metrics,
         impact, impact_reason, score, score_inputs, score_version, scored_at)
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
         now())
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
        returning id into v_target;
      end if;
      if v_target is null then
        v_st_drop := v_st_drop + 1;
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

  return jsonb_build_object(
    'inserted', v_inserted,
    'metrics', v_metrics,
    'stale_accepted', v_st_ok,
    'stale_dropped', v_st_drop,
    'skipped', v_skipped,
    'coerced', v_coerced,
    'metrics_dropped', v_m_dropped,
    'ids', v_ids
  );
end $$;

create or replace function set_channel_action(
  p_tenant_id     uuid,
  p_action_id     uuid,
  p_status        text,
  p_note          text,
  p_snoozed_until timestamptz,
  p_event_key     text,
  p_actor_user_id uuid default null
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
           note          = coalesce(v_note, note),
           snoozed_until = case when p_status = 'snoozed' then p_snoozed_until else null end
     where id = p_action_id;
  else
    update channel_actions set note = v_note where id = p_action_id;
  end if;

  insert into channel_action_events
    (tenant_id, action_id, event, actor_kind, actor_user_id, note, event_key)
  values
    (p_tenant_id, p_action_id, p_status, 'founder', p_actor_user_id, v_note, v_key);

  return jsonb_build_object(
    'ok', true, 'replayed', false,
    'status', case when p_status = 'redo_requested' then v_row.status else p_status end);
end $$;

create or replace function mark_channel_action_redone(
  p_tenant_id     uuid,
  p_old_action_id uuid,
  p_new_action_id uuid,
  p_note          text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old channel_actions%rowtype;
  v_new channel_actions%rowtype;
  v_key text := 'redone:' || p_new_action_id;
begin
  if p_tenant_id is null or p_old_action_id is null or p_new_action_id is null
     or p_old_action_id = p_new_action_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  select * into v_old from channel_actions where id = p_old_action_id for update;
  select * into v_new from channel_actions where id = p_new_action_id;
  if v_old.id is null or v_new.id is null
     or v_old.tenant_id is distinct from p_tenant_id
     or v_new.tenant_id is distinct from p_tenant_id
     or v_old.channel_slug is distinct from v_new.channel_slug then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if exists (select 1 from channel_action_events
              where action_id = p_old_action_id and event_key = v_key) then
    return jsonb_build_object('ok', true, 'replayed', true);
  end if;
  if v_old.exec_status in ('queued', 'dispatching') then
    return jsonb_build_object('ok', false, 'code', 'exec_in_flight',
                              'exec_status', v_old.exec_status);
  end if;
  if v_old.status not in ('pending', 'snoozed') then
    return jsonb_build_object('ok', false, 'code', 'illegal_transition',
                              'from', v_old.status, 'to', 'redone');
  end if;

  update channel_actions
     set status = 'redone', status_at = now(),
         note = coalesce(left(nullif(trim(p_note), ''), 1000), note)
   where id = p_old_action_id;
  update channel_actions set redo_of = p_old_action_id
   where id = p_new_action_id and redo_of is null;

  insert into channel_action_events
    (tenant_id, action_id, event, actor_kind, run_id, note, event_key)
  values
    (p_tenant_id, p_old_action_id, 'redone', 'channel_run', v_new.run_id,
     left(nullif(trim(p_note), ''), 1000), v_key);

  return jsonb_build_object('ok', true, 'replayed', false);
end $$;

revoke all on function record_channel_run_actions(uuid, uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function record_channel_run_actions(uuid, uuid, jsonb, jsonb, jsonb)
  to service_role;

revoke all on function set_channel_action(uuid, uuid, text, text, timestamptz, text, uuid)
  from public, anon, authenticated;
grant execute on function set_channel_action(uuid, uuid, text, text, timestamptz, text, uuid)
  to service_role;

revoke all on function mark_channel_action_redone(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function mark_channel_action_redone(uuid, uuid, uuid, text)
  to service_role;

commit;
