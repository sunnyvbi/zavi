begin;

create or replace function public._ad_supersede_object_holds(p_budget_id uuid, p_platform text, p_object_id text, p_keep uuid)
returns void language sql volatile set search_path = public, pg_temp as $$
  update ad_budget_reservations
     set status = 'released', reason = 'rebased', released_on = null, pause_due = false, updated_at = now()
   where budget_id = p_budget_id and platform = p_platform and object_id = p_object_id
     and id <> p_keep and status in ('committed', 'released')
     and coalesce(reason, '') not in ('rebased', 'rejected', 'not_landed', 'pending_test_released')
$$;

revoke all on function public._ad_supersede_object_holds(uuid, text, text, uuid) from public, anon, authenticated;

create or replace function public._ad_budget_held_usd_except(
  p_budget_id uuid, p_today date, p_margin numeric, p_exclude uuid, p_platform text, p_object_id text)
returns numeric language sql stable set search_path = public, pg_temp as $$
  select ((ceil(coalesce(sum(
           case
             when r.bounded then 0
             when r.status in ('reserved', 'committed') and r.paused then r.daily_delta_usd
             when r.status in ('reserved', 'committed') then r.daily_delta_usd * _ad_budget_days_left(p_today)
             when r.status = 'released' and r.released_on = p_today then r.daily_delta_usd
             else 0
           end), 0) * p_margin * 100) / 100)
         + coalesce(sum(case when r.bounded then _ad_bounded_hold_usd(r, p_today, p_margin) else 0 end), 0))::numeric(12,2)
    from ad_budget_reservations r
   where r.budget_id = p_budget_id
     and (p_exclude is null or r.id <> p_exclude)
     and not (p_object_id is not null and r.platform = p_platform and r.object_id = p_object_id
              and r.status in ('committed', 'released')
              and coalesce(r.reason, '') not in ('rebased', 'rejected', 'not_landed', 'pending_test_released'))
$$;

revoke all on function public._ad_budget_held_usd_except(uuid, date, numeric, uuid, text, text) from public, anon, authenticated;

create or replace function public.ad_object_hold_usd(p_tenant_id uuid, p_platform text, p_object_id text)
returns numeric language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_today  date;
  v_used   numeric;
  v_unsent numeric;
  v_room   numeric;
  v_left   numeric;
begin
  if p_tenant_id is null or p_platform is null or p_object_id is null then
    raise exception 'ad_object_hold_usd: tenant, platform and object are required';
  end if;
  select * into v_budget from ad_budgets where tenant_id = p_tenant_id and status = 'active';
  if not found then
    return 0;
  end if;
  v_today := _ad_budget_today();
  v_used := _ad_budget_spent_usd(v_budget.spent_usd, v_budget.month_start, v_today)
            + _creator_hire_used_usd(v_budget.id, v_today);
  select coalesce(sum(_ad_bounded_hold_usd(r, v_today, v_budget.margin)), 0) into v_unsent
    from ad_budget_reservations r
   where r.budget_id = v_budget.id and r.tenant_id = p_tenant_id
     and r.platform = p_platform and r.object_id = p_object_id
     and r.status = 'reserved' and r.bounded and r.op = 'resume'
     and r.idem_key ~* '^[0-9a-f-]{36}:resume$'
     and not exists (
       select 1 from ads_campaign_operations o
        where o.id::text = lower(split_part(r.idem_key, ':', 1)) and o.status <> 'refused');
  v_room := _ad_budget_month_cap(v_budget.monthly_usd, v_budget.started_on, v_today) - v_used
            - (_ad_budget_held_usd_except(v_budget.id, v_today, v_budget.margin, null, p_platform, p_object_id) - v_unsent);
  v_left := greatest(_ad_budget_month_cap(v_budget.monthly_usd, v_budget.started_on, v_today) - v_used
                     - _ad_budget_held_usd(v_budget.id, v_today, v_budget.margin), 0);
  return greatest(greatest(v_room, 0) - v_left, 0)::numeric(12,2);
end $$;

revoke all on function public.ad_object_hold_usd(uuid, text, text) from public, anon, authenticated;
grant execute on function public.ad_object_hold_usd(uuid, text, text) to service_role;

