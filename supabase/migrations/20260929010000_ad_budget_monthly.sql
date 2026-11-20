
begin;

alter table public.ad_budgets rename column total_usd to monthly_usd;
alter table public.ad_budgets rename column actual_usd to spent_usd;

alter table public.ad_budgets
  add column if not exists started_on          date,
  add column if not exists month_start         date,
  add column if not exists month_note_sent_for date;

update public.ad_budgets
   set started_on  = (created_at at time zone 'utc')::date,
       month_start = date_trunc('month', (created_at at time zone 'utc'))::date
 where started_on is null or month_start is null;

update public.ad_budgets
   set status = 'stopped', stopped_at = coalesce(stopped_at, now()), updated_at = now()
 where status = 'ended';

alter table public.ad_budgets
  alter column started_on  set default ((now() at time zone 'utc')::date),
  alter column started_on  set not null,
  alter column month_start set default (date_trunc('month', (now() at time zone 'utc'))::date),
  alter column month_start set not null;

alter table public.ad_budgets drop constraint if exists ad_budgets_status_check;
alter table public.ad_budgets add constraint ad_budgets_status_check check (status in ('active', 'stopped'));

alter table public.ad_budgets
  drop column if exists ends_on,
  drop column if exists committed_usd,
  drop column if exists end_note_sent_at,
  drop column if exists closed_at;

alter table public.ad_budget_reservations
  add column if not exists released_on date,
  add column if not exists pause_due   boolean not null default false;
alter table public.ad_budget_reservations drop column if exists released_usd;

create or replace function public._ad_budget_today()
returns date language sql stable set search_path = public, pg_temp as $$
  select (now() at time zone 'utc')::date
$$;

create or replace function public._ad_budget_days_left(d date)
returns int language sql immutable set search_path = public, pg_temp as $$
  select ((date_trunc('month', d) + interval '1 month')::date - d)::int
$$;

create or replace function public._ad_budget_days_in_month(d date)
returns int language sql immutable set search_path = public, pg_temp as $$
  select ((date_trunc('month', d) + interval '1 month')::date - date_trunc('month', d)::date)::int
$$;

create or replace function public._ad_budget_month_cap(p_monthly numeric, p_started_on date, p_today date)
returns numeric language sql immutable set search_path = public, pg_temp as $$
  select (case
    when date_trunc('month', p_started_on) = date_trunc('month', p_today)
      then floor(p_monthly * _ad_budget_days_left(p_started_on) / _ad_budget_days_in_month(p_started_on) * 100) / 100
    else p_monthly
  end)::numeric(12,2)
$$;

create or replace function public._ad_budget_held_usd(p_budget_id uuid, p_today date, p_margin numeric, p_exclude uuid default null)
returns numeric language sql stable set search_path = public, pg_temp as $$
  select (ceil(coalesce(sum(
           case
             when r.status in ('reserved', 'committed') then r.daily_delta_usd * _ad_budget_days_left(p_today)
             when r.status = 'released' and r.released_on = p_today then r.daily_delta_usd
             else 0
           end), 0) * p_margin * 100) / 100)::numeric(12,2)
    from ad_budget_reservations r
   where r.budget_id = p_budget_id
     and (p_exclude is null or r.id <> p_exclude)
$$;

create or replace function public._ad_budget_spent_usd(p_spent numeric, p_month_start date, p_today date)
returns numeric language sql immutable set search_path = public, pg_temp as $$
  select case when p_month_start = date_trunc('month', p_today)::date then greatest(p_spent, 0) else 0 end
$$;

