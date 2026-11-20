
begin;

create table if not exists public.cgo_creator_caps (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  per_hire_usd numeric(12,2) not null check (per_hire_usd > 0 and per_hire_usd < 1000000),
  per_week_usd numeric(12,2) not null check (per_week_usd > 0 and per_week_usd < 1000000),
  why          text not null check (char_length(btrim(why)) between 1 and 300),
  run_id       uuid references public.agent_runs(id) on delete set null,
  created_at   timestamptz not null default now()
);

create table if not exists public.creator_hire_spend (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  budget_id    uuid not null references public.ad_budgets(id) on delete cascade,
  caps_id      uuid not null references public.cgo_creator_caps(id),
  idem_key     text not null check (char_length(idem_key) between 1 and 200),
  order_id     uuid not null references public.creator_orders(id),
  amount_usd   numeric(12,2) not null check (amount_usd > 0),
  refunded_usd numeric(12,2) not null default 0 check (refunded_usd >= 0 and refunded_usd <= amount_usd),
  state        text not null default 'held' check (state in ('held', 'spent', 'released', 'refunded')),
  reserved_on  date not null,
  created_at   timestamptz not null default now(),
  settled_at   timestamptz,
  unique (budget_id, idem_key)
);

create unique index if not exists creator_hire_spend_one_live_per_order
  on public.creator_hire_spend (order_id) where state in ('held', 'spent', 'refunded');

alter table public.cgo_creator_caps enable row level security;
alter table public.creator_hire_spend enable row level security;

create policy cgo_creator_caps_member_select on public.cgo_creator_caps
  for select using (
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = cgo_creator_caps.tenant_id
    )
  );
create policy cgo_creator_caps_active_tenant_restrict
  on public.cgo_creator_caps as restrictive for select
  using (tenant_id = (select public.app_active_tenant()));

create policy creator_hire_spend_member_select on public.creator_hire_spend
  for select using (
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = creator_hire_spend.tenant_id
    )
  );
create policy creator_hire_spend_active_tenant_restrict
  on public.creator_hire_spend as restrictive for select
  using (tenant_id = (select public.app_active_tenant()));

revoke all on public.cgo_creator_caps, public.creator_hire_spend from public, anon;
revoke insert, update, delete, truncate on public.cgo_creator_caps, public.creator_hire_spend from authenticated;
grant select on public.cgo_creator_caps, public.creator_hire_spend to authenticated;
revoke all on public.cgo_creator_caps, public.creator_hire_spend from service_role;
grant select on public.cgo_creator_caps, public.creator_hire_spend to service_role;

create or replace function public._creator_hire_used_usd(p_budget_id uuid, p_today date)
returns numeric language sql stable set search_path = public, pg_temp as $$
  select coalesce(sum(case
           when s.state = 'held' then s.amount_usd
           when s.state in ('spent', 'refunded') then s.amount_usd - s.refunded_usd
           else 0
         end), 0)::numeric(12,2)
    from creator_hire_spend s
   where s.budget_id = p_budget_id
     and date_trunc('month', s.reserved_on) = date_trunc('month', p_today)
$$;

