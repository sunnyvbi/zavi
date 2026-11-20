
begin;

alter table public.ad_campaigns
  add column if not exists campaign_budget_usd numeric(12,2)
    check (campaign_budget_usd is null or campaign_budget_usd >= 0);

create or replace function public.record_ad_ledger_read(
  p_tenant_id  uuid,
  p_platform   text,
  p_account_id text,
  p_campaigns  jsonb,
  p_spend      jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_campaigns int;
  v_spend     int;
begin
  if p_tenant_id is null then
    raise exception 'record_ad_ledger_read: tenant is required' using errcode = '22023';
  end if;
  if p_platform is null or p_platform not in ('meta', 'google', 'reddit', 'tiktok') then
    raise exception 'record_ad_ledger_read: invalid platform' using errcode = '22023';
  end if;
  if p_account_id is null or char_length(p_account_id) not between 1 and 64 then
    raise exception 'record_ad_ledger_read: invalid account' using errcode = '22023';
  end if;
  if p_campaigns is null or jsonb_typeof(p_campaigns) <> 'array' or jsonb_array_length(p_campaigns) > 50000
     or p_spend is null or jsonb_typeof(p_spend) <> 'array' or jsonb_array_length(p_spend) > 200000 then
    raise exception 'record_ad_ledger_read: campaigns and spend must be arrays of a sane size' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_campaigns) e
     where jsonb_typeof(e) <> 'object'
        or coalesce(char_length(e->>'object_id'), 0) not between 1 and 64
        or coalesce(char_length(e->>'campaign_id'), 0) > 64
        or coalesce(char_length(e->>'status'), 0) > 64
        or (e->>'budget_usd' is not null and not ((e->>'budget_usd')::numeric >= 0 and (e->>'budget_usd')::numeric < 1000000000))
        or (e->>'campaign_budget_usd' is not null and not ((e->>'campaign_budget_usd')::numeric >= 0 and (e->>'campaign_budget_usd')::numeric < 1000000000))
  ) then
    raise exception 'record_ad_ledger_read: invalid campaign row' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_spend) e
     where jsonb_typeof(e) <> 'object'
        or coalesce(char_length(e->>'object_id'), 0) not between 1 and 64
        or coalesce(e->>'spend_date', '') !~ '^\d{4}-\d{2}-\d{2}$'
        or e->>'amount_usd' is null
        or not ((e->>'amount_usd')::numeric >= 0 and (e->>'amount_usd')::numeric < 1000000000)
  ) then
    raise exception 'record_ad_ledger_read: invalid spend row' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_spend) e
     where (e->>'spend_date')::date not between date '2020-01-01' and _ad_budget_today() + 2
  ) then
    raise exception 'record_ad_ledger_read: spend date out of range' using errcode = '22023';
  end if;

  insert into ad_campaigns (tenant_id, platform, account_id, object_id, level, campaign_id, name,
                            budget_kind, budget_usd, campaign_budget_usd, status, currency, source, as_of, updated_at)
  select distinct on (e.value->>'object_id')
         p_tenant_id, p_platform, p_account_id, e.value->>'object_id', e.value->>'level',
         nullif(e.value->>'campaign_id', ''), left(e.value->>'name', 500),
         e.value->>'budget_kind', round((e.value->>'budget_usd')::numeric, 2),
         round((e.value->>'campaign_budget_usd')::numeric, 2),
         e.value->>'status', upper(e.value->>'currency'), 'api', now(), now()
    from jsonb_array_elements(p_campaigns) with ordinality e(value, n)
   order by e.value->>'object_id', e.n desc
  on conflict (tenant_id, platform, account_id, object_id) do update
     set level = excluded.level, campaign_id = excluded.campaign_id, name = excluded.name,
         budget_kind = excluded.budget_kind, budget_usd = excluded.budget_usd,
         campaign_budget_usd = excluded.campaign_budget_usd,
         status = excluded.status, currency = excluded.currency, source = excluded.source,
         as_of = excluded.as_of, updated_at = now();
  get diagnostics v_campaigns = row_count;

  update ad_campaigns c
     set status = 'removed', as_of = now(), updated_at = now()
   where c.tenant_id = p_tenant_id and c.platform = p_platform and c.account_id = p_account_id
     and c.source = 'api' and c.status is distinct from 'removed'
     and not exists (select 1 from jsonb_array_elements(p_campaigns) e
                      where e->>'object_id' = c.object_id);

  insert into ad_spend_daily (tenant_id, platform, account_id, object_id, spend_date, amount_usd,
                              source, recorded_at, provisional)
  select p_tenant_id, p_platform, p_account_id, e->>'object_id', (e->>'spend_date')::date,
         sum(round((e->>'amount_usd')::numeric, 2)), 'api', now(),
         bool_or(coalesce((e->>'provisional')::boolean, false))
    from jsonb_array_elements(p_spend) e
   group by e->>'object_id', (e->>'spend_date')::date
  on conflict (tenant_id, platform, account_id, object_id, spend_date, source) do update
     set amount_usd = excluded.amount_usd, recorded_at = excluded.recorded_at,
         provisional = excluded.provisional;
  get diagnostics v_spend = row_count;

  return jsonb_build_object('status', 'recorded', 'campaigns', v_campaigns, 'spend_rows', v_spend);
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
  if not v_whole then
    return jsonb_build_object('status', 'stale', 'released', 0, 'released_daily_usd', 0);
  end if;

  with obj as (
    select r.platform, r.object_id,
           bool_and(r.paused) as all_paused,
           bool_or(r.status = 'reserved') as in_flight,
           max(greatest(r.created_at, r.updated_at)) as last_change
      from ad_budget_reservations r
     where r.budget_id = v_budget.id and r.tenant_id = p_tenant_id
       and r.status in ('reserved', 'committed') and r.object_id is not null
     group by r.platform, r.object_id
  ), led as (
    select c.platform, c.object_id,
           bool_and(upper(coalesce(c.status, '')) = 'REMOVED'
                    or (c.as_of >= now() - interval '3 hours'
                        and upper(coalesce(c.status, '')) in
                            ('PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DELETED', 'REMOVED'))) as paused_fresh
      from ad_campaigns c
     where c.tenant_id = p_tenant_id
     group by c.platform, c.object_id
    union all
    select c.platform, c.campaign_id,
           bool_and(upper(coalesce(c.status, '')) in
                        ('PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DELETED', 'REMOVED'))
      from ad_campaigns c
     where c.tenant_id = p_tenant_id and c.platform = 'meta' and c.level = 'ad_set' and c.campaign_id is not null
       and (c.as_of >= now() - interval '3 hours' or upper(coalesce(c.status, '')) = 'REMOVED')
       and not exists (
         select 1 from ad_campaigns x
          where x.tenant_id = p_tenant_id and x.platform = c.platform and x.object_id = c.campaign_id)
     group by c.platform, c.campaign_id
  ), spent as (
    select s.platform, s.object_id
      from ad_spend_daily s
     where s.tenant_id = p_tenant_id and s.spend_date >= v_today - 2 and s.amount_usd > 0
    union
    select s.platform, c.campaign_id
      from ad_spend_daily s
      join ad_campaigns c on c.tenant_id = p_tenant_id and c.platform = s.platform and c.object_id = s.object_id
     where s.tenant_id = p_tenant_id and s.platform = 'meta' and c.campaign_id is not null
       and s.spend_date >= v_today - 2 and s.amount_usd > 0
  ), idle as (
    select o.platform, o.object_id
      from obj o
      left join led l on l.platform = o.platform and l.object_id = o.object_id
     where not o.in_flight
       and o.last_change < now() - interval '48 hours'
       and not exists (select 1 from spent s where s.platform = o.platform and s.object_id = o.object_id)
       and (
         l.paused_fresh is true
         or (l.object_id is null and o.all_paused)
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
    ), sets as (
      select distinct c.platform, c.object_id, c.campaign_id
        from ad_campaigns c
       where c.tenant_id = p_tenant_id and c.platform = 'meta' and c.level = 'ad_set' and c.campaign_id is not null
         and c.as_of >= now() - interval '3 hours'
         and not exists (
           select 1 from ad_campaigns x
            where x.tenant_id = p_tenant_id and x.platform = c.platform and x.object_id = c.campaign_id)
    ), led as (
      select c.platform, c.object_id,
             max(c.budget_usd) filter (where c.budget_kind = 'daily') as daily_budget,
             bool_and(c.as_of >= now() - interval '3 hours'
                      and upper(coalesce(c.status, '')) in ('ACTIVE', 'ENABLED')) as on_fresh
        from ad_campaigns c
       where c.tenant_id = p_tenant_id
       group by c.platform, c.object_id
      union all
      select c.platform, c.campaign_id, max(c.campaign_budget_usd),
             bool_or(upper(coalesce(c.status, '')) in ('ACTIVE', 'ENABLED'))
        from ad_campaigns c
       where c.tenant_id = p_tenant_id and c.platform = 'meta' and c.level = 'ad_set' and c.campaign_id is not null
         and c.as_of >= now() - interval '3 hours'
         and not exists (
           select 1 from ad_campaigns x
            where x.tenant_id = p_tenant_id and x.platform = c.platform and x.object_id = c.campaign_id)
       group by c.platform, c.campaign_id
    ), day as (
      select s.platform, s.object_id, s.spend_date, max(s.amount_usd) as amt
        from ad_spend_daily s
       where s.tenant_id = p_tenant_id and s.spend_date between v_today - 3 and v_today - 1
       group by s.platform, s.object_id, s.spend_date
    ), spend as (
      select d.platform, d.object_id, sum(d.amt) / 3.0 as trailing
        from day d
       group by d.platform, d.object_id
      union all
      select d.platform, st.campaign_id, sum(d.amt) / 3.0
        from day d
        join sets st on st.platform = d.platform and st.object_id = d.object_id
       group by d.platform, st.campaign_id
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

revoke all on function public.record_ad_ledger_read(uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.release_idle_ad_holds(uuid) from public, anon, authenticated;
revoke all on function public.shrink_underdelivering_ad_holds(uuid) from public, anon, authenticated;

grant execute on function public.record_ad_ledger_read(uuid, text, text, jsonb, jsonb) to service_role;
grant execute on function public.release_idle_ad_holds(uuid) to service_role;
grant execute on function public.shrink_underdelivering_ad_holds(uuid) to service_role;

commit;
