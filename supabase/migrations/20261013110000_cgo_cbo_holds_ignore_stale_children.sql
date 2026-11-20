
begin;

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
           bool_and(c.as_of >= now() - interval '3 hours'
                    and upper(coalesce(c.status, '')) in
                        ('PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DELETED', 'REMOVED')) as paused_fresh
      from ad_campaigns c
     where c.tenant_id = p_tenant_id
     group by c.platform, c.object_id
    union all
    select c.platform, c.campaign_id,
           bool_and(upper(coalesce(c.status, '')) in
                        ('PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DELETED', 'REMOVED'))
      from ad_campaigns c
     where c.tenant_id = p_tenant_id and c.platform = 'meta' and c.level = 'ad_set' and c.campaign_id is not null
       and c.as_of >= now() - interval '3 hours'
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
      select c.platform, c.campaign_id, null::numeric,
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

revoke all on function public.release_idle_ad_holds(uuid) from public, anon, authenticated;
revoke all on function public.shrink_underdelivering_ad_holds(uuid) from public, anon, authenticated;

grant execute on function public.release_idle_ad_holds(uuid) to service_role;
grant execute on function public.shrink_underdelivering_ad_holds(uuid) to service_role;

commit;