do $$
declare
  fn oid;
  body text;
  pair text[];
  pairs text[][] := array[
    array[
      $a$  if p_op = 'resume' then
    v_delta := greatest(v_delta - coalesce(($a$,
      $a$  if p_op = 'resume' and not v_bounded then
    v_delta := greatest(v_delta - coalesce(($a$],
    array[
      $a$  if p_op = 'resume' then
    select coalesce(sum(daily_delta_usd), 0) into v_unpause$a$,
      $a$  if p_op = 'resume' and not v_bounded then
    select coalesce(sum(daily_delta_usd), 0) into v_unpause$a$],
    array[
      $a$         + _ad_budget_held_usd(v_budget.id, v_today, margin, v_res.id)
$a$,
      $a$         + case when v_bounded and p_op = 'resume'
                then _ad_budget_held_usd_except(v_budget.id, v_today, margin, v_res.id, p_platform, p_object_id)
                else _ad_budget_held_usd(v_budget.id, v_today, margin, v_res.id) end
$a$],
    array[
      $a$              and x.status in ('reserved', 'committed')
         ), 0) + v_delta <= daily_limit_usd)$a$,
      $a$              and x.status in ('reserved', 'committed')
              and not (v_bounded and p_op = 'resume' and x.platform = p_platform and x.object_id = p_object_id
                       and x.status = 'committed'
                       and coalesce(x.reason, '') not in ('rebased', 'rejected', 'not_landed', 'pending_test_released'))
         ), 0) + v_delta <= daily_limit_usd)$a$],
    array[
      $a$              and x.status in ('reserved', 'committed')
         ), 0) + v_delta > v_budget.daily_limit_usd$a$,
      $a$              and x.status in ('reserved', 'committed')
              and not (v_bounded and p_op = 'resume' and x.platform = p_platform and x.object_id = p_object_id
                       and x.status = 'committed'
                       and coalesce(x.reason, '') not in ('rebased', 'rejected', 'not_landed', 'pending_test_released'))
         ), 0) + v_delta > v_budget.daily_limit_usd$a$]
  ];
begin
  select oid into fn from pg_proc where pronamespace = 'public'::regnamespace and proname = 'reserve_ad_spend';
  body := pg_get_functiondef(fn);
  if position('_ad_budget_held_usd_except' in body) > 0 then
    return;
  end if;
  foreach pair slice 1 in array pairs loop
    if (length(body) - length(replace(body, pair[1], ''))) / length(pair[1]) <> 1 then
      raise exception 'linkedin_relaunch_supersedes_own_hold: reserve_ad_spend no longer matches (%)', left(pair[1], 60);
    end if;
    body := replace(body, pair[1], pair[2]);
  end loop;
  execute body;
end $$;

do $$
declare
  body text;
  pair text[];
  pairs text[][] := array[
    array[
      $a$           object_id = coalesce(object_id, p_object_id), updated_at = now()
     where id = v_res.id;
    return jsonb_build_object('status', 'committed');$a$,
      $a$           object_id = coalesce(object_id, p_object_id), updated_at = now()
     where id = v_res.id;
    if v_res.bounded and v_res.op = 'resume' then
      perform _ad_supersede_object_holds(v_budget_id, v_res.platform, coalesce(v_res.object_id, p_object_id), v_res.id);
    end if;
    return jsonb_build_object('status', 'committed');$a$],
    array[
      $a$       set status = 'committed', object_id = coalesce(object_id, p_object_id), updated_at = now()
     where id = v_res.id;
    return jsonb_build_object('status', 'committed');$a$,
      $a$       set status = 'committed', object_id = coalesce(object_id, p_object_id), updated_at = now()
     where id = v_res.id;
    if v_res.bounded and v_res.op = 'resume' then
      perform _ad_supersede_object_holds(v_budget_id, v_res.platform, coalesce(v_res.object_id, p_object_id), v_res.id);
    end if;
    return jsonb_build_object('status', 'committed');$a$]
  ];
begin
  body := pg_get_functiondef('public.settle_ad_spend(uuid,text,text,text)'::regprocedure);
  if position('_ad_supersede_object_holds' in body) > 0 then
    return;
  end if;
  foreach pair slice 1 in array pairs loop
    if (length(body) - length(replace(body, pair[1], ''))) / length(pair[1]) <> 1 then
      raise exception 'linkedin_relaunch_supersedes_own_hold: settle_ad_spend no longer matches (%)', left(pair[1], 60);
    end if;
    body := replace(body, pair[1], pair[2]);
  end loop;
  execute body;
end $$;

do $$
declare
  body text;
  anchor text := $a$  if p_outcome = 'landed' then
    update ad_budget_reservations
       set status = 'committed', updated_at = now()
     where id = v_res.id;
    return jsonb_build_object('status', 'committed');$a$;
  patched text := $a$  if p_outcome = 'landed' then
    update ad_budget_reservations
       set status = 'committed', updated_at = now()
     where id = v_res.id;
    if v_res.bounded and v_res.op = 'resume' then
      perform _ad_supersede_object_holds(v_res.budget_id, v_res.platform, v_res.object_id, v_res.id);
    end if;
    return jsonb_build_object('status', 'committed');$a$;
begin
  body := pg_get_functiondef('public.resolve_inflight_ad_hold(uuid,uuid,text,timestamptz)'::regprocedure);
  if position('_ad_supersede_object_holds' in body) > 0 then
    return;
  end if;
  if (length(body) - length(replace(body, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'linkedin_relaunch_supersedes_own_hold: resolve_inflight_ad_hold no longer matches';
  end if;
  execute replace(body, anchor, patched);
end $$;

commit;
