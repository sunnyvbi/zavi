
begin;

alter table growth_plan_bets add column if not exists rationale text;

comment on column growth_plan_bets.rationale is
  'WHY this channel earned its place, in the CGO''s words. Distinct from intent '
  '(WHAT Zavi will do). Null for bets accepted before 20260909160000 — render '
  'the honest empty state, never a blank row.';

drop function if exists set_growth_plan_bet(uuid, uuid, uuid, text, text, text, text, text, text, int, text, text);

create or replace function set_growth_plan_bet(
  p_tenant_id       uuid,
  p_plan_id         uuid,
  p_bet_id          uuid,
  p_channel_slug    text,
  p_intent          text,
  p_rationale       text,
  p_expected_effect text,
  p_falsifier       text,
  p_status          text,
  p_rejected_reason text,
  p_sort_order      int,
  p_actor_kind      text,
  p_actor_ref       text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id              uuid;
  v_prev_st         text;
  v_prev_reason     text;
  v_prev_sort_order int;
begin
  if p_bet_id is null then
    if not exists (
      select 1 from growth_plan
      where id = p_plan_id and tenant_id = p_tenant_id
    ) then
      return null;
    end if;

    insert into growth_plan_bets (
      plan_id, tenant_id, channel_slug, intent, rationale, expected_effect,
      falsifier, status, rejected_reason, sort_order
    ) values (
      p_plan_id, p_tenant_id, p_channel_slug, p_intent, p_rationale, p_expected_effect,
      p_falsifier, coalesce(p_status, 'proposed'), p_rejected_reason,
      coalesce(p_sort_order, 100)
    ) returning id into v_id;

    perform log_growth_plan_change(
      p_tenant_id, p_plan_id, 'bet', v_id, 'created',
      null, p_intent, p_actor_kind, p_actor_ref, null
    );
    return v_id;
  end if;

  select status, rejected_reason, sort_order
    into v_prev_st, v_prev_reason, v_prev_sort_order
    from growth_plan_bets
    where id = p_bet_id and tenant_id = p_tenant_id;
  if not found then
    return null;
  end if;

  update growth_plan_bets
    set status          = coalesce(p_status, status),
        rationale       = coalesce(p_rationale, rationale),
        rejected_reason = coalesce(p_rejected_reason, rejected_reason),
        sort_order      = coalesce(p_sort_order, sort_order),
        updated_at      = now()
    where id = p_bet_id and tenant_id = p_tenant_id;

  if p_status is not null and p_status is distinct from v_prev_st then
    perform log_growth_plan_change(
      p_tenant_id, p_plan_id, 'bet', p_bet_id, 'status',
      v_prev_st, p_status, p_actor_kind, p_actor_ref, p_rejected_reason
    );
  end if;

  if p_rejected_reason is not null
     and p_rejected_reason is distinct from v_prev_reason then
    perform log_growth_plan_change(
      p_tenant_id, p_plan_id, 'bet', p_bet_id, 'rejected_reason',
      v_prev_reason, p_rejected_reason, p_actor_kind, p_actor_ref, null
    );
  end if;

  if p_sort_order is not null and p_sort_order is distinct from v_prev_sort_order then
    perform log_growth_plan_change(
      p_tenant_id, p_plan_id, 'bet', p_bet_id, 'sort_order',
      v_prev_sort_order::text, p_sort_order::text, p_actor_kind, p_actor_ref, null
    );
  end if;

  return p_bet_id;
end $$;

create or replace function commit_growth_plan(
  p_tenant_id             uuid,
  p_objective             text,
  p_target_metric         text,
  p_constraint_statement  text,
  p_constraint_confidence text,
  p_bets                  jsonb,
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

  v_plan_id := set_growth_plan(
    p_tenant_id, p_objective, p_target_metric,
    p_constraint_statement, p_constraint_confidence,
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
      insert into tenant_channels (tenant_id, channel_slug, plan_selected, plan_sort_order)
      values (p_tenant_id, v_slug, true, v_i)
      on conflict (tenant_id, channel_slug) do update
        set plan_selected   = true,
            plan_sort_order = v_i;
    else
      insert into tenant_channels
        (tenant_id, channel_slug, plan_selected, plan_sort_order, autorun, autorun_set_by)
      values (p_tenant_id, v_slug, true, v_i, v_autorun, 'plan')
      on conflict (tenant_id, channel_slug) do update
        set plan_selected   = true,
            plan_sort_order = v_i,
            autorun         = v_autorun,
            autorun_set_by  = 'plan';
    end if;
  end loop;

  update tenant_channels
     set plan_selected   = false,
         plan_sort_order = null,
         autorun         = case when autorun_set_by = 'founder' then autorun else false end,
         autorun_set_by  = case when autorun_set_by = 'founder' then 'founder' else null end
   where tenant_id = p_tenant_id
     and not (channel_slug = any (v_slugs))
     and (plan_selected or autorun);

  return v_plan_id;
end $$;

revoke all on function set_growth_plan_bet(uuid, uuid, uuid, text, text, text, text, text, text, text, int, text, text)
  from public, anon, authenticated;
grant execute on function set_growth_plan_bet(uuid, uuid, uuid, text, text, text, text, text, text, text, int, text, text)
  to service_role;

commit;
