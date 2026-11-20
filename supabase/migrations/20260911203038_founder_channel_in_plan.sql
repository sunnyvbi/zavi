
begin;

alter table tenant_channels
  add column if not exists plan_selected_set_by text
    check (plan_selected_set_by in ('plan', 'founder'));

comment on column tenant_channels.plan_selected_set_by is
  'Who put this channel in the plan: plan (commit_growth_plan) or founder (set_channel_in_plan). A founder add survives later plan commits and Start over.';

update tenant_channels
   set plan_selected_set_by = 'plan'
 where plan_selected
   and plan_selected_set_by is null;

create or replace function set_channel_in_plan(
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

  if p_in_plan then
    select coalesce(max(plan_sort_order), 0) + 1 into v_next
      from tenant_channels
     where tenant_id = p_tenant_id and plan_selected;

    if exists (
      select 1 from tenant_channels
       where tenant_id = p_tenant_id
         and channel_slug = p_channel_slug
         and plan_selected
         and plan_selected_set_by = 'plan'
    ) then
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
                                      else 'founder' end;

    select true into v_ok
      from tenant_channels
     where tenant_id = p_tenant_id
       and channel_slug = p_channel_slug
       and plan_selected
       and plan_selected_set_by = 'founder';
    return case when coalesce(v_ok, false) then 'ok' else 'failed' end;
  end if;

  if not exists (
    select 1 from tenant_channels
     where tenant_id = p_tenant_id
       and channel_slug = p_channel_slug
       and plan_selected
       and plan_selected_set_by = 'founder'
  ) then
    return 'not_founder';
  end if;

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
end $$;

revoke all on function set_channel_in_plan(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function set_channel_in_plan(uuid, text, boolean)
  to service_role;

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

  return v_plan_id;
end $$;

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
     and (plan_selected or autorun);

  return v_count;
end;
$$;

revoke all on function retire_growth_plan(uuid)
  from public, anon, authenticated;
grant execute on function retire_growth_plan(uuid)
  to service_role;

commit;
