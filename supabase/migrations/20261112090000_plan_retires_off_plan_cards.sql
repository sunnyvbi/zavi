
begin;

set lock_timeout = '5s';

alter table public.channel_actions add column if not exists founder_touched_at timestamptz default 'epoch';
alter table public.channel_actions alter column founder_touched_at drop default;
comment on column public.channel_actions.founder_touched_at is
  'First time a person changed the draft, the ticked steps or the post date. Never cleared. Set by trigger channel_actions_founder_touch. epoch = filed before tracking existed (treated as touched).';

create or replace function channel_actions_founder_touch() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.founder_touched_at is null and (
       new.edited_body is distinct from old.edited_body
    or new.steps_done is distinct from old.steps_done
    or (new.body->'step'->'publish_on') is distinct from (old.body->'step'->'publish_on')
  ) then
    new.founder_touched_at := now();
  end if;
  return new;
end $$;
revoke all on function channel_actions_founder_touch() from public, anon, authenticated;

drop trigger if exists channel_actions_founder_touch on public.channel_actions;
create trigger channel_actions_founder_touch
  before update of edited_body, steps_done, body on public.channel_actions
  for each row execute function channel_actions_founder_touch();

do $$
begin
  if to_regclass('lab.channel_actions') is not null then
    alter table lab.channel_actions add column if not exists founder_touched_at timestamptz;
  end if;
end $$;

