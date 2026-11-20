begin;

create or replace function public._ad_bounded_hold_usd(r public.ad_budget_reservations, p_today date, p_margin numeric)
returns numeric language sql stable set search_path = public, pg_temp as $$
  select case
    when not r.bounded or r.status = 'refused' then 0
    when r.status = 'released' and (coalesce(r.reason, '') in ('rebased', 'rejected', 'not_landed', 'pending_test_released')
                                    or r.released_at is null or r.released_at < now() - interval '48 hours') then 0
    when r.status in ('reserved', 'committed') and r.cap_usd is null and r.ends_on is not null
         and coalesce(r.spend_from, (r.created_at at time zone 'utc')::date) < date_trunc('month', p_today)::date
      then ceil(r.daily_delta_usd * least(_ad_budget_days_left(p_today), greatest(r.ends_on - p_today, 0)) * p_margin * 100) / 100
    else greatest(r.amount_usd - greatest(coalesce((
           select sum(d.amt) from (
             select max(s.amount_usd) as amt
               from ad_spend_daily s
              where s.tenant_id = r.tenant_id and s.platform = r.platform and s.object_id = r.object_id
                and (r.spend_baseline_usd is not null
                     or s.spend_date >= coalesce(r.spend_from, (r.created_at at time zone 'utc')::date))
              group by s.spend_date) d), 0) - coalesce(r.spend_baseline_usd, 0), 0), 0)
  end
$$;

revoke all on function public._ad_bounded_hold_usd(public.ad_budget_reservations, date, numeric) from public, anon, authenticated;
grant execute on function public._ad_bounded_hold_usd(public.ad_budget_reservations, date, numeric) to service_role;

commit;
