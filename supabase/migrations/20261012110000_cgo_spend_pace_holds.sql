
begin;

alter table public.ad_budgets alter column margin set default 1.0;
update public.ad_budgets set margin = 1.0, updated_at = now()
 where status = 'active' and margin <> 1.0;

alter table public.ad_budget_reservations
  add column if not exists paused boolean not null default false;

create or replace function public._ad_budget_held_usd(p_budget_id uuid, p_today date, p_margin numeric, p_exclude uuid default null)
returns numeric language sql stable set search_path = public, pg_temp as $$
  select (ceil(coalesce(sum(
           case
             when r.status in ('reserved', 'committed') and r.paused then r.daily_delta_usd
             when r.status in ('reserved', 'committed') then r.daily_delta_usd * _ad_budget_days_left(p_today)
             when r.status = 'released' and r.released_on = p_today then r.daily_delta_usd
             else 0
           end), 0) * p_margin * 100) / 100)::numeric(12,2)
    from ad_budget_reservations r
   where r.budget_id = p_budget_id
     and (p_exclude is null or r.id <> p_exclude)
$$;

drop function if exists public.reserve_ad_spend(uuid, text, text, text, text, numeric, uuid, uuid);
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
  if p_op in ('raise', 'resume') then
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

create or replace function public.rebase_ad_spend_for_object(
  p_tenant_id     uuid,
  p_platform      text,
  p_object_id     text,
  p_new_daily_usd numeric,
  p_idem_key      text
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
    'margin', v_budget.margin,
    'actual_read_at', v_budget.actual_read_at,
    'left_usd', greatest(v_cap - v_spent - v_held - v_cr_held - v_cr_spent, 0));
end $$;

