begin;

alter table public.ad_budget_reservations
  add column if not exists bounded     boolean not null default false,
  add column if not exists ends_on     date,
  add column if not exists cap_usd     numeric(12,2) check (cap_usd is null or (cap_usd > 0 and cap_usd < 1000000)),
  add column if not exists hold_factor numeric(4,2) check (hold_factor is null or (hold_factor >= 1 and hold_factor <= 5)),
  add column if not exists spend_from  date,
  add column if not exists over_cap    boolean not null default false,
  add column if not exists released_at timestamptz;

create or replace function public._ad_budget_reservation_released_at()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.status = 'released' and old.status is distinct from 'released' then
    new.released_at := now();
  elsif new.status in ('reserved', 'committed') and old.status = 'released' then
    new.released_at := null;
  end if;
  return new;
end $$;
drop trigger if exists ad_budget_reservations_released_at on public.ad_budget_reservations;
create trigger ad_budget_reservations_released_at
  before update on public.ad_budget_reservations
  for each row execute function public._ad_budget_reservation_released_at();
revoke all on function public._ad_budget_reservation_released_at() from public, anon, authenticated;

do $$
declare v text;
begin
  select md5(prosrc) into v from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'reserve_ad_spend';
  if v is distinct from '4ddd78c267ac5cf0d2257c8de2e43687' then
    raise exception 'ad_holds_bounded_by_object: reserve_ad_spend is not the body rebuilt from the migrations (%)', v;
  end if;
  select md5(prosrc) into v from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'rebase_ad_spend_for_object';
  if v is distinct from '6de9c5a5e965288fab61285405760fc1' then
    raise exception 'ad_holds_bounded_by_object: rebase_ad_spend_for_object is not the body rebuilt from the migrations (%)', v;
  end if;
  select md5(prosrc) into v from pg_proc
   where pronamespace = 'public'::regnamespace and proname = '_ad_budget_held_usd';
  if v is distinct from '65c060418712ce02c6e657bf874fa9f0' then
    raise exception 'ad_holds_bounded_by_object: _ad_budget_held_usd is not the body rebuilt from the migrations (%)', v;
  end if;
end $$;

create or replace function public._ad_bounded_hold_usd(r public.ad_budget_reservations, p_today date, p_margin numeric)
returns numeric language sql stable set search_path = public, pg_temp as $$
  select case
    when not r.bounded or r.status = 'refused' then 0
    when r.status = 'released' and (coalesce(r.reason, '') in ('rebased', 'rejected', 'not_landed', 'pending_test_released')
                                    or r.released_at is null or r.released_at < now() - interval '48 hours') then 0
    when r.status in ('reserved', 'committed') and r.cap_usd is null and r.ends_on is not null
         and coalesce(r.spend_from, (r.created_at at time zone 'utc')::date) < date_trunc('month', p_today)::date
      then ceil(r.daily_delta_usd * least(_ad_budget_days_left(p_today), greatest(r.ends_on - p_today, 0)) * p_margin * 100) / 100
    else greatest(r.amount_usd - coalesce((
           select sum(d.amt) from (
             select max(s.amount_usd) as amt
               from ad_spend_daily s
              where s.tenant_id = r.tenant_id and s.platform = r.platform and s.object_id = r.object_id
                and s.spend_date >= coalesce(r.spend_from, (r.created_at at time zone 'utc')::date)
              group by s.spend_date) d), 0), 0)
  end
$$;

create or replace function public._ad_budget_held_usd(p_budget_id uuid, p_today date, p_margin numeric, p_exclude uuid default null)
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
$$;

