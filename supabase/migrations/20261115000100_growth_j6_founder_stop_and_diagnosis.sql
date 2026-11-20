
begin;

do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
     where conrelid = 'public.tenant_channels'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%plan_selected_set_by%'
  loop
    execute format('alter table public.tenant_channels drop constraint %I', r.conname);
  end loop;
end $$;

alter table tenant_channels add constraint tenant_channels_plan_selected_set_by_check
  check (plan_selected_set_by in ('plan', 'founder', 'founder_stopped'));

comment on column tenant_channels.plan_selected_set_by is
  'Who put this channel in the plan: plan (commit_growth_plan) or founder (set_channel_in_plan). founder_stopped: the founder stopped it (plan_selected false); no plan commit, cgo write or Start over may select it until the founder restores it.';

alter table growth_plan
  add column if not exists founder_constraint    text,
  add column if not exists founder_constraint_at timestamptz,
  add column if not exists founder_constraint_by uuid,
  add column if not exists constraint_agreed_at  timestamptz,
  add column if not exists constraint_agreed_by  uuid;

alter table growth_plan drop constraint if exists growth_plan_founder_constraint_len;
alter table growth_plan add constraint growth_plan_founder_constraint_len
  check (founder_constraint is null or char_length(founder_constraint) between 1 and 300);

comment on column growth_plan.founder_constraint is
  'The founder''s own words for what holds growth back ("Not quite..."). cgo plans around it: it overrides the drafted constraint statement. Carried onto every later plan row by set_growth_plan.';
comment on column growth_plan.constraint_agreed_at is
  'The founder agreed with the plan''s constraint ("Sounds right"). Carried onto a later plan row only while constraint_statement is unchanged.';

alter table channel_action_events drop constraint if exists channel_action_events_event_check;
alter table channel_action_events add constraint channel_action_events_event_check
  check (event in (
    'proposed','acted','rejected','snoozed','redo_requested','redone','stale_flagged',
    'displaced',
    'revised','approved','executed','exec_failed',
    'reopened'));

