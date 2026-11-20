
begin;

create table if not exists public.ad_budget_events (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  budget_id       uuid not null references public.ad_budgets(id) on delete cascade,
  occurred_at     timestamptz not null default clock_timestamp(),
  kind            text not null check (kind in ('setup', 'edit', 'stop')),
  monthly_usd     numeric(12,2) not null check (monthly_usd > 0),
  daily_limit_usd numeric(12,2) check (daily_limit_usd is null or daily_limit_usd > 0),
  actor           uuid,
  backfilled      boolean not null default false,
  created_at      timestamptz not null default now()
);
create index if not exists ad_budget_events_tenant_time
  on public.ad_budget_events (tenant_id, occurred_at desc);

alter table public.ad_budget_events enable row level security;

create policy ad_budget_events_member_select on public.ad_budget_events
  for select using (
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = ad_budget_events.tenant_id
    )
  );
create policy ad_budget_events_active_tenant_restrict
  on public.ad_budget_events as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

revoke all on public.ad_budget_events from public, anon;
revoke insert, update, delete, truncate on public.ad_budget_events from authenticated;
grant select on public.ad_budget_events to authenticated;
revoke all on public.ad_budget_events from service_role;
grant select, insert on public.ad_budget_events to service_role;

create or replace function public.create_ad_budget(
  p_tenant_id       uuid,
  p_actor           uuid,
  p_monthly_usd     numeric,
  p_daily_limit_usd numeric
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id    uuid;
  v_today date := _ad_budget_today();
begin
  perform _ad_budget_assert_manager(p_tenant_id, p_actor);
  if _tenant_tier(p_tenant_id) <> 'pro' then
    raise exception 'ad_budget: the Pro plan is required' using errcode = '42501';
  end if;
  if p_monthly_usd is null or not (round(p_monthly_usd, 2) > 0 and p_monthly_usd < 10000000) then
    raise exception 'ad_budget: invalid monthly amount' using errcode = '22023';
  end if;
  if p_daily_limit_usd is not null and not (round(p_daily_limit_usd, 2) > 0 and round(p_daily_limit_usd, 2) <= round(p_monthly_usd, 2)) then
    raise exception 'ad_budget: invalid daily limit' using errcode = '22023';
  end if;

  if exists (
    select 1 from ad_budgets b
      join ad_budget_reservations r on r.budget_id = b.id
     where b.tenant_id = p_tenant_id and b.status = 'stopped'
       and r.status in ('reserved', 'committed') and r.object_id is not null
  ) then
    return jsonb_build_object('status', 'outstanding_holds');
  end if;

  begin
    insert into ad_budgets (tenant_id, monthly_usd, daily_limit_usd, started_on, month_start, created_by)
    values (p_tenant_id, round(p_monthly_usd, 2), round(p_daily_limit_usd, 2),
            v_today, date_trunc('month', v_today)::date, p_actor)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('status', 'already_active');
  end;

  insert into ad_budget_events (tenant_id, budget_id, kind, monthly_usd, daily_limit_usd, actor)
  values (p_tenant_id, v_id, 'setup', round(p_monthly_usd, 2), round(p_daily_limit_usd, 2), p_actor);

  return jsonb_build_object('status', 'created', 'budget_id', v_id,
    'month_cap_usd', _ad_budget_month_cap(round(p_monthly_usd, 2), v_today, v_today));
end $$;

create or replace function public.update_ad_budget(
  p_tenant_id       uuid,
  p_actor           uuid,
  p_budget_id       uuid,
  p_monthly_usd     numeric,
  p_daily_limit_usd numeric
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget  ad_budgets%rowtype;
  v_today   date := _ad_budget_today();
  v_monthly numeric(12,2);
  v_cap     numeric(12,2);
  v_used    numeric(12,2);
  v_live_daily numeric(12,2);
begin
  perform _ad_budget_assert_manager(p_tenant_id, p_actor);
  if _tenant_tier(p_tenant_id) <> 'pro' then
    raise exception 'ad_budget: the Pro plan is required' using errcode = '42501';
  end if;
  if p_monthly_usd is null or not (round(p_monthly_usd, 2) > 0 and p_monthly_usd < 10000000) then
    raise exception 'ad_budget: invalid monthly amount' using errcode = '22023';
  end if;
  if p_daily_limit_usd is not null and not (round(p_daily_limit_usd, 2) > 0 and round(p_daily_limit_usd, 2) <= round(p_monthly_usd, 2)) then
    raise exception 'ad_budget: invalid daily limit' using errcode = '22023';
  end if;

  select * into v_budget from ad_budgets
   where id = p_budget_id and tenant_id = p_tenant_id and status = 'active'
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  v_monthly := round(p_monthly_usd, 2);
  v_cap  := _ad_budget_month_cap(v_monthly, v_budget.started_on, v_today);
  v_used := _ad_budget_spent_usd(v_budget.spent_usd, v_budget.month_start, v_today)
          + _ad_budget_held_usd(v_budget.id, v_today, v_budget.margin);
  if v_cap < v_used then
    return jsonb_build_object('status', 'below_used', 'used_usd', v_used, 'month_cap_usd', v_cap);
  end if;

  select coalesce(sum(daily_delta_usd), 0) into v_live_daily
    from ad_budget_reservations
   where budget_id = v_budget.id and status in ('reserved', 'committed');
  if p_daily_limit_usd is not null and round(p_daily_limit_usd, 2) < v_live_daily then
    return jsonb_build_object('status', 'daily_below_live',
      'daily_limit_usd', round(p_daily_limit_usd, 2), 'live_daily_usd', v_live_daily);
  end if;

  update ad_budgets
     set monthly_usd = v_monthly,
         daily_limit_usd = round(p_daily_limit_usd, 2),
         updated_at = now()
   where id = v_budget.id;

  if v_budget.monthly_usd is distinct from v_monthly
     or v_budget.daily_limit_usd is distinct from round(p_daily_limit_usd, 2) then
    insert into ad_budget_events (tenant_id, budget_id, kind, monthly_usd, daily_limit_usd, actor)
    values (p_tenant_id, v_budget.id, 'edit', v_monthly, round(p_daily_limit_usd, 2), p_actor);
  end if;

  update ad_budget_reservations
     set pause_due = false, updated_at = now()
   where budget_id = v_budget.id and status in ('reserved', 'committed') and pause_due;

  return jsonb_build_object('status', 'updated', 'month_cap_usd', v_cap);
end $$;

create or replace function public.stop_ad_budget(
  p_tenant_id uuid,
  p_actor     uuid,
  p_budget_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_status text;
  v_objects jsonb;
begin
  perform _ad_budget_assert_manager(p_tenant_id, p_actor);

  select * into v_budget from ad_budgets
   where id = p_budget_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found', 'objects', '[]'::jsonb);
  end if;

  if v_budget.status = 'active' then
    update ad_budgets
       set status = 'stopped', stopped_at = clock_timestamp(), stopped_by = p_actor, updated_at = now()
     where id = v_budget.id;
    insert into ad_budget_events (tenant_id, budget_id, occurred_at, kind, monthly_usd, daily_limit_usd, actor)
    values (p_tenant_id, v_budget.id,
            (select stopped_at from ad_budgets where id = v_budget.id),
            'stop', v_budget.monthly_usd, v_budget.daily_limit_usd, p_actor);
    v_status := 'stopped';
  else
    v_status := 'already_stopped';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('platform', platform, 'object_id', object_id, 'in_flight', in_flight)
                            order by platform, object_id), '[]'::jsonb)
    into v_objects
    from (
      select platform, object_id, bool_or(status = 'reserved') as in_flight
        from ad_budget_reservations
       where budget_id = v_budget.id and tenant_id = p_tenant_id
         and status in ('reserved', 'committed') and object_id is not null
       group by platform, object_id
    ) o;
  return jsonb_build_object('status', v_status, 'objects', v_objects);
end $$;

revoke all on function public.create_ad_budget(uuid, uuid, numeric, numeric) from public, anon, authenticated;
revoke all on function public.update_ad_budget(uuid, uuid, uuid, numeric, numeric) from public, anon, authenticated;
revoke all on function public.stop_ad_budget(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_ad_budget(uuid, uuid, numeric, numeric) to service_role;
grant execute on function public.update_ad_budget(uuid, uuid, uuid, numeric, numeric) to service_role;
grant execute on function public.stop_ad_budget(uuid, uuid, uuid) to service_role;

insert into ad_budget_events (tenant_id, budget_id, occurred_at, kind, monthly_usd, daily_limit_usd, actor, backfilled)
select b.tenant_id, b.id, b.created_at, 'setup', b.monthly_usd, b.daily_limit_usd, b.created_by, true
  from ad_budgets b
 where not exists (select 1 from ad_budget_events e where e.budget_id = b.id);

insert into ad_budget_events (tenant_id, budget_id, occurred_at, kind, monthly_usd, daily_limit_usd, actor, backfilled)
select b.tenant_id, b.id, b.stopped_at, 'stop', b.monthly_usd, b.daily_limit_usd, b.stopped_by, true
  from ad_budgets b
 where b.status = 'stopped' and b.stopped_at is not null and b.stopped_by is not null
   and not exists (select 1 from ad_budget_events e where e.budget_id = b.id and e.kind = 'stop');

commit;