drop function public.reserve_ad_spend(uuid, text, text, text, text, numeric, uuid, uuid, boolean);
create function public.reserve_ad_spend(
  p_tenant_id       uuid,
  p_idem_key        text,
  p_platform        text,
  p_op              text,
  p_object_id       text,
  p_daily_delta_usd numeric,
  p_channel_action_id uuid default null,
  p_decision_id       uuid default null,
  p_paused            boolean default false,
  p_ends_on           date    default null,
  p_cap_usd           numeric default null,
  p_factor            numeric default null,
  p_over_cap_ok       boolean default false
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
  v_unpause  numeric(12,2) := 0;
  v_extra    numeric(12,2) := 0;
  v_bounded  boolean := p_cap_usd is not null or p_ends_on is not null;
  v_factor   numeric;
begin
  if p_tenant_id is null or p_idem_key is null or btrim(p_idem_key) = '' then
    raise exception 'reserve_ad_spend: tenant and idem_key are required';
  end if;
  if p_platform is null or p_platform not in ('meta', 'google', 'x', 'reddit', 'chatgpt', 'tiktok', 'linkedin') then
    raise exception 'reserve_ad_spend: invalid platform %', p_platform;
  end if;
  if p_op is null or p_op not in ('raise', 'resume', 'create') then
    raise exception 'reserve_ad_spend: invalid op %', p_op;
  end if;
  if p_daily_delta_usd is null or not (p_daily_delta_usd >= 0 and p_daily_delta_usd < 1000000) then
    raise exception 'reserve_ad_spend: invalid daily delta';
  end if;
  if v_bounded and p_op <> 'create' then
    raise exception 'reserve_ad_spend: only a create may be bounded';
  end if;
  if p_cap_usd is not null and not (p_cap_usd > 0 and p_cap_usd < 1000000) then
    raise exception 'reserve_ad_spend: invalid lifetime cap';
  end if;
  if p_factor is not null and not (p_factor >= 1 and p_factor <= 5) then
    raise exception 'reserve_ad_spend: invalid hold factor';
  end if;
  if p_channel_action_id is not null and not exists (
    select 1 from channel_actions where id = p_channel_action_id and tenant_id = p_tenant_id
  ) then
    raise exception 'reserve_ad_spend: channel action not found for tenant';
  end if;
  if p_decision_id is not null and not exists (
    select 1 from decisions where id = p_decision_id and tenant_id = p_tenant_id
  ) then
    raise exception 'reserve_ad_spend: decision not found for tenant';
  end if;

  select * into v_budget from ad_budgets
   where tenant_id = p_tenant_id and status = 'active'
   for update;
  if not found then
    return jsonb_build_object('status', 'no_budget', 'amount_usd', 0, 'reason', null);
  end if;

  if v_budget.read_failed ? p_platform and not exists (
    select 1 from ad_budget_reservations
     where budget_id = v_budget.id and idem_key = p_idem_key and status in ('reserved', 'committed')
  ) then
    return jsonb_build_object('status', 'refused', 'amount_usd', 0, 'reason', 'platform_unread');
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

  v_delta := ceil(p_daily_delta_usd * case when p_platform in ('chatgpt', 'x') then 2 else 1 end * 100) / 100;
  if v_bounded then
    v_factor := coalesce(p_factor, case when p_platform in ('chatgpt', 'x') then 2 else 1 end);
    v_delta := ceil(p_daily_delta_usd * v_factor * 100) / 100;
  end if;
  if p_op = 'resume' then
    v_delta := greatest(v_delta - coalesce((
      select sum(daily_delta_usd) from ad_budget_reservations
       where budget_id = v_budget.id and platform = p_platform
         and object_id = p_object_id and status in ('reserved', 'committed')
         and not pause_due
    ), 0), 0);
  end if;
  v_amt := ceil(v_delta * _ad_budget_days_left(v_today) * v_budget.margin * 100) / 100;
  if p_cap_usd is not null then
    v_amt := ceil(p_cap_usd * v_budget.margin * 100) / 100;
  elsif p_ends_on is not null then
    v_amt := ceil(v_delta * least(_ad_budget_days_left(v_today), greatest(p_ends_on - v_today, 0)) * v_budget.margin * 100) / 100;
  end if;
  if p_paused and p_op = 'create' and not v_bounded then
    v_amt := ceil(v_delta * v_budget.margin * 100) / 100;
  end if;
  if p_op = 'resume' then
    select coalesce(sum(daily_delta_usd), 0) into v_unpause from ad_budget_reservations
     where budget_id = v_budget.id and platform = p_platform and object_id = p_object_id
       and status in ('reserved', 'committed') and paused and not pause_due
       and idem_key <> p_idem_key;
    v_extra := ceil(v_unpause * greatest(_ad_budget_days_left(v_today) - 1, 0) * v_budget.margin * 100) / 100;
    v_amt := v_amt + v_extra;
  end if;
  v_cap := _ad_budget_month_cap(v_budget.monthly_usd, v_budget.started_on, v_today);

  insert into ad_budget_reservations
    (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd,
     bounded, ends_on, cap_usd, hold_factor)
  values
    (v_budget.id, p_tenant_id, p_idem_key, p_platform, p_object_id, p_op, v_delta, v_amt,
     v_bounded, p_ends_on, p_cap_usd, v_factor)
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
           bounded = v_bounded, ends_on = p_ends_on, cap_usd = p_cap_usd, hold_factor = v_factor,
           over_cap = false, spend_from = case when v_bounded then (now() at time zone 'utc')::date end,
           object_id = coalesce(p_object_id, object_id),
           status = 'reserved', reason = null, updated_at = now()
     where id = v_res.id
     returning * into v_res;
  end if;

  if p_channel_action_id is not null or p_decision_id is not null then
    update ad_budget_reservations
       set channel_action_id = coalesce(channel_action_id, p_channel_action_id),
           decision_id = coalesce(decision_id, p_decision_id)
     where id = v_res.id;
  end if;

  update ad_budget_reservations
     set paused = (p_paused and p_op = 'create' and not v_bounded)
   where id = v_res.id and paused is distinct from (p_paused and p_op = 'create' and not v_bounded);

  if v_delta = 0 and v_extra = 0 and not v_bounded then
    if v_unpause > 0 then
      update ad_budget_reservations set paused = false, updated_at = now()
       where budget_id = v_budget.id and platform = p_platform and object_id = p_object_id
         and status in ('reserved', 'committed') and paused and not pause_due and idem_key <> p_idem_key;
    end if;
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
    if v_unpause > 0 then
      update ad_budget_reservations set paused = false, updated_at = now()
       where budget_id = v_budget.id and platform = p_platform and object_id = p_object_id
         and status in ('reserved', 'committed') and paused and not pause_due and idem_key <> p_idem_key;
    end if;
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
  if p_over_cap_ok and v_reason = 'over_month' then
    update ad_budget_reservations set over_cap = true, updated_at = now() where id = v_res.id;
    return jsonb_build_object('status', 'held', 'amount_usd', v_amt, 'reason', 'over_cap', 'month_cap_usd', v_cap);
  end if;
  update ad_budget_reservations
     set status = 'refused', reason = v_reason, updated_at = now()
   where id = v_res.id;
  return jsonb_build_object('status', 'refused', 'amount_usd', v_amt, 'reason', v_reason);
end $$;

create or replace function public.rebase_ad_spend_for_object(
  p_tenant_id     uuid,
  p_platform      text,
  p_object_id     text,
  p_new_daily_usd numeric,
  p_idem_key      text,
  p_cut_usd       numeric default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_today  date;
  v_new    numeric(12,2);
  v_held   numeric(12,2);
  v_paused boolean;
  v_mixed  boolean;
  v_bnd    record;
  v_spent  numeric(12,2);
  v_gross  numeric(12,2);
begin
  if p_tenant_id is null or p_object_id is null or btrim(p_object_id) = ''
     or p_idem_key is null or btrim(p_idem_key) = '' then
    raise exception 'rebase_ad_spend_for_object: tenant, object and idem_key are required';
  end if;
  if p_platform is null or p_platform not in ('meta', 'google', 'x', 'reddit', 'chatgpt', 'tiktok', 'linkedin') then
    raise exception 'rebase_ad_spend_for_object: invalid platform %', p_platform;
  end if;
  if p_new_daily_usd is null or not (p_new_daily_usd >= 0 and p_new_daily_usd < 1000000) then
    raise exception 'rebase_ad_spend_for_object: invalid daily amount';
  end if;
  if p_cut_usd is not null and not (p_cut_usd > 0 and p_cut_usd < 1000000) then
    raise exception 'rebase_ad_spend_for_object: invalid cut amount';
  end if;

  select * into v_budget from ad_budgets
   where tenant_id = p_tenant_id and status = 'active'
   for update;
  if not found then
    return jsonb_build_object('status', 'no_budget');
  end if;

  if exists (select 1 from ad_budget_reservations where budget_id = v_budget.id and idem_key = p_idem_key) then
    return jsonb_build_object('status', 'already_rebased');
  end if;

  if exists (
    select 1 from ad_budget_reservations
     where budget_id = v_budget.id and platform = p_platform and object_id = p_object_id
       and status = 'reserved') then
    return jsonb_build_object('status', 'object_busy');
  end if;

  select coalesce(sum(daily_delta_usd), 0) into v_held from ad_budget_reservations
   where budget_id = v_budget.id and platform = p_platform and object_id = p_object_id
     and status = 'committed';
  if v_held = 0 then
    return jsonb_build_object('status', 'no_hold');
  end if;
  select bool_and(paused), bool_or(paused) and not bool_and(paused) into v_paused, v_mixed
    from ad_budget_reservations
   where budget_id = v_budget.id and platform = p_platform and object_id = p_object_id
     and status = 'committed';
  if v_mixed then
    return jsonb_build_object('status', 'not_lower', 'daily_usd', v_held);
  end if;

  select bool_or(bounded) as any_b, bool_and(bounded) as all_b, bool_or(cap_usd is not null) as any_cap,
         max(ends_on) as ends_on, max(coalesce(hold_factor, 1)) as factor,
         min(coalesce(spend_from, (created_at at time zone 'utc')::date)) as spend_from,
         sum(amount_usd) as gross
    into v_bnd
    from ad_budget_reservations
   where budget_id = v_budget.id and platform = p_platform and object_id = p_object_id
     and status = 'committed';
  if v_bnd.any_b and (not v_bnd.all_b or v_bnd.any_cap) then
    return jsonb_build_object('status', 'not_lower', 'daily_usd', v_held);
  end if;

  v_new := ceil(p_new_daily_usd * case when p_platform in ('chatgpt', 'x') then 2 else 1 end * 100) / 100;
  if p_cut_usd is not null and not exists (
       select 1 from ad_budget_reservations
        where budget_id = v_budget.id and platform = p_platform and object_id = p_object_id
          and status = 'committed' and idem_key like 'shrink:%') then
    v_new := greatest(v_held - floor(p_cut_usd * case when p_platform in ('chatgpt', 'x') then 2 else 1 end * 100) / 100, 0);
  end if;
  if v_bnd.all_b then
    v_new := ceil(p_new_daily_usd * v_bnd.factor * 100) / 100;
    if p_cut_usd is not null then
      v_new := greatest(v_held - floor(p_cut_usd * v_bnd.factor * 100) / 100, 0);
    end if;
  end if;
  if v_new >= v_held then
    return jsonb_build_object('status', 'not_lower', 'daily_usd', v_held);
  end if;

  v_today := _ad_budget_today();
  update ad_budget_reservations
     set status = 'released', released_on = null, reason = 'rebased',
         pause_due = false, updated_at = now()
   where budget_id = v_budget.id and tenant_id = p_tenant_id
     and platform = p_platform and object_id = p_object_id and status = 'committed';

  if v_bnd.all_b then
    select coalesce(sum(d.amt), 0) into v_spent from (
      select max(s.amount_usd) as amt from ad_spend_daily s
       where s.tenant_id = p_tenant_id and s.platform = p_platform and s.object_id = p_object_id
         and s.spend_date >= v_bnd.spend_from
       group by s.spend_date) d;
    v_gross := least(v_bnd.gross,
      v_spent + ceil(v_new * least(_ad_budget_days_left(v_today), greatest(v_bnd.ends_on - v_today, 0)) * v_budget.margin * 100) / 100);
    insert into ad_budget_reservations
      (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status,
       bounded, ends_on, hold_factor, spend_from)
    values
      (v_budget.id, p_tenant_id, p_idem_key, p_platform, p_object_id, 'rebase', v_new, v_gross, 'committed',
       true, v_bnd.ends_on, v_bnd.factor, v_bnd.spend_from);
    return jsonb_build_object('status', 'rebased', 'daily_usd', v_new, 'released_daily_usd', v_held);
  end if;
  insert into ad_budget_reservations
    (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status)
  values
    (v_budget.id, p_tenant_id, p_idem_key, p_platform, p_object_id, 'rebase', v_new,
     ceil(v_new * _ad_budget_days_left(v_today) * v_budget.margin * 100) / 100, 'committed');
  if v_paused then
    update ad_budget_reservations
       set paused = true, amount_usd = ceil(v_new * v_budget.margin * 100) / 100
     where budget_id = v_budget.id and idem_key = p_idem_key;
  end if;

  return jsonb_build_object('status', 'rebased', 'daily_usd', v_new, 'released_daily_usd', v_held);
end $$;

do $$
declare r record; original text; anchor text := 'and not bool_or(r.pause_due)
    ), sets as (';
begin
  select oid into r from pg_proc where pronamespace = 'public'::regnamespace and proname = 'shrink_underdelivering_ad_holds';
  original := pg_get_functiondef(r.oid);
  if position('bool_or(r.bounded)' in original) > 0 then
    raise exception 'ad_holds_bounded_by_object: shrink_underdelivering_ad_holds already skips bounded holds';
  end if;
  if position('r.platform not in (''chatgpt'', ''x'', ''tiktok'', ''linkedin'')' in original) = 0
     or position(anchor in original) = 0 then
    raise exception 'ad_holds_bounded_by_object: shrink_underdelivering_ad_holds no longer matches';
  end if;
  execute replace(original, anchor, 'and not bool_or(r.pause_due) and not bool_or(r.bounded)
    ), sets as (');
end $$;

revoke all on function public.reserve_ad_spend(uuid, text, text, text, text, numeric, uuid, uuid, boolean, date, numeric, numeric, boolean) from public, anon, authenticated;
grant execute on function public.reserve_ad_spend(uuid, text, text, text, text, numeric, uuid, uuid, boolean, date, numeric, numeric, boolean) to service_role;
revoke all on function public._ad_bounded_hold_usd(public.ad_budget_reservations, date, numeric) from public, anon, authenticated;
grant execute on function public._ad_bounded_hold_usd(public.ad_budget_reservations, date, numeric) to service_role;
revoke all on function public._ad_budget_held_usd(uuid, date, numeric, uuid) from public, anon, authenticated;
grant execute on function public._ad_budget_held_usd(uuid, date, numeric, uuid) to service_role;
revoke all on function public.rebase_ad_spend_for_object(uuid, text, text, numeric, text, numeric) from public, anon, authenticated;
grant execute on function public.rebase_ad_spend_for_object(uuid, text, text, numeric, text, numeric) to service_role;

commit;
