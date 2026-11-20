
begin;

create or replace function public.reserve_ad_spend(
  p_tenant_id       uuid,
  p_idem_key        text,
  p_platform        text,
  p_op              text,
  p_object_id       text,
  p_daily_delta_usd numeric,
  p_channel_action_id uuid default null,
  p_decision_id       uuid default null,
  p_paused            boolean default false
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
  if p_op = 'resume' then
    v_delta := greatest(v_delta - coalesce((
      select sum(daily_delta_usd) from ad_budget_reservations
       where budget_id = v_budget.id and platform = p_platform
         and object_id = p_object_id and status in ('reserved', 'committed')
         and not pause_due
    ), 0), 0);
  end if;
  v_amt := ceil(v_delta * _ad_budget_days_left(v_today) * v_budget.margin * 100) / 100;
  if p_paused and p_op = 'create' then
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

  if p_channel_action_id is not null or p_decision_id is not null then
    update ad_budget_reservations
       set channel_action_id = coalesce(channel_action_id, p_channel_action_id),
           decision_id = coalesce(decision_id, p_decision_id)
     where id = v_res.id;
  end if;

  update ad_budget_reservations
     set paused = (p_paused and p_op = 'create')
   where id = v_res.id and paused is distinct from (p_paused and p_op = 'create');

  if v_delta = 0 and v_extra = 0 then
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
  update ad_budget_reservations
     set status = 'refused', reason = v_reason, updated_at = now()
   where id = v_res.id;
  return jsonb_build_object('status', 'refused', 'amount_usd', v_amt, 'reason', v_reason);
end $$;

drop function if exists public.rebase_ad_spend_for_object(uuid, text, text, numeric, text);
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
begin
  if p_tenant_id is null or p_object_id is null or btrim(p_object_id) = ''
     or p_idem_key is null or btrim(p_idem_key) = '' then
    raise exception 'rebase_ad_spend_for_object: tenant, object and idem_key are required';
  end if;
  if p_platform is null or p_platform not in ('meta', 'google') then
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

  v_new := ceil(p_new_daily_usd * 100) / 100;
  if p_cut_usd is not null and not exists (
       select 1 from ad_budget_reservations
        where budget_id = v_budget.id and platform = p_platform and object_id = p_object_id
          and status = 'committed' and idem_key like 'shrink:%') then
    v_new := greatest(v_held - floor(p_cut_usd * 100) / 100, 0);
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

revoke all on function public.reserve_ad_spend(uuid, text, text, text, text, numeric, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.rebase_ad_spend_for_object(uuid, text, text, numeric, text, numeric) from public, anon, authenticated;
grant execute on function public.reserve_ad_spend(uuid, text, text, text, text, numeric, uuid, uuid, boolean) to service_role;
grant execute on function public.rebase_ad_spend_for_object(uuid, text, text, numeric, text, numeric) to service_role;

commit;