create or replace function public.release_idle_ad_holds(p_tenant_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_today  date;
  v_whole  boolean;
  v_n      int;
  v_daily  numeric(12,2);
begin
  if p_tenant_id is null then
    raise exception 'release_idle_ad_holds: tenant is required';
  end if;

  select * into v_budget from ad_budgets
   where tenant_id = p_tenant_id and status = 'active'
   for update;
  if not found then
    return jsonb_build_object('status', 'no_budget', 'released', 0, 'released_daily_usd', 0);
  end if;

  v_today := _ad_budget_today();
  v_whole := v_budget.actual_read_at is not null and v_budget.actual_read_at > now() - interval '3 hours';

  with obj as (
    select r.platform, r.object_id,
           bool_and(r.paused) as all_paused,
           bool_or(r.status = 'reserved') as in_flight,
           max(greatest(r.created_at, r.updated_at)) as last_change
      from ad_budget_reservations r
     where r.budget_id = v_budget.id and r.tenant_id = p_tenant_id
       and r.status in ('reserved', 'committed') and r.object_id is not null
     group by r.platform, r.object_id
  ), idle as (
    select o.platform, o.object_id
      from obj o
     where not o.in_flight
       and o.last_change < now() - interval '48 hours'
       and not exists (
         select 1 from ad_spend_daily s
          where s.tenant_id = p_tenant_id and s.platform = o.platform and s.object_id = o.object_id
            and s.spend_date >= v_today - 2 and s.amount_usd > 0)
       and (
         (exists (
            select 1 from ad_campaigns c
             where c.tenant_id = p_tenant_id and c.platform = o.platform and c.object_id = o.object_id)
          and not exists (
            select 1 from ad_campaigns c
             where c.tenant_id = p_tenant_id and c.platform = o.platform and c.object_id = o.object_id
               and (c.as_of < now() - interval '6 hours'
                    or upper(coalesce(c.status, '')) not in
                       ('PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DELETED', 'REMOVED'))))
         or (v_whole and o.all_paused
             and not exists (
               select 1 from ad_campaigns c
                where c.tenant_id = p_tenant_id and c.platform = o.platform and c.object_id = o.object_id))
       )
  ), rel as (
    update ad_budget_reservations r
       set status = 'released', released_on = v_today, reason = 'idle_paused',
           pause_due = false, updated_at = now()
      from idle i
     where r.budget_id = v_budget.id and r.tenant_id = p_tenant_id
       and r.platform = i.platform and r.object_id = i.object_id and r.status = 'committed'
    returning r.daily_delta_usd
  )
  select count(*), coalesce(sum(daily_delta_usd), 0) into v_n, v_daily from rel;

  return jsonb_build_object('status', 'done', 'released', v_n, 'released_daily_usd', v_daily);
end $$;

create or replace function public.shrink_underdelivering_ad_holds(p_tenant_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_today  date;
  v_o      record;
  v_r      jsonb;
  v_n      int := 0;
begin
  if p_tenant_id is null then
    raise exception 'shrink_underdelivering_ad_holds: tenant is required';
  end if;

  select * into v_budget from ad_budgets
   where tenant_id = p_tenant_id and status = 'active'
   for update;
  if not found then
    return jsonb_build_object('status', 'no_budget', 'shrunk', 0);
  end if;
  if v_budget.actual_read_at is null or v_budget.actual_read_at < now() - interval '3 hours' then
    return jsonb_build_object('status', 'stale', 'shrunk', 0);
  end if;

  v_today := _ad_budget_today();
  for v_o in
    with obj as (
      select r.platform, r.object_id,
             sum(r.daily_delta_usd) filter (where r.status = 'committed') as held,
             max(greatest(r.created_at, r.updated_at)) as last_change
        from ad_budget_reservations r
       where r.budget_id = v_budget.id and r.tenant_id = p_tenant_id
         and r.status in ('reserved', 'committed') and r.object_id is not null
       group by r.platform, r.object_id
      having not bool_or(r.status = 'reserved') and not bool_or(r.paused) and not bool_or(r.pause_due)
    ), led as (
      select c.platform, c.object_id,
             max(c.budget_usd) filter (where c.budget_kind = 'daily') as daily_budget,
             bool_and(c.as_of >= now() - interval '3 hours'
                      and upper(coalesce(c.status, '')) in ('ACTIVE', 'ENABLED')) as on_fresh
        from ad_campaigns c
       where c.tenant_id = p_tenant_id
       group by c.platform, c.object_id
    ), spend as (
      select d.platform, d.object_id, sum(d.amt) / 3.0 as trailing
        from (select s.platform, s.object_id, s.spend_date, max(s.amount_usd) as amt
                from ad_spend_daily s
               where s.tenant_id = p_tenant_id and s.spend_date between v_today - 3 and v_today - 1
               group by s.platform, s.object_id, s.spend_date) d
       group by d.platform, d.object_id
    )
    select o.platform, o.object_id, o.held,
           coalesce(nullif(l.daily_budget, 0), o.held) as daily_budget,
           coalesce(s.trailing, 0) as trailing
      from obj o
      join led l on l.platform = o.platform and l.object_id = o.object_id and l.on_fresh
      left join spend s on s.platform = o.platform and s.object_id = o.object_id
     where o.held > 0 and o.last_change < now() - interval '72 hours'
  loop
    if v_o.trailing < 0.7 * v_o.daily_budget then
      v_r := rebase_ad_spend_for_object(p_tenant_id, v_o.platform, v_o.object_id,
               ceil(v_o.trailing * 1.2 * 100) / 100,
               'shrink:' || v_o.platform || ':' || v_o.object_id || ':' || v_today::text);
      if v_r->>'status' = 'rebased' then
        v_n := v_n + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('status', 'done', 'shrunk', v_n);
end $$;

revoke all on function public._ad_budget_held_usd(uuid, date, numeric, uuid) from public, anon, authenticated;
revoke all on function public.reserve_ad_spend(uuid, text, text, text, text, numeric, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.rebase_ad_spend_for_object(uuid, text, text, numeric, text) from public, anon, authenticated;
revoke all on function public.ad_budget_month_view(uuid) from public, anon, authenticated;
revoke all on function public.release_idle_ad_holds(uuid) from public, anon, authenticated;
revoke all on function public.shrink_underdelivering_ad_holds(uuid) from public, anon, authenticated;

grant execute on function public._ad_budget_held_usd(uuid, date, numeric, uuid) to service_role;
grant execute on function public.reserve_ad_spend(uuid, text, text, text, text, numeric, uuid, uuid, boolean) to service_role;
grant execute on function public.rebase_ad_spend_for_object(uuid, text, text, numeric, text) to service_role;
grant execute on function public.ad_budget_month_view(uuid) to service_role;
grant execute on function public.release_idle_ad_holds(uuid) to service_role;
grant execute on function public.shrink_underdelivering_ad_holds(uuid) to service_role;

commit;