create or replace function public.record_cgo_creator_caps(
  p_tenant_id    uuid,
  p_per_hire_usd numeric,
  p_per_week_usd numeric,
  p_why          text,
  p_run_id       uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if p_tenant_id is null then
    raise exception 'record_cgo_creator_caps: tenant is required';
  end if;
  if p_per_hire_usd is null or not (round(p_per_hire_usd, 2) > 0 and p_per_hire_usd < 1000000)
     or p_per_week_usd is null or not (round(p_per_week_usd, 2) > 0 and p_per_week_usd < 1000000) then
    raise exception 'record_cgo_creator_caps: invalid cap';
  end if;
  if p_why is null or char_length(btrim(p_why)) not between 1 and 300 then
    raise exception 'record_cgo_creator_caps: invalid why';
  end if;
  if p_run_id is not null and not exists (
    select 1 from agent_runs where id = p_run_id and tenant_id = p_tenant_id
  ) then
    raise exception 'record_cgo_creator_caps: run not found for tenant';
  end if;

  insert into cgo_creator_caps (tenant_id, per_hire_usd, per_week_usd, why, run_id)
  values (p_tenant_id, round(p_per_hire_usd, 2), round(p_per_week_usd, 2), btrim(p_why), p_run_id)
  returning id into v_id;
  return jsonb_build_object('status', 'recorded', 'id', v_id);
end $$;

create or replace function public.reserve_creator_hire(
  p_tenant_id  uuid,
  p_idem_key   text,
  p_order_id   uuid,
  p_amount_usd numeric,
  p_caps_id    uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_caps   cgo_creator_caps%rowtype;
  v_row    creator_hire_spend%rowtype;
  v_today  date;
  v_amt    numeric(12,2);
  v_week   numeric(12,2);
  v_left   numeric(12,2);
begin
  if p_tenant_id is null or p_order_id is null or p_idem_key is null
     or char_length(btrim(p_idem_key)) not between 1 and 200 then
    raise exception 'reserve_creator_hire: tenant, order and idem_key are required';
  end if;
  if p_amount_usd is null or not (p_amount_usd > 0 and p_amount_usd < 1000000) then
    raise exception 'reserve_creator_hire: invalid amount';
  end if;
  v_amt := ceil(p_amount_usd * 100) / 100;

  select * into v_budget from ad_budgets
   where tenant_id = p_tenant_id and status = 'active'
   for update;
  if not found then
    return jsonb_build_object('status', 'no_budget', 'amount_usd', 0);
  end if;

  if not exists (select 1 from creator_orders where id = p_order_id and tenant_id = p_tenant_id) then
    raise exception 'reserve_creator_hire: order not found for tenant';
  end if;

  v_today := _ad_budget_today();

  select * into v_row from creator_hire_spend
   where budget_id = v_budget.id and idem_key = p_idem_key
   for update;
  if found then
    if v_row.order_id <> p_order_id then
      raise exception 'reserve_creator_hire: idem_key belongs to another order';
    end if;
    if v_row.state in ('held', 'spent', 'refunded') then
      return jsonb_build_object('status', 'already_held', 'amount_usd', v_row.amount_usd, 'state', v_row.state);
    end if;
  end if;
  if exists (
    select 1 from creator_hire_spend
     where order_id = p_order_id and state in ('held', 'spent', 'refunded') and idem_key <> p_idem_key
  ) then
    raise exception 'reserve_creator_hire: the order already has a live reservation';
  end if;

  select * into v_caps from cgo_creator_caps
   where id = p_caps_id and tenant_id = p_tenant_id;
  if not found then
    return jsonb_build_object('status', 'no_caps', 'amount_usd', v_amt);
  end if;

  if v_amt > v_caps.per_hire_usd then
    return jsonb_build_object('status', 'over_hire_cap', 'amount_usd', v_amt, 'per_hire_usd', v_caps.per_hire_usd);
  end if;

  select coalesce(sum(case when s.state = 'held' then s.amount_usd else s.amount_usd - s.refunded_usd end), 0)
    into v_week
    from creator_hire_spend s
   where s.tenant_id = p_tenant_id
     and s.state in ('held', 'spent')
     and s.reserved_on > v_today - 7;
  if v_week + v_amt > v_caps.per_week_usd then
    return jsonb_build_object('status', 'over_week_cap', 'amount_usd', v_amt,
      'per_week_usd', v_caps.per_week_usd, 'week_used_usd', v_week);
  end if;

  v_left := _ad_budget_month_cap(v_budget.monthly_usd, v_budget.started_on, v_today)
          - _ad_budget_spent_usd(v_budget.spent_usd, v_budget.month_start, v_today)
          - _ad_budget_held_usd(v_budget.id, v_today, v_budget.margin)
          - _creator_hire_used_usd(v_budget.id, v_today);
  if v_amt > v_left then
    return jsonb_build_object('status', 'over_budget', 'amount_usd', v_amt, 'left_usd', greatest(v_left, 0));
  end if;

  if v_row.id is null then
    insert into creator_hire_spend
      (tenant_id, budget_id, caps_id, idem_key, order_id, amount_usd, state, reserved_on)
    values
      (p_tenant_id, v_budget.id, v_caps.id, p_idem_key, p_order_id, v_amt, 'held', v_today);
  else
    update creator_hire_spend
       set caps_id = v_caps.id, amount_usd = v_amt, refunded_usd = 0, state = 'held',
           reserved_on = v_today, settled_at = null
     where id = v_row.id;
  end if;

  return jsonb_build_object('status', 'reserved', 'amount_usd', v_amt, 'left_usd', v_left - v_amt);
end $$;

create or replace function public.settle_creator_hire(
  p_tenant_id uuid,
  p_idem_key  text,
  p_outcome   text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget_id uuid;
  v_row       creator_hire_spend%rowtype;
begin
  if p_tenant_id is null or p_idem_key is null then
    raise exception 'settle_creator_hire: tenant and idem_key are required';
  end if;
  if p_outcome is null or p_outcome not in ('spent', 'released') then
    raise exception 'settle_creator_hire: invalid outcome %', p_outcome;
  end if;

  select budget_id into v_budget_id from creator_hire_spend
   where tenant_id = p_tenant_id and idem_key = p_idem_key
   order by created_at desc limit 1;
  if v_budget_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform 1 from ad_budgets where id = v_budget_id and tenant_id = p_tenant_id for update;
  select * into v_row from creator_hire_spend
   where budget_id = v_budget_id and idem_key = p_idem_key and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_row.state = p_outcome
     or v_row.state = 'refunded'
     or (v_row.state = 'spent' and p_outcome = 'released') then
    return jsonb_build_object('status', v_row.state, 'changed', false);
  end if;

  update creator_hire_spend
     set state = p_outcome, settled_at = now()
   where id = v_row.id;
  return jsonb_build_object('status', p_outcome, 'changed', true);
end $$;

create or replace function public.refund_creator_hire(
  p_tenant_id  uuid,
  p_order_id   uuid,
  p_amount_usd numeric
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget_id uuid;
  v_row       creator_hire_spend%rowtype;
  v_refunded  numeric(12,2);
begin
  if p_tenant_id is null or p_order_id is null then
    raise exception 'refund_creator_hire: tenant and order are required';
  end if;
  if p_amount_usd is null or not (p_amount_usd > 0 and p_amount_usd < 1000000) then
    raise exception 'refund_creator_hire: invalid amount';
  end if;

  select budget_id into v_budget_id from creator_hire_spend
   where tenant_id = p_tenant_id and order_id = p_order_id and state in ('spent', 'refunded');
  if v_budget_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform 1 from ad_budgets where id = v_budget_id and tenant_id = p_tenant_id for update;
  select * into v_row from creator_hire_spend
   where budget_id = v_budget_id and tenant_id = p_tenant_id and order_id = p_order_id
     and state in ('spent', 'refunded')
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  v_refunded := least(v_row.amount_usd, greatest(v_row.refunded_usd, floor(p_amount_usd * 100) / 100));
  update creator_hire_spend
     set refunded_usd = v_refunded,
         state = case when v_refunded = amount_usd then 'refunded' else 'spent' end,
         settled_at = coalesce(settled_at, now())
   where id = v_row.id;
  return jsonb_build_object(
    'status', case when v_refunded = v_row.amount_usd then 'refunded' else 'partially_refunded' end,
    'refunded_usd', v_refunded);
end $$;

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
         + _creator_hire_used_usd(v_budget.id, v_today)
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

create or replace function public.ad_budget_month_view(p_tenant_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_today  date := _ad_budget_today();
  v_cap    numeric(12,2);
  v_spent  numeric(12,2);
  v_held   numeric(12,2);
  v_cr_held  numeric(12,2);
  v_cr_spent numeric(12,2);
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
  select coalesce(sum(case when s.state = 'held' then s.amount_usd else 0 end), 0),
         coalesce(sum(case when s.state in ('spent', 'refunded') then s.amount_usd - s.refunded_usd else 0 end), 0)
    into v_cr_held, v_cr_spent
    from creator_hire_spend s
   where s.budget_id = v_budget.id
     and date_trunc('month', s.reserved_on) = date_trunc('month', v_today);
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
    'creator_held_usd', v_cr_held,
    'creator_spent_usd', v_cr_spent,
    'left_usd', greatest(v_cap - v_spent - v_held - v_cr_held - v_cr_spent, 0));
end $$;

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
  if exists (
    select 1 from ad_budgets b
      join creator_hire_spend s on s.budget_id = b.id
     where b.tenant_id = p_tenant_id and b.status = 'stopped'
       and s.state = 'held'
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
          + _ad_budget_held_usd(v_budget.id, v_today, v_budget.margin)
          + _creator_hire_used_usd(v_budget.id, v_today);
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

revoke all on function public._creator_hire_used_usd(uuid, date) from public, anon, authenticated;
revoke all on function public.record_cgo_creator_caps(uuid, numeric, numeric, text, uuid) from public, anon, authenticated;
revoke all on function public.reserve_creator_hire(uuid, text, uuid, numeric, uuid) from public, anon, authenticated;
revoke all on function public.settle_creator_hire(uuid, text, text) from public, anon, authenticated;
revoke all on function public.refund_creator_hire(uuid, uuid, numeric) from public, anon, authenticated;
revoke all on function public.reserve_ad_spend(uuid, text, text, text, text, numeric) from public, anon, authenticated;
revoke all on function public.ad_budget_month_view(uuid) from public, anon, authenticated;
revoke all on function public.create_ad_budget(uuid, uuid, numeric, numeric) from public, anon, authenticated;
revoke all on function public.update_ad_budget(uuid, uuid, uuid, numeric, numeric) from public, anon, authenticated;

grant execute on function public._creator_hire_used_usd(uuid, date) to service_role;
grant execute on function public.record_cgo_creator_caps(uuid, numeric, numeric, text, uuid) to service_role;
grant execute on function public.reserve_creator_hire(uuid, text, uuid, numeric, uuid) to service_role;
grant execute on function public.settle_creator_hire(uuid, text, text) to service_role;
grant execute on function public.refund_creator_hire(uuid, uuid, numeric) to service_role;
grant execute on function public.reserve_ad_spend(uuid, text, text, text, text, numeric) to service_role;
grant execute on function public.ad_budget_month_view(uuid) to service_role;
grant execute on function public.create_ad_budget(uuid, uuid, numeric, numeric) to service_role;
grant execute on function public.update_ad_budget(uuid, uuid, uuid, numeric, numeric) to service_role;

commit;
