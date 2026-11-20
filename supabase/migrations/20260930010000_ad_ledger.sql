
begin;

create table if not exists public.ad_campaigns (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  platform    text not null check (platform in ('meta', 'google', 'reddit', 'tiktok')),
  account_id  text not null check (char_length(account_id) between 1 and 64),
  object_id   text not null check (char_length(object_id) between 1 and 64),
  level       text not null check (level in ('ad_set', 'campaign', 'ad_group')),
  campaign_id text check (campaign_id is null or char_length(campaign_id) <= 64),
  name        text check (name is null or char_length(name) <= 500),
  budget_kind text not null check (budget_kind in ('daily', 'lifetime', 'none', 'campaign_level', 'shared')),
  budget_usd  numeric(12,2) check (budget_usd is null or budget_usd >= 0),
  status      text check (status is null or char_length(status) <= 64),
  currency    text check (currency is null or char_length(currency) = 3),
  source      text not null check (source in ('api', 'connector', 'manual')),
  as_of       timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, platform, account_id, object_id)
);

create table if not exists public.ad_spend_daily (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  platform    text not null check (platform in ('meta', 'google', 'reddit', 'tiktok')),
  account_id  text not null check (char_length(account_id) between 1 and 64),
  object_id   text not null check (char_length(object_id) between 1 and 64),
  spend_date  date not null,
  amount_usd  numeric(12,2) not null check (amount_usd >= 0),
  source      text not null check (source in ('api', 'connector', 'manual')),
  recorded_at timestamptz not null default now(),
  provisional boolean not null default false,
  unique (tenant_id, platform, account_id, object_id, spend_date, source)
);

create table if not exists public.ad_budget_plan (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  budget_id     uuid not null references public.ad_budgets(id) on delete cascade,
  month_start   date not null check (month_start = date_trunc('month', month_start)::date),
  platform      text not null check (platform in ('meta', 'google', 'reddit', 'tiktok')),
  planned_usd   numeric(12,2) not null check (planned_usd >= 0),
  reason        text check (reason is null or char_length(reason) <= 500),
  set_by_source text not null check (char_length(set_by_source) between 1 and 64),
  set_by        uuid,
  updated_at    timestamptz not null default now(),
  unique (budget_id, month_start, platform)
);

alter table public.ad_campaigns enable row level security;
alter table public.ad_spend_daily enable row level security;
alter table public.ad_budget_plan enable row level security;

create policy ad_campaigns_member_select on public.ad_campaigns
  for select using (
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = ad_campaigns.tenant_id
    )
  );
create policy ad_campaigns_active_tenant_restrict
  on public.ad_campaigns as restrictive for select
  using (tenant_id = (select public.app_active_tenant()));

create policy ad_spend_daily_member_select on public.ad_spend_daily
  for select using (
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = ad_spend_daily.tenant_id
    )
  );
create policy ad_spend_daily_active_tenant_restrict
  on public.ad_spend_daily as restrictive for select
  using (tenant_id = (select public.app_active_tenant()));

create policy ad_budget_plan_member_select on public.ad_budget_plan
  for select using (
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = ad_budget_plan.tenant_id
    )
  );
create policy ad_budget_plan_active_tenant_restrict
  on public.ad_budget_plan as restrictive for select
  using (tenant_id = (select public.app_active_tenant()));

revoke all on public.ad_campaigns, public.ad_spend_daily, public.ad_budget_plan from public, anon;
revoke insert, update, delete, truncate on public.ad_campaigns, public.ad_spend_daily, public.ad_budget_plan from authenticated;
grant select on public.ad_campaigns, public.ad_spend_daily, public.ad_budget_plan to authenticated;
revoke all on public.ad_campaigns, public.ad_spend_daily, public.ad_budget_plan from service_role;
grant select on public.ad_campaigns, public.ad_spend_daily, public.ad_budget_plan to service_role;

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

create or replace function public.start_ad_budget_month(
  p_tenant_id uuid,
  p_budget_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget  ad_budgets%rowtype;
  v_today   date;
  v_month   date;
  v_cap     numeric(12,2);
  v_rolled  boolean := false;
begin
  if p_tenant_id is null or p_budget_id is null then
    raise exception 'start_ad_budget_month: tenant and budget are required';
  end if;

  select * into v_budget from ad_budgets
   where id = p_budget_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_budget.status <> 'active' then
    return jsonb_build_object('status', v_budget.status);
  end if;

  v_today := _ad_budget_today();
  v_month := date_trunc('month', v_today)::date;
  v_cap   := _ad_budget_month_cap(v_budget.monthly_usd, v_budget.started_on, v_today);

  if v_budget.month_start < v_month then
    update ad_budgets
       set month_start = v_month, spent_usd = 0, alarm_90_sent_at = null,
           actual_read_at = null, month_note_sent_for = null, updated_at = now()
     where id = v_budget.id
    returning * into v_budget;
    v_rolled := true;
  end if;

  return jsonb_build_object(
    'status', 'active',
    'rolled', v_rolled,
    'month_start', v_budget.month_start,
    'month_cap_usd', v_cap,
    'monthly_usd', v_budget.monthly_usd,
    'pause', '[]'::jsonb,
    'paused_before', '[]'::jsonb,
    'note_due', false);
end $$;

update public.ad_budget_reservations
   set pause_due = false, updated_at = now()
 where pause_due;

revoke all on function public.record_ad_ledger_read(uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.start_ad_budget_month(uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_ad_ledger_read(uuid, text, text, jsonb, jsonb) to service_role;
grant execute on function public.start_ad_budget_month(uuid, uuid) to service_role;

commit;
