begin;
alter table public.ads_campaign_funding
 add column daily_max_micros bigint,
 add column coverage_start bigint,
 add column coverage_end bigint;
create function public.ads_wallet_reserve_daily(p_tenant_id uuid,p_campaign_id text,p_daily_micros bigint,p_start bigint,p_end bigint,p_observed_spend_cents bigint)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare f ads_campaign_funding%rowtype; daily bigint; first_time bigint; last_time bigint; cap bigint;
begin
 if p_daily_micros is null or p_start is null or p_end is null or p_observed_spend_cents is null or p_daily_micros < 25000000 or p_daily_micros > 1000000000000 or p_start < 946684800 or p_end > 4102444800 or p_end <= p_start or p_end-p_start > 31622400 then
  raise exception 'invalid daily coverage';
 end if;
 perform 1 from ads_wallets where tenant_id=p_tenant_id for update;
 if not found then raise exception 'ads_balance_insufficient'; end if;
 select * into f from ads_campaign_funding where campaign_id=p_campaign_id;
 if found and f.tenant_id<>p_tenant_id then raise exception 'campaign ownership conflict'; end if;
 daily:=greatest(coalesce(f.daily_max_micros,0),p_daily_micros);
 first_time:=least(coalesce(f.coverage_start,p_start),p_start);
 last_time:=greatest(coalesce(f.coverage_end,p_end),p_end);
 if last_time-first_time>31622400 then raise exception 'invalid daily coverage'; end if;
 cap:=ceil((daily::numeric*2*(ceil((last_time-first_time)::numeric/86400)+2))/10000)::bigint;
 perform ads_wallet_reserve(p_tenant_id,p_campaign_id,cap,p_observed_spend_cents);
 update ads_campaign_funding set daily_max_micros=daily,coverage_start=first_time,coverage_end=last_time where campaign_id=p_campaign_id and tenant_id=p_tenant_id;
end $$;
revoke all on function public.ads_wallet_reserve_daily(uuid,text,bigint,bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.ads_wallet_reserve_daily(uuid,text,bigint,bigint,bigint,bigint) to service_role;
commit;