create or replace function set_growth_plan(
  p_tenant_id             uuid,
  p_objective             text,
  p_target_metric         text,
  p_constraint_statement  text,
  p_constraint_confidence text,
  p_basis_evidence        jsonb,
  p_actor_kind            text,
  p_actor_ref             text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id      uuid;
  v_prev    growth_plan%rowtype;
  v_version int := 1;
begin
  select * into v_prev from growth_plan
    where tenant_id = p_tenant_id and status = 'live'
    limit 1
    for update;

  if found then
    v_version := v_prev.version + 1;
    update growth_plan
      set status = 'superseded', updated_at = now()
      where id = v_prev.id;
  end if;

  insert into growth_plan (
    tenant_id, objective, north_star_metric,
    constraint_statement, constraint_confidence, basis_evidence, status, version
  ) values (
    p_tenant_id, p_objective, p_target_metric,
    p_constraint_statement, p_constraint_confidence,
    case when jsonb_typeof(p_basis_evidence) = 'array' then p_basis_evidence else null end,
    'live', v_version
  ) returning id into v_id;

  if v_prev.id is not null then
    update growth_plan
       set founder_constraint    = v_prev.founder_constraint,
           founder_constraint_at = v_prev.founder_constraint_at,
           founder_constraint_by = v_prev.founder_constraint_by,
           constraint_agreed_at  = case when v_prev.constraint_statement is not distinct from p_constraint_statement
                                        then v_prev.constraint_agreed_at end,
           constraint_agreed_by  = case when v_prev.constraint_statement is not distinct from p_constraint_statement
                                        then v_prev.constraint_agreed_by end
     where id = v_id;
  end if;

  if v_prev.objective is distinct from p_objective then
    perform log_growth_plan_change(
      p_tenant_id, v_id, 'plan', v_id, 'objective',
      v_prev.objective, p_objective, p_actor_kind, p_actor_ref, null
    );
  end if;

  if v_prev.constraint_statement is distinct from p_constraint_statement then
    perform log_growth_plan_change(
      p_tenant_id, v_id, 'plan', v_id, 'constraint_statement',
      v_prev.constraint_statement, p_constraint_statement,
      p_actor_kind, p_actor_ref, null
    );
  end if;

  return v_id;
end $$;

revoke all on function set_growth_plan(uuid, text, text, text, text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function set_growth_plan(uuid, text, text, text, text, jsonb, text, text)
  to service_role;

create or replace function set_founder_constraint(
  p_tenant_id uuid,
  p_actor     uuid,
  p_text      text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_plan growth_plan%rowtype;
  v_try  int;
  v_text text := nullif(trim(p_text), '');
begin
  if p_tenant_id is null or p_actor is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  if p_text is not null and (v_text is null or char_length(v_text) > 300) then
    return jsonb_build_object('ok', false, 'code', 'bad_text');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor) then
    return jsonb_build_object('ok', false, 'code', 'not_member');
  end if;

  for v_try in 1..2 loop
    select * into v_plan from growth_plan
     where tenant_id = p_tenant_id and status = 'live'
     order by created_at desc limit 1
     for update;
    exit when found;
  end loop;
  if v_plan.id is null then
    return jsonb_build_object('ok', false, 'code', 'no_plan');
  end if;

  update growth_plan
     set founder_constraint    = v_text,
         founder_constraint_at = case when v_text is null then null else now() end,
         founder_constraint_by = case when v_text is null then null else p_actor end,
         constraint_agreed_at  = case when v_text is null then constraint_agreed_at end,
         constraint_agreed_by  = case when v_text is null then constraint_agreed_by end
   where id = v_plan.id;

  if v_plan.founder_constraint is distinct from v_text then
    perform log_growth_plan_change(
      p_tenant_id, v_plan.id, 'plan', v_plan.id, 'founder_constraint',
      v_plan.founder_constraint, v_text, 'founder', p_actor::text, null
    );
  end if;

  return jsonb_build_object('ok', true, 'plan_id', v_plan.id, 'founder_constraint', v_text,
                            'founder_constraint_at', case when v_text is null then null else now() end);
end $$;

revoke all on function set_founder_constraint(uuid, uuid, text) from public, anon, authenticated;
grant execute on function set_founder_constraint(uuid, uuid, text) to service_role;

create or replace function set_constraint_agreed(
  p_tenant_id uuid,
  p_actor     uuid,
  p_agreed    boolean
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id  uuid;
  v_try int;
begin
  if p_tenant_id is null or p_actor is null or p_agreed is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor) then
    return jsonb_build_object('ok', false, 'code', 'not_member');
  end if;

  for v_try in 1..2 loop
    update growth_plan
       set constraint_agreed_at = case when p_agreed then now() end,
           constraint_agreed_by = case when p_agreed then p_actor end
     where id = (select id from growth_plan
                  where tenant_id = p_tenant_id and status = 'live'
                  order by created_at desc limit 1)
       and tenant_id = p_tenant_id
       and status = 'live'
    returning id into v_id;
    exit when v_id is not null;
  end loop;

  if v_id is null then
    return jsonb_build_object('ok', false, 'code', 'no_plan');
  end if;
  return jsonb_build_object('ok', true, 'plan_id', v_id,
                            'constraint_agreed_at', case when p_agreed then now() end);
end $$;

revoke all on function set_constraint_agreed(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function set_constraint_agreed(uuid, uuid, boolean) to service_role;

create or replace function switch_plan_constraint_to_hypothesis(
  p_tenant_id     uuid,
  p_actor         uuid,
  p_hypothesis_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claim text;
  v_try   int;
  v_plan  growth_plan%rowtype;
begin
  if p_tenant_id is null or p_actor is null or p_hypothesis_id is null then
    return jsonb_build_object('ok', false, 'code', 'bad_request');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor) then
    return jsonb_build_object('ok', false, 'code', 'not_member');
  end if;

  select claim into v_claim from cgo_hypotheses
   where tenant_id = p_tenant_id
     and id = p_hypothesis_id
     and status in ('listed', 'testing', 'confirmed');
  if v_claim is null or nullif(trim(v_claim), '') is null then
    return jsonb_build_object('ok', false, 'code', 'no_hypothesis');
  end if;

  for v_try in 1..2 loop
    select * into v_plan from growth_plan
     where tenant_id = p_tenant_id and status = 'live'
     order by created_at desc limit 1
     for update;
    exit when found;
  end loop;
  if v_plan.id is null then
    return jsonb_build_object('ok', false, 'code', 'no_plan');
  end if;

  update growth_plan
     set founder_constraint = null, founder_constraint_at = null, founder_constraint_by = null,
         constraint_agreed_at = null, constraint_agreed_by = null
   where id = v_plan.id;

  update cgo_hypotheses
     set plan_kept_at = null, plan_kept_by = null
   where tenant_id = p_tenant_id
     and plan_kept_at is not null;

  if v_plan.founder_constraint is not null then
    perform log_growth_plan_change(
      p_tenant_id, v_plan.id, 'plan', v_plan.id, 'founder_constraint',
      v_plan.founder_constraint, null, 'founder', p_actor::text, 'Switched to Zavi''s guess'
    );
  end if;

  return jsonb_build_object('ok', true, 'claim', left(trim(v_claim), 500));
end $$;

revoke all on function switch_plan_constraint_to_hypothesis(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function switch_plan_constraint_to_hypothesis(uuid, uuid, uuid) to service_role;

drop function if exists set_channel_in_plan(uuid, text, boolean);

create or replace function set_channel_in_plan(
  p_tenant_id     uuid,
  p_channel_slug  text,
  p_in_plan       boolean,
  p_actor_user_id uuid default null
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_next   int;
  v_sort   int;
  v_ok     boolean;
  v_row    tenant_channels%rowtype;
  v_found  boolean;
  v_card   record;
  v_stop   text;
  v_note   text;
begin
  if p_tenant_id is null
     or nullif(trim(p_channel_slug), '') is null
     or p_in_plan is null then
    return 'failed';
  end if;
  if p_actor_user_id is not null and not exists (
    select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id
  ) then
    return 'failed';
  end if;

  select * into v_row from tenant_channels
   where tenant_id = p_tenant_id and channel_slug = p_channel_slug
   for update;
  v_found := found;

  if p_in_plan then
    if v_found and v_row.plan_selected_set_by = 'founder_stopped' then
      select b.sort_order into v_sort
        from growth_plan_bets b
        join growth_plan p on p.id = b.plan_id
       where p.tenant_id = p_tenant_id and p.status = 'live'
         and b.tenant_id = p_tenant_id
         and b.channel_slug = p_channel_slug
         and b.status in ('proposed', 'accepted')
       order by b.sort_order
       limit 1;
      if found then
        update tenant_channels
           set plan_selected = true, plan_selected_set_by = 'plan', plan_sort_order = v_sort
         where tenant_id = p_tenant_id and channel_slug = p_channel_slug;
      else
        select coalesce(max(plan_sort_order), 0) + 1 into v_next
          from tenant_channels where tenant_id = p_tenant_id and plan_selected;
        update tenant_channels
           set plan_selected = true, plan_selected_set_by = 'founder', plan_sort_order = v_next,
               autorun_set_by = case when autorun then autorun_set_by else 'founder' end
         where tenant_id = p_tenant_id and channel_slug = p_channel_slug;
      end if;

      for v_card in
        select ca.id, e.event_key
          from channel_actions ca
          join lateral (
            select ev.event_key from channel_action_events ev
             where ev.action_id = ca.id order by ev.id desc limit 1
          ) e on true
         where ca.tenant_id = p_tenant_id
           and ca.channel_slug = p_channel_slug
           and ca.status = 'stale'
           and e.event_key like 'founder_stop:%'
         for update of ca
      loop
        begin
          update channel_actions
             set status = 'pending', status_at = null, note = null, snoozed_until = null
           where id = v_card.id;
          insert into channel_action_events
            (tenant_id, action_id, event, actor_kind, actor_user_id, note, event_key)
          values
            (p_tenant_id, v_card.id, 'reopened', 'founder', p_actor_user_id,
             'Reopened when you turned this channel back on',
             left('founder_restore:' || v_card.event_key, 200))
          on conflict (action_id, event_key) do nothing;
        exception when unique_violation then
          null;
        end;
      end loop;

      select plan_selected_set_by into v_stop from tenant_channels
       where tenant_id = p_tenant_id and channel_slug = p_channel_slug and plan_selected;
      return case v_stop when 'plan' then 'restored_plan' when 'founder' then 'restored_founder' else 'failed' end;
    end if;

    select coalesce(max(plan_sort_order), 0) + 1 into v_next
      from tenant_channels
     where tenant_id = p_tenant_id and plan_selected;

    if v_found and v_row.plan_selected and v_row.plan_selected_set_by = 'plan' then
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

  if v_found and v_row.plan_selected and v_row.plan_selected_set_by = 'founder' then
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
  end if;

  if v_found and v_row.plan_selected_set_by = 'founder_stopped' then
    return 'stopped';
  end if;

  insert into tenant_channels
    (tenant_id, channel_slug, plan_selected, plan_selected_set_by, plan_sort_order, autorun)
  values
    (p_tenant_id, p_channel_slug, false, 'founder_stopped', null, false)
  on conflict (tenant_id, channel_slug) do update
    set plan_selected        = false,
        plan_selected_set_by = 'founder_stopped',
        plan_sort_order      = null,
        cgo_reason           = null,
        cgo_set_at           = null,
        cgo_run_id           = null;

  v_stop := 'founder_stop:' || gen_random_uuid();
  v_note := 'Closed when you stopped this channel';
  for v_card in
    select id from channel_actions
     where tenant_id = p_tenant_id
       and channel_slug = p_channel_slug
       and status in ('pending', 'snoozed')
       and exec_status is distinct from 'queued'
       and exec_status is distinct from 'dispatching'
     for update
  loop
    update channel_actions
       set status = 'stale', status_at = now(), note = v_note
     where id = v_card.id;
    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, actor_user_id, note, event_key)
    values
      (p_tenant_id, v_card.id, 'stale_flagged', 'founder', p_actor_user_id, v_note, v_stop);
  end loop;

  select true into v_ok
    from tenant_channels
   where tenant_id = p_tenant_id
     and channel_slug = p_channel_slug
     and not plan_selected
     and plan_selected_set_by = 'founder_stopped';
  return case when coalesce(v_ok, false) then 'stopped' else 'failed' end;
end $$;

revoke all on function set_channel_in_plan(uuid, text, boolean, uuid)
  from public, anon, authenticated;
grant execute on function set_channel_in_plan(uuid, text, boolean, uuid)
  to service_role;

create or replace function set_channel_in_plan_by_cgo(
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

  if exists (
    select 1 from tenant_channels
     where tenant_id = p_tenant_id
       and channel_slug = p_channel_slug
       and plan_selected_set_by = 'founder_stopped'
  ) then
    return 'founder_stopped';
  end if;

  if exists (
    select 1 from tenant_channels
     where tenant_id = p_tenant_id
       and channel_slug = p_channel_slug
       and (plan_selected_set_by = 'founder' or autorun_set_by = 'founder')
  ) then
    return 'founder_owned';
  end if;

  if p_in_plan then
    if exists (
      select 1 from tenant_channels
       where tenant_id = p_tenant_id
         and channel_slug = p_channel_slug
         and plan_selected
    ) then
      return 'already_in_plan';
    end if;
    if exists (
      select 1 from tenant_channels
       where tenant_id = p_tenant_id
         and channel_slug = p_channel_slug
         and autorun
    ) then
      return 'runs_on_its_own';
    end if;

    select coalesce(max(plan_sort_order), 0) + 1 into v_next
      from tenant_channels
     where tenant_id = p_tenant_id and plan_selected;

    insert into tenant_channels
      (tenant_id, channel_slug, plan_selected, plan_selected_set_by, plan_sort_order, autorun)
    values
      (p_tenant_id, p_channel_slug, true, 'plan', v_next, false)
    on conflict (tenant_id, channel_slug) do update
      set plan_selected        = true,
          plan_selected_set_by = 'plan',
          plan_sort_order      = v_next
      where tenant_channels.plan_selected_set_by is distinct from 'founder'
        and tenant_channels.plan_selected_set_by is distinct from 'founder_stopped'
        and tenant_channels.autorun_set_by is distinct from 'founder'
        and not coalesce(tenant_channels.autorun, false);

    select true into v_ok
      from tenant_channels
     where tenant_id = p_tenant_id
       and channel_slug = p_channel_slug
       and plan_selected
       and plan_selected_set_by = 'plan';
    return case when coalesce(v_ok, false) then 'ok' else 'failed' end;
  end if;

  if not exists (
    select 1 from tenant_channels
     where tenant_id = p_tenant_id
       and channel_slug = p_channel_slug
       and plan_selected
       and plan_selected_set_by = 'plan'
  ) then
    return 'not_plan';
  end if;

  update tenant_channels
     set plan_selected        = false,
         plan_selected_set_by = null,
         plan_sort_order      = null
   where tenant_id = p_tenant_id
     and channel_slug = p_channel_slug
     and plan_selected_set_by = 'plan'
     and autorun_set_by is distinct from 'founder';

  select true into v_ok
    from tenant_channels
   where tenant_id = p_tenant_id
     and channel_slug = p_channel_slug
     and not plan_selected;
  return case when coalesce(v_ok, false) then 'ok' else 'failed' end;
end $$;

revoke all on function set_channel_in_plan_by_cgo(uuid, text, boolean) from public, anon, authenticated;
grant execute on function set_channel_in_plan_by_cgo(uuid, text, boolean) to service_role;

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
  v_stopped   text[];
begin
  if p_tenant_id is null then
    return null;
  end if;

  select coalesce(array_agg(channel_slug), '{}'::text[]) into v_stopped
    from tenant_channels
   where tenant_id = p_tenant_id and plan_selected_set_by = 'founder_stopped';

  if (
    select count(*)
      from jsonb_array_elements(coalesce(p_bets, '[]'::jsonb)) b
     where nullif(trim(b->>'channel_slug'), '') is not null
       and nullif(trim(b->>'intent'), '') is not null
       and nullif(trim(b->>'falsifier'), '') is not null
       and not (trim(b->>'channel_slug') = any (v_stopped))
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
    if v_slug = any (v_stopped) then
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
     and plan_selected_set_by is distinct from 'founder_stopped'
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

create or replace function retire_growth_plan(p_tenant_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  if p_tenant_id is null then
    raise exception 'retire_growth_plan: tenant_id required'
      using errcode = '22023';
  end if;

  update growth_plan_bets b
     set status = 'superseded', updated_at = now()
    from growth_plan p
   where b.plan_id = p.id
     and p.tenant_id = p_tenant_id
     and p.status = 'live'
     and b.status not in ('superseded', 'rejected');

  update growth_plan
     set status = 'superseded', updated_at = now()
   where tenant_id = p_tenant_id
     and status = 'live';

  get diagnostics v_count = row_count;

  update tenant_channels
     set plan_selected        = false,
         plan_selected_set_by = null,
         plan_sort_order      = null,
         autorun              = case when autorun_set_by = 'founder' then autorun else false end,
         autorun_set_by       = case when autorun_set_by = 'founder' then 'founder' else null end
   where tenant_id = p_tenant_id
     and plan_selected_set_by is distinct from 'founder'
     and plan_selected_set_by is distinct from 'founder_stopped'
     and (plan_selected or autorun);

  return v_count;
end;
$$;

revoke all on function retire_growth_plan(uuid)
  from public, anon, authenticated;
grant execute on function retire_growth_plan(uuid)
  to service_role;

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
  if p_status is null or p_status not in ('acted', 'rejected', 'snoozed', 'redo_requested', 'open') then
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

  if p_status = 'open' then
    if v_row.status not in ('snoozed', 'acted', 'rejected') then
      return jsonb_build_object('ok', false, 'code', 'illegal_transition',
                                'from', v_row.status, 'to', 'pending');
    end if;
    if v_row.exec_status = 'executed'
       or (v_row.status in ('acted', 'rejected')
           and (v_row.exec_class is not null or v_row.exec_status is not null or v_row.approved_by is not null)) then
      return jsonb_build_object('ok', false, 'code', 'not_reopenable');
    end if;

    update channel_actions
       set status = 'pending', status_at = null, note = null, snoozed_until = null
     where id = p_action_id;

    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, actor_user_id, note, event_key)
    values
      (p_tenant_id, p_action_id, 'reopened', 'founder', p_actor_user_id, v_note, v_key);

    return jsonb_build_object('ok', true, 'replayed', false, 'status', 'pending');
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

create or replace function unsnooze_decision(
  p_tenant_id   uuid,
  p_decision_id uuid
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_updated int;
begin
  if p_tenant_id is null or p_decision_id is null then
    return false;
  end if;
  update public.decisions d
     set snoozed_until = null
   where d.id = p_decision_id
     and d.tenant_id = p_tenant_id
     and d.status = 'proposed'
     and d.snoozed_until is not null
     and exists (
       select 1 from public.decision_classes dc
        where dc.slug = d.decision_class
          and dc.founder_managed is true
     );
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end $$;

revoke all on function unsnooze_decision(uuid, uuid) from public, anon, authenticated;
grant execute on function unsnooze_decision(uuid, uuid) to service_role;

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
    if p_result->>'code' = 'founder_stopped' and exists (
      select 1 from tenant_channels
       where tenant_id = p_tenant_id and channel_slug = v_row.channel_slug
         and plan_selected_set_by = 'founder_stopped'
    ) then
      update channel_actions
         set status = 'stale', status_at = now(), note = 'Closed when you stopped this channel'
       where id = p_action_id and status in ('pending', 'snoozed');
      insert into channel_action_events
        (tenant_id, action_id, event, actor_kind, run_id, note, event_key)
      values
        (p_tenant_id, p_action_id, 'stale_flagged', 'system', v_row.run_id,
         'Closed when you stopped this channel', 'founder_stop:exec:' || p_action_id)
      on conflict (action_id, event_key) do nothing;
    else
      perform apply_exec_failure_verdict(p_tenant_id, p_action_id, v_row.run_id, p_result);
    end if;
  end if;

  return jsonb_build_object('ok', true, 'executed', p_ok);
end $$;

revoke all on function settle_channel_action_exec(uuid, uuid, boolean, jsonb, text, uuid)
  from public, anon, authenticated;
grant execute on function settle_channel_action_exec(uuid, uuid, boolean, jsonb, text, uuid)
  to service_role;

commit;