create or replace function card_copy_key(p_text text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select left(btrim(regexp_replace(lower(coalesce(p_text, '')),
    '[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'), ' '), 60)
$$;
revoke all on function card_copy_key(text) from public, anon, authenticated;
grant execute on function card_copy_key(text) to service_role;

create or replace function close_off_plan_cards(
  p_tenant_id uuid, p_plan_id uuid, p_channels text[], p_run_id uuid
) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_note     constant text :=
    'Your growth plan no longer includes this channel, so Zavi closed this suggestion. '
    'Add the channel to your plan on the Growth page to get new suggestions here.';
  v_channel  text;
  v_ids      uuid[];
  v_id       uuid;
  v_n        int := 0;
begin
  for v_channel in
    select distinct x from unnest(coalesce(p_channels, '{}'::text[])) x where nullif(trim(x), '') is not null order by x
  loop
    perform pg_advisory_xact_lock(hashtextextended('channel_card:' || p_tenant_id || ':' || v_channel, 0));

    with retired as (
      update channel_actions c
         set status = 'stale', status_at = now(), note = v_note
       where c.tenant_id = p_tenant_id
         and c.channel_slug = v_channel
         and (p_run_id is null or c.run_id = p_run_id)
         and c.status = 'pending'
         and c.exec_status is null
         and c.exec_class is null
         and c.approved_by is null
         and c.edited_body is null
         and coalesce(c.steps_done, '[]'::jsonb) = '[]'::jsonb
         and c.exec_claim_id is null
         and c.approval_envelope is null
         and c.cgo_hold is null
         and c.redo_of is null
         and c.founder_touched_at is null
         and not exists (
           select 1 from decisions d
            where d.tenant_id = p_tenant_id
              and d.agent_run_id = c.run_id
              and d.decision_class = 'social.publish.v2'
              and d.status = 'proposed'
              and d.superseded_at is null
              and card_copy_key(c.body->'step'->'deliverable'->>'content') <> ''
              and card_copy_key(d.body->'payload'->>'text') <> ''
              and (starts_with(card_copy_key(c.body->'step'->'deliverable'->>'content'), card_copy_key(d.body->'payload'->>'text'))
                or starts_with(card_copy_key(d.body->'payload'->>'text'), card_copy_key(c.body->'step'->'deliverable'->>'content')))
         )
         and exists (
           select 1 from growth_plan gp
            where gp.id = p_plan_id and gp.tenant_id = p_tenant_id and gp.status = 'live'
         )
         and not exists (
           select 1 from tenant_channels tc
            where tc.tenant_id = p_tenant_id
              and lower(trim(tc.channel_slug)) = lower(trim(c.channel_slug))
              and (tc.plan_selected or tc.autorun_set_by = 'founder')
         )
         and not exists (
           select 1 from channel_action_events e
            where e.action_id = c.id and e.tenant_id = p_tenant_id
              and e.actor_kind = 'founder'
         )
         and exists (
           select 1 from agent_runs r
            where r.id = c.run_id
              and r.tenant_id = p_tenant_id
              and r.trigger = 'channel_recipe'
              and r.enqueued_by is null
              and (r.cron_dedupe_key = 'first-run-preview:' || p_tenant_id || ':' || r.agent_slug
                or r.cron_dedupe_key = 'first-run-preview-done:' || p_tenant_id || ':' || r.agent_slug
                or r.cron_dedupe_key = 'first-run:' || p_tenant_id
                or r.cron_dedupe_key like 'channel:' || p_tenant_id || ':' || v_channel || ':%')
         )
      returning c.id
    )
    select coalesce(array_agg(id), '{}'::uuid[]) into v_ids from retired;

    foreach v_id in array v_ids
    loop
      insert into channel_action_events
        (tenant_id, action_id, event, actor_kind, note, event_key)
      values
        (p_tenant_id, v_id, 'stale_flagged', 'system', v_note, 'plan_off:' || p_plan_id)
      on conflict (action_id, event_key) do nothing;
    end loop;
    v_n := v_n + cardinality(v_ids);
  end loop;

  if v_n > 0 then
    begin
      insert into praxis_logs (level, source, code, message, tenant_id, meta)
      values ('info', 'commit_growth_plan', 'growth_plan.retired_off_plan_cards',
              'workspace ' || p_tenant_id || ': closed ' || v_n || ' untouched cards on channels the plan dropped',
              null, jsonb_build_object('tenant_id', p_tenant_id, 'plan_id', p_plan_id, 'cards', v_n,
                                       'channels', p_channels, 'run_id', p_run_id));
    exception when others then
      raise warning 'close_off_plan_cards: closed % cards but could not log it (%)', v_n, sqlerrm;
    end;
  end if;
  return v_n;
end $$;

revoke all on function close_off_plan_cards(uuid, uuid, text[], uuid) from public, anon, authenticated;
grant execute on function close_off_plan_cards(uuid, uuid, text[], uuid) to service_role;

create or replace function retire_cards_off_plan(p_tenant_id uuid, p_plan_id uuid, p_was_selected text[])
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_timeout  text := current_setting('lock_timeout');
  v_dropped  text[];
  v_n        int;
begin
  if p_tenant_id is null or p_plan_id is null then
    return 0;
  end if;
  if not exists (
    select 1 from growth_plan
     where id = p_plan_id and tenant_id = p_tenant_id and status = 'live'
  ) then
    return 0;
  end if;
  if cardinality(coalesce(p_was_selected, '{}'::text[])) = 0
     or not exists (select 1 from tenant_channels where tenant_id = p_tenant_id and plan_selected) then
    return 0;
  end if;

  select coalesce(array_agg(distinct w), '{}'::text[]) into v_dropped
    from unnest(p_was_selected) w
   where not exists (
     select 1 from tenant_channels tc
      where tc.tenant_id = p_tenant_id
        and lower(trim(tc.channel_slug)) = lower(trim(w))
        and (tc.plan_selected or tc.autorun_set_by = 'founder')
   );
  if cardinality(v_dropped) = 0 then
    return 0;
  end if;

  perform set_config('lock_timeout', '5s', true);
  v_n := close_off_plan_cards(p_tenant_id, p_plan_id, v_dropped, null);
  perform set_config('lock_timeout', v_timeout, true);
  return v_n;
end $$;

revoke all on function retire_cards_off_plan(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function retire_cards_off_plan(uuid, uuid, text[]) to service_role;

create or replace function close_dropped_channel_run_cards(p_tenant_id uuid, p_run_id uuid)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run      agent_runs%rowtype;
  v_channel  text;
  v_plan     uuid;
  v_timeout  text := current_setting('lock_timeout');
  v_n        int;
begin
  if p_tenant_id is null or p_run_id is null then
    return 0;
  end if;
  select * into v_run from agent_runs
   where id = p_run_id and tenant_id = p_tenant_id
     and trigger = 'channel_recipe' and enqueued_by is null
     and cron_dedupe_key like 'channel:' || p_tenant_id || ':%';
  if not found then
    return 0;
  end if;
  v_channel := split_part(substr(v_run.cron_dedupe_key, length('channel:' || p_tenant_id || ':') + 1), ':', 1);
  if nullif(v_channel, '') is null then
    return 0;
  end if;

  select id into v_plan from growth_plan where tenant_id = p_tenant_id and status = 'live';
  if v_plan is null
     or not exists (select 1 from growth_plan o where o.tenant_id = p_tenant_id and o.created_at < v_run.enqueued_at)
     or exists (
       select 1 from tenant_channels tc
        where tc.tenant_id = p_tenant_id
          and lower(trim(tc.channel_slug)) = lower(trim(v_channel))
          and (tc.plan_selected or tc.autorun_set_by = 'founder')
     ) then
    return 0;
  end if;

  perform set_config('lock_timeout', '5s', true);
  v_n := close_off_plan_cards(p_tenant_id, v_plan, array[v_channel], p_run_id);
  perform set_config('lock_timeout', v_timeout, true);
  return v_n;
end $$;

revoke all on function close_dropped_channel_run_cards(uuid, uuid) from public, anon, authenticated;
grant execute on function close_dropped_channel_run_cards(uuid, uuid) to service_role;

create or replace function commit_growth_plan(
  p_tenant_id             uuid,
  p_objective             text,
  p_target_metric         text,
  p_constraint_statement  text,
  p_constraint_confidence text,
  p_bets                  jsonb,
  p_basis_evidence        jsonb,
  p_actor_kind            text,
  p_actor_ref             text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_plan_id   uuid;
  v_bet       jsonb;
  v_slug      text;
  v_i         int := 0;
  v_slugs     text[] := array[]::text[];
  v_autorun   boolean;
  v_prev_set  text;
  v_was       text[];
begin
  if p_tenant_id is null then
    return null;
  end if;

  if (
    select count(*)
      from jsonb_array_elements(coalesce(p_bets, '[]'::jsonb)) b
     where nullif(trim(b->>'channel_slug'), '') is not null
       and nullif(trim(b->>'intent'), '') is not null
       and nullif(trim(b->>'falsifier'), '') is not null
  ) = 0 then
    return null;
  end if;

  select coalesce(array_agg(channel_slug), '{}'::text[]) into v_was
    from tenant_channels
   where tenant_id = p_tenant_id and plan_selected;

  v_plan_id := set_growth_plan(
    p_tenant_id, p_objective, p_target_metric,
    p_constraint_statement, p_constraint_confidence, p_basis_evidence,
    p_actor_kind, p_actor_ref
  );
  if v_plan_id is null then
    return null;
  end if;

  update growth_plan_bets
     set status = 'superseded', updated_at = now()
   where tenant_id = p_tenant_id
     and plan_id <> v_plan_id
     and status in ('proposed', 'accepted');

  for v_bet in select * from jsonb_array_elements(coalesce(p_bets, '[]'::jsonb))
  loop
    v_slug := nullif(trim(v_bet->>'channel_slug'), '');

    if v_slug is null
       or nullif(trim(v_bet->>'intent'), '') is null
       or nullif(trim(v_bet->>'falsifier'), '') is null then
      continue;
    end if;

    v_i := v_i + 1;
    v_slugs := v_slugs || v_slug;

    perform set_growth_plan_bet(
      p_tenant_id, v_plan_id, null, v_slug,
      v_bet->>'intent', nullif(trim(v_bet->>'rationale'), ''),
      v_bet->>'expected_effect', v_bet->>'falsifier',
      'accepted', null, v_i, p_actor_kind, p_actor_ref
    );

    v_autorun := coalesce((v_bet->>'autorun')::boolean, false);

    select autorun_set_by into v_prev_set
      from tenant_channels
     where tenant_id = p_tenant_id and channel_slug = v_slug;

    if v_prev_set = 'founder' then
      insert into tenant_channels
        (tenant_id, channel_slug, plan_selected, plan_selected_set_by, plan_sort_order)
      values (p_tenant_id, v_slug, true, 'plan', v_i)
      on conflict (tenant_id, channel_slug) do update
        set plan_selected        = true,
            plan_selected_set_by = coalesce(tenant_channels.plan_selected_set_by, 'plan'),
            plan_sort_order      = v_i;
    else
      insert into tenant_channels
        (tenant_id, channel_slug, plan_selected, plan_selected_set_by, plan_sort_order,
         autorun, autorun_set_by)
      values (p_tenant_id, v_slug, true, 'plan', v_i, v_autorun, 'plan')
      on conflict (tenant_id, channel_slug) do update
        set plan_selected        = true,
            plan_selected_set_by = coalesce(tenant_channels.plan_selected_set_by, 'plan'),
            plan_sort_order      = v_i,
            autorun              = v_autorun,
            autorun_set_by       = 'plan';
    end if;
  end loop;

  update tenant_channels
     set plan_selected        = false,
         plan_selected_set_by = null,
         plan_sort_order      = null,
         autorun              = case when autorun_set_by = 'founder' then autorun else false end,
         autorun_set_by       = case when autorun_set_by = 'founder' then 'founder' else null end
   where tenant_id = p_tenant_id
     and not (channel_slug = any (v_slugs))
     and plan_selected_set_by is distinct from 'founder'
     and (plan_selected or autorun);

  begin
    perform retire_cards_off_plan(p_tenant_id, v_plan_id, v_was);
  exception when others then
    begin
      insert into praxis_logs (level, source, code, message, tenant_id, meta)
      values ('warn', 'commit_growth_plan', 'growth_plan.retire_off_plan_failed',
              left('workspace ' || p_tenant_id || ': ' || sqlerrm, 500), null,
              jsonb_build_object('tenant_id', p_tenant_id, 'plan_id', v_plan_id, 'sqlstate', sqlstate));
    exception when others then
      raise warning 'commit_growth_plan: retire_cards_off_plan failed (%), and so did its log row', sqlerrm;
    end;
  end;

  return v_plan_id;
end $$;

revoke all on function commit_growth_plan(uuid, text, text, text, text, jsonb, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function commit_growth_plan(uuid, text, text, text, text, jsonb, jsonb, text, text)
  to service_role;

commit;
