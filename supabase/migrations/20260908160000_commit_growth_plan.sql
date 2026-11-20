
begin;

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
      v_bet->>'intent', v_bet->>'expected_effect', v_bet->>'falsifier',
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

revoke all on function commit_growth_plan(uuid, text, text, text, text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function commit_growth_plan(uuid, text, text, text, text, jsonb, text, text)
  to service_role;
grant execute on function set_growth_plan(uuid, text, text, text, text, text, text)
  to service_role;
grant execute on function set_growth_plan_bet(uuid, uuid, uuid, text, text, text, text, text, text, int, text, text)
  to service_role;
grant execute on function log_growth_plan_change(uuid, uuid, text, uuid, text, text, text, text, text, text)
  to service_role;

commit;