create or replace function public.reserve_ad_spend(
  p_tenant_id       uuid,
  p_idem_key        text,
  p_platform        text,
  p_op              text,
  p_object_id       text,
  p_daily_delta_usd numeric
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget   ad_budgets%rowtype;
  v_res      ad_budget_reservations%rowtype;
  v_today    date;
  v_delta    numeric(12,2);
  v_amt      numeric(12,2);
  v_cap      numeric(12,2);
  v_reason   text;
  v_updated  uuid;
begin
  if p_tenant_id is null or p_idem_key is null or btrim(p_idem_key) = '' then
    raise exception 'reserve_ad_spend: tenant and idem_key are required';
  end if;
  if p_platform is null or p_platform not in ('meta', 'google') then
    raise exception 'reserve_ad_spend: invalid platform %', p_platform;
  end if;
  if p_op is null or p_op not in ('raise', 'resume', 'create') then
    raise exception 'reserve_ad_spend: invalid op %', p_op;
  end if;
  if p_daily_delta_usd is null or not (p_daily_delta_usd >= 0 and p_daily_delta_usd < 1000000) then
    raise exception 'reserve_ad_spend: invalid daily delta';
  end if;

  select * into v_budget from ad_budgets
   where tenant_id = p_tenant_id and status = 'active'
   for update;
  if not found then
    return jsonb_build_object('status', 'no_budget', 'amount_usd', 0, 'reason', null);
  end if;

  v_today := _ad_budget_today();

  if p_op in ('raise', 'resume')
     and exists (
       select 1 from ad_budget_reservations
        where budget_id = v_budget.id and platform = p_platform and object_id = p_object_id
          and status = 'reserved' and idem_key <> p_idem_key)
     and not exists (
       select 1 from ad_budget_reservations
        where budget_id = v_budget.id and idem_key = p_idem_key
          and status in ('reserved', 'committed')) then
    return jsonb_build_object('status', 'refused', 'amount_usd', 0, 'reason', 'object_busy');
  end if;

  v_delta := ceil(p_daily_delta_usd * 100) / 100;
  if p_op in ('raise', 'resume') then
    v_delta := greatest(v_delta - coalesce((
      select sum(daily_delta_usd) from ad_budget_reservations
       where budget_id = v_budget.id and platform = p_platform
         and object_id = p_object_id and status in ('reserved', 'committed')
         and not pause_due
    ), 0), 0);
  end if;
  v_amt := ceil(v_delta * _ad_budget_days_left(v_today) * v_budget.margin * 100) / 100;
  v_cap := _ad_budget_month_cap(v_budget.monthly_usd, v_budget.started_on, v_today);

  insert into ad_budget_reservations
    (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd)
  values
    (v_budget.id, p_tenant_id, p_idem_key, p_platform, p_object_id, p_op, v_delta, v_amt)
  on conflict (budget_id, idem_key) do nothing
  returning * into v_res;

  if not found then
    select * into v_res from ad_budget_reservations
     where budget_id = v_budget.id and idem_key = p_idem_key
     for update;
    if v_res.status in ('reserved', 'committed') then
      return jsonb_build_object('status', 'already_held', 'amount_usd', v_res.amount_usd, 'reason', null,
        'month_cap_usd', v_cap);
    end if;
    update ad_budget_reservations
       set daily_delta_usd = v_delta, amount_usd = v_amt, released_on = null, pause_due = false,
           object_id = coalesce(p_object_id, object_id),
           status = 'reserved', reason = null, updated_at = now()
     where id = v_res.id
     returning * into v_res;
  end if;

  if v_delta = 0 then
    return jsonb_build_object('status', 'held', 'amount_usd', v_amt, 'reason', null, 'month_cap_usd', v_cap);
  end if;

  update ad_budgets
     set updated_at = now()
   where id = v_budget.id
     and status = 'active'
     and _ad_budget_spent_usd(spent_usd, month_start, v_today)
         + _ad_budget_held_usd(v_budget.id, v_today, margin, v_res.id)
         + v_amt <= v_cap
     and (daily_limit_usd is null or coalesce((
           select sum(x.daily_delta_usd) from ad_budget_reservations x
            where x.budget_id = v_budget.id and x.id <> v_res.id
              and x.status in ('reserved', 'committed')
         ), 0) + v_delta <= daily_limit_usd)
  returning id into v_updated;
  if v_updated is not null then
    return jsonb_build_object('status', 'held', 'amount_usd', v_amt, 'reason', null, 'month_cap_usd', v_cap);
  end if;

  v_reason := case
    when v_budget.daily_limit_usd is not null and coalesce((
           select sum(x.daily_delta_usd) from ad_budget_reservations x
            where x.budget_id = v_budget.id and x.id <> v_res.id
              and x.status in ('reserved', 'committed')
         ), 0) + v_delta > v_budget.daily_limit_usd
      then 'over_daily_limit'
    else 'over_month'
  end;
  update ad_budget_reservations
     set status = 'refused', reason = v_reason, updated_at = now()
   where id = v_res.id;
  return jsonb_build_object('status', 'refused', 'amount_usd', v_amt, 'reason', v_reason);
end $$;

create or replace function public.settle_ad_spend(
  p_tenant_id uuid,
  p_idem_key  text,
  p_outcome   text,
  p_object_id text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget_id uuid;
  v_res       ad_budget_reservations%rowtype;
begin
  if p_tenant_id is null or p_idem_key is null then
    raise exception 'settle_ad_spend: tenant and idem_key are required';
  end if;
  if p_outcome is null or p_outcome not in ('committed', 'released') then
    raise exception 'settle_ad_spend: invalid outcome %', p_outcome;
  end if;

  select budget_id into v_budget_id from ad_budget_reservations
   where tenant_id = p_tenant_id and idem_key = p_idem_key
   order by created_at desc limit 1;
  if v_budget_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform 1 from ad_budgets where id = v_budget_id and tenant_id = p_tenant_id for update;
  select * into v_res from ad_budget_reservations
   where budget_id = v_budget_id and idem_key = p_idem_key and tenant_id = p_tenant_id
   for update;
  if v_res.status <> 'reserved' then
    return jsonb_build_object('status', v_res.status);
  end if;

  if p_outcome = 'committed' then
    update ad_budget_reservations
       set status = 'committed', object_id = coalesce(object_id, p_object_id), updated_at = now()
     where id = v_res.id;
    return jsonb_build_object('status', 'committed');
  end if;

  update ad_budget_reservations
     set status = 'released', reason = 'rejected', released_on = null, pause_due = false, updated_at = now()
   where id = v_res.id;
  return jsonb_build_object('status', 'released');
end $$;

create or replace function public.release_ad_spend_for_object(
  p_tenant_id uuid,
  p_platform  text,
  p_object_id text,
  p_budget_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_today  date;
  v_daily  numeric(12,2);
begin
  if p_tenant_id is null or p_platform is null or p_object_id is null then
    raise exception 'release_ad_spend_for_object: tenant, platform and object are required';
  end if;

  if p_budget_id is null then
    select * into v_budget from ad_budgets
     where tenant_id = p_tenant_id and status = 'active'
     for update;
  else
    select * into v_budget from ad_budgets
     where id = p_budget_id and tenant_id = p_tenant_id and status in ('active', 'stopped')
     for update;
  end if;
  if not found then
    return jsonb_build_object('status', 'no_budget', 'released_usd', 0);
  end if;

  v_today := _ad_budget_today();
  with rel as (
    update ad_budget_reservations
       set status = 'released', released_on = v_today,
           reason = case
                      when v_budget.status = 'stopped' then 'budget_stopped'
                      when pause_due then 'month_rollover'
                      else 'paused'
                    end,
           pause_due = false, updated_at = now()
     where budget_id = v_budget.id and tenant_id = p_tenant_id
       and platform = p_platform and object_id = p_object_id and status = 'committed'
    returning daily_delta_usd
  )
  select coalesce(sum(daily_delta_usd), 0) into v_daily from rel;

  return jsonb_build_object('status', 'released',
    'released_usd', (floor(v_daily * greatest(_ad_budget_days_left(v_today) - 1, 0) * v_budget.margin * 100) / 100)::numeric(12,2));
end $$;

drop function if exists public.create_ad_budget(uuid, uuid, numeric, numeric, date);
drop function if exists public.update_ad_budget(uuid, uuid, uuid, numeric, numeric, date);

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

  update ad_budget_reservations
     set pause_due = false, updated_at = now()
   where budget_id = v_budget.id and status in ('reserved', 'committed') and pause_due;

  return jsonb_build_object('status', 'updated', 'month_cap_usd', v_cap);
end $$;

create or replace function public.start_ad_budget_month(
  p_tenant_id uuid,
  p_budget_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget  ad_budgets%rowtype;
  v_today   date;
  v_month   date;
  v_cap     numeric(12,2);
  v_rate    numeric;
  v_obj     record;
  v_rolled  boolean := false;
  v_pending jsonb;
  v_paused  jsonb;
  v_need    numeric;
begin
  if p_tenant_id is null or p_budget_id is null then
    raise exception 'start_ad_budget_month: tenant and budget are required';
  end if;

  select * into v_budget from ad_budgets
   where id = p_budget_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_budget.status <> 'active' then
    return jsonb_build_object('status', v_budget.status);
  end if;

  v_today := _ad_budget_today();
  v_month := date_trunc('month', v_today)::date;
  v_cap   := _ad_budget_month_cap(v_budget.monthly_usd, v_budget.started_on, v_today);

  if v_budget.month_start < v_month then
    update ad_budgets
       set month_start = v_month, spent_usd = 0, alarm_90_sent_at = null,
           actual_read_at = null, month_note_sent_for = null, updated_at = now()
     where id = v_budget.id
    returning * into v_budget;
    v_rolled := true;

    select coalesce(sum(daily_delta_usd), 0) into v_rate
      from ad_budget_reservations
     where budget_id = v_budget.id and status in ('reserved', 'committed');

    for v_obj in
      select platform, object_id, sum(daily_delta_usd) as rate
        from ad_budget_reservations
       where budget_id = v_budget.id and status in ('reserved', 'committed') and object_id is not null
       group by platform, object_id
       order by sum(daily_delta_usd) desc, platform, object_id
    loop
      v_need := ceil(v_rate * _ad_budget_days_in_month(v_today) * v_budget.margin * 100) / 100;
      exit when v_need <= v_cap;
      update ad_budget_reservations
         set pause_due = true, updated_at = now()
       where budget_id = v_budget.id and platform = v_obj.platform and object_id = v_obj.object_id
         and status in ('reserved', 'committed');
      v_rate := v_rate - v_obj.rate;
    end loop;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('platform', platform, 'object_id', object_id,
                            'daily_usd', rate, 'in_flight', in_flight)
                            order by rate desc, platform, object_id), '[]'::jsonb)
    into v_pending
    from (
      select platform, object_id, sum(daily_delta_usd) as rate, bool_or(status = 'reserved') as in_flight
        from ad_budget_reservations
       where budget_id = v_budget.id and status in ('reserved', 'committed')
         and pause_due and object_id is not null
       group by platform, object_id
    ) o;

  select coalesce(jsonb_agg(jsonb_build_object('platform', platform, 'object_id', object_id, 'daily_usd', rate)
                            order by rate desc, platform, object_id), '[]'::jsonb)
    into v_paused
    from (
      select platform, object_id, sum(daily_delta_usd) as rate
        from ad_budget_reservations
       where budget_id = v_budget.id and status = 'released' and reason = 'month_rollover'
         and released_on >= v_budget.month_start and object_id is not null
       group by platform, object_id
    ) p;

  return jsonb_build_object(
    'status', 'active',
    'rolled', v_rolled,
    'month_start', v_budget.month_start,
    'month_cap_usd', v_cap,
    'monthly_usd', v_budget.monthly_usd,
    'pause', v_pending,
    'paused_before', v_paused,
    'note_due', v_budget.month_note_sent_for is distinct from v_budget.month_start
                and (jsonb_array_length(v_pending) > 0 or jsonb_array_length(v_paused) > 0));
end $$;

create or replace function public.claim_ad_budget_month_note(
  p_tenant_id uuid,
  p_budget_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if p_tenant_id is null or p_budget_id is null then
    raise exception 'claim_ad_budget_month_note: tenant and budget are required';
  end if;
  update ad_budgets set month_note_sent_for = month_start, updated_at = now()
   where id = p_budget_id and tenant_id = p_tenant_id and status = 'active'
     and month_note_sent_for is distinct from month_start
  returning id into v_id;
  return jsonb_build_object('claimed', v_id is not null);
end $$;

create or replace function public.release_ad_budget_month_note(
  p_tenant_id uuid,
  p_budget_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if p_tenant_id is null or p_budget_id is null then
    raise exception 'release_ad_budget_month_note: tenant and budget are required';
  end if;
  update ad_budgets set month_note_sent_for = null, updated_at = now()
   where id = p_budget_id and tenant_id = p_tenant_id
  returning id into v_id;
  return jsonb_build_object('status', case when v_id is null then 'not_found' else 'released' end);
end $$;

drop function if exists public.record_ad_budget_actual(uuid, uuid, numeric);
create or replace function public.record_ad_budget_actual(
  p_tenant_id  uuid,
  p_budget_id  uuid,
  p_actual_usd numeric,
  p_month      date
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_today  date;
  v_cap    numeric(12,2);
  v_alarm  boolean := false;
begin
  if p_tenant_id is null or p_budget_id is null then
    raise exception 'record_ad_budget_actual: tenant and budget are required';
  end if;
  if p_actual_usd is not null and not (p_actual_usd >= 0 and p_actual_usd < 1000000000) then
    raise exception 'record_ad_budget_actual: invalid actual';
  end if;

  select * into v_budget from ad_budgets
   where id = p_budget_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found', 'alarm', false);
  end if;
  v_today := _ad_budget_today();
  v_cap := _ad_budget_month_cap(v_budget.monthly_usd, v_budget.started_on, v_today);
  if v_budget.status <> 'active' or v_budget.month_start <> date_trunc('month', v_today)::date then
    return jsonb_build_object('status', case when v_budget.status <> 'active' then v_budget.status else 'month_not_started' end,
      'spent_usd', v_budget.spent_usd, 'month_cap_usd', v_cap, 'alarm', false);
  end if;

  if p_actual_usd is not null and p_month = v_budget.month_start then
    update ad_budgets
       set spent_usd = greatest(spent_usd, ceil(p_actual_usd * 100) / 100),
           actual_read_at = now(), updated_at = now()
     where id = v_budget.id
    returning * into v_budget;
  end if;

  if v_budget.alarm_90_sent_at is null and v_budget.spent_usd >= v_cap * 0.9 then
    update ad_budgets set alarm_90_sent_at = now(), updated_at = now()
     where id = v_budget.id
    returning * into v_budget;
    v_alarm := true;
  end if;

  return jsonb_build_object('status', v_budget.status, 'spent_usd', v_budget.spent_usd,
    'month_cap_usd', v_cap, 'alarm', v_alarm);
end $$;

create or replace function public.ad_budget_month_view(p_tenant_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_today  date := _ad_budget_today();
  v_cap    numeric(12,2);
  v_spent  numeric(12,2);
  v_held   numeric(12,2);
begin
  if p_tenant_id is null then
    raise exception 'ad_budget_month_view: tenant is required';
  end if;
  select * into v_budget from ad_budgets
   where tenant_id = p_tenant_id
   order by (status = 'active') desc, created_at desc
   limit 1;
  if not found then
    return null;
  end if;
  v_cap   := _ad_budget_month_cap(v_budget.monthly_usd, v_budget.started_on, v_today);
  v_spent := _ad_budget_spent_usd(v_budget.spent_usd, v_budget.month_start, v_today);
  v_held  := _ad_budget_held_usd(v_budget.id, v_today, v_budget.margin);
  return jsonb_build_object(
    'id', v_budget.id,
    'status', v_budget.status,
    'monthly_usd', v_budget.monthly_usd,
    'daily_limit_usd', v_budget.daily_limit_usd,
    'started_on', v_budget.started_on,
    'created_at', v_budget.created_at,
    'stopped_at', v_budget.stopped_at,
    'today', v_today,
    'month_start', date_trunc('month', v_today)::date,
    'next_month_start', (date_trunc('month', v_today) + interval '1 month')::date,
    'days_left', _ad_budget_days_left(v_today),
    'days_in_month', _ad_budget_days_in_month(v_today),
    'month_cap_usd', v_cap,
    'spent_usd', v_spent,
    'held_usd', v_held,
    'left_usd', greatest(v_cap - v_spent - v_held, 0));
end $$;

drop function if exists public.ended_ad_budget_holds(uuid, uuid);
drop function if exists public.claim_ad_budget_end_note(uuid, uuid);
drop function if exists public.release_ad_budget_end_note(uuid, uuid);

revoke all on function public._ad_budget_today() from public, anon, authenticated;
revoke all on function public._ad_budget_days_left(date) from public, anon, authenticated;
revoke all on function public._ad_budget_days_in_month(date) from public, anon, authenticated;
revoke all on function public._ad_budget_month_cap(numeric, date, date) from public, anon, authenticated;
revoke all on function public._ad_budget_held_usd(uuid, date, numeric, uuid) from public, anon, authenticated;
revoke all on function public._ad_budget_spent_usd(numeric, date, date) from public, anon, authenticated;
revoke all on function public.reserve_ad_spend(uuid, text, text, text, text, numeric) from public, anon, authenticated;
revoke all on function public.settle_ad_spend(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.release_ad_spend_for_object(uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.create_ad_budget(uuid, uuid, numeric, numeric) from public, anon, authenticated;
revoke all on function public.update_ad_budget(uuid, uuid, uuid, numeric, numeric) from public, anon, authenticated;
revoke all on function public.start_ad_budget_month(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_ad_budget_month_note(uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_ad_budget_month_note(uuid, uuid) from public, anon, authenticated;
revoke all on function public.record_ad_budget_actual(uuid, uuid, numeric, date) from public, anon, authenticated;
revoke all on function public.ad_budget_month_view(uuid) from public, anon, authenticated;

grant execute on function public._ad_budget_today() to service_role;
grant execute on function public._ad_budget_days_left(date) to service_role;
grant execute on function public._ad_budget_days_in_month(date) to service_role;
grant execute on function public._ad_budget_month_cap(numeric, date, date) to service_role;
grant execute on function public._ad_budget_held_usd(uuid, date, numeric, uuid) to service_role;
grant execute on function public._ad_budget_spent_usd(numeric, date, date) to service_role;
grant execute on function public.reserve_ad_spend(uuid, text, text, text, text, numeric) to service_role;
grant execute on function public.settle_ad_spend(uuid, text, text, text) to service_role;
grant execute on function public.release_ad_spend_for_object(uuid, text, text, uuid) to service_role;
grant execute on function public.create_ad_budget(uuid, uuid, numeric, numeric) to service_role;
grant execute on function public.update_ad_budget(uuid, uuid, uuid, numeric, numeric) to service_role;
grant execute on function public.start_ad_budget_month(uuid, uuid) to service_role;
grant execute on function public.claim_ad_budget_month_note(uuid, uuid) to service_role;
grant execute on function public.release_ad_budget_month_note(uuid, uuid) to service_role;
grant execute on function public.record_ad_budget_actual(uuid, uuid, numeric, date) to service_role;
grant execute on function public.ad_budget_month_view(uuid) to service_role;

commit;
