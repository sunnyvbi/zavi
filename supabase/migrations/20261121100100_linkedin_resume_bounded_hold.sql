begin;

alter table public.ad_budget_reservations add column if not exists spend_baseline_usd numeric(12,2);

do $$
declare
  fn oid;
  body text;
  pair text[];
  pairs text[][] := array[
    array[
      'if v_bounded and p_op <> ''create'' then',
      'if v_bounded and p_op <> ''create'' and not (p_op = ''resume'' and p_cap_usd is not null and p_ends_on is not null) then'],
    array[
      'p_over_cap_ok boolean DEFAULT false',
      'p_over_cap_ok boolean DEFAULT false, p_observed_usd numeric DEFAULT NULL::numeric'],
    array[
      $a$  v_factor   numeric;
$a$,
      $a$  v_factor   numeric;
  v_baseline numeric(12,2);
$a$],
    array[
      $a$  insert into ad_budget_reservations
    (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd,
     bounded, ends_on, cap_usd, hold_factor)
  values
    (v_budget.id, p_tenant_id, p_idem_key, p_platform, p_object_id, p_op, v_delta, v_amt,
     v_bounded, p_ends_on, p_cap_usd, v_factor)$a$,
      $a$  if v_bounded and p_op = 'resume' then
    select greatest(coalesce(sum(d.amt), 0), coalesce(p_observed_usd, 0)) into v_baseline from (
      select max(s.amount_usd) as amt from ad_spend_daily s
       where s.tenant_id = p_tenant_id and s.platform = p_platform and s.object_id = p_object_id
       group by s.spend_date) d;
  end if;

  insert into ad_budget_reservations
    (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd,
     bounded, ends_on, cap_usd, hold_factor, spend_baseline_usd)
  values
    (v_budget.id, p_tenant_id, p_idem_key, p_platform, p_object_id, p_op, v_delta, v_amt,
     v_bounded, p_ends_on, p_cap_usd, v_factor, v_baseline)$a$],
    array[
      $a$over_cap = false, spend_from = case when v_bounded then (now() at time zone 'utc')::date end,$a$,
      $a$over_cap = false, spend_from = case when v_bounded then (now() at time zone 'utc')::date end,
           spend_baseline_usd = v_baseline,$a$]
  ];
begin
  select oid into fn from pg_proc where pronamespace = 'public'::regnamespace and proname = 'reserve_ad_spend';
  body := pg_get_functiondef(fn);
  if position('p_observed_usd' in body) > 0 then
    return;
  end if;
  foreach pair slice 1 in array pairs loop
    if (length(body) - length(replace(body, pair[1], ''))) / length(pair[1]) <> 1 then
      raise exception 'linkedin_resume_bounded_hold: reserve_ad_spend no longer matches (%)', left(pair[1], 60);
    end if;
    body := replace(body, pair[1], pair[2]);
  end loop;
  execute format('drop function %s', fn::regprocedure);
  execute body;
end $$;

revoke all on function public.reserve_ad_spend(uuid, text, text, text, text, numeric, uuid, uuid, boolean, date, numeric, numeric, boolean, numeric) from public, anon, authenticated;
grant execute on function public.reserve_ad_spend(uuid, text, text, text, text, numeric, uuid, uuid, boolean, date, numeric, numeric, boolean, numeric) to service_role;

create or replace function public._ad_bounded_hold_usd(r public.ad_budget_reservations, p_today date, p_margin numeric)
returns numeric language sql stable set search_path = public, pg_temp as $$
  select case
    when not r.bounded or r.status = 'refused' then 0
    when r.platform = 'linkedin' and r.cap_usd is not null and r.ends_on is not null and p_today >= r.ends_on + 2 then 0
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
