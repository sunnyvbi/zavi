
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
                            budget_kind, budget_usd, status, currency, source, as_of, updated_at)
  select distinct on (e.value->>'object_id')
         p_tenant_id, p_platform, p_account_id, e.value->>'object_id', e.value->>'level',
         nullif(e.value->>'campaign_id', ''), left(e.value->>'name', 500),
         e.value->>'budget_kind', round((e.value->>'budget_usd')::numeric, 2),
         e.value->>'status', upper(e.value->>'currency'), 'api', now(), now()
    from jsonb_array_elements(p_campaigns) with ordinality e(value, n)
   order by e.value->>'object_id', e.n desc
  on conflict (tenant_id, platform, account_id, object_id) do update
     set level = excluded.level, campaign_id = excluded.campaign_id, name = excluded.name,
         budget_kind = excluded.budget_kind, budget_usd = excluded.budget_usd,
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

revoke all on function public.record_ad_ledger_read(uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.record_ad_ledger_read(uuid, text, text, jsonb, jsonb) to service_role;
