
begin;

create table if not exists public.ad_budgets (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  total_usd       numeric(12,2) not null check (total_usd > 0),
  daily_limit_usd numeric(12,2) check (daily_limit_usd is null or daily_limit_usd > 0),
  ends_on         date not null,
  margin          numeric(4,2) not null default 1.25 check (margin >= 1),
  committed_usd   numeric(12,2) not null default 0 check (committed_usd >= 0),
  actual_usd      numeric(12,2) not null default 0,
  status          text not null default 'active' check (status in ('active', 'stopped', 'ended')),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists ad_budgets_one_active_per_tenant
  on public.ad_budgets (tenant_id) where status = 'active';

create table if not exists public.ad_budget_reservations (
  id              uuid primary key default gen_random_uuid(),
  budget_id       uuid not null references public.ad_budgets(id) on delete cascade,
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  idem_key        text not null check (char_length(idem_key) between 1 and 200),
  platform        text not null check (platform in ('meta', 'google')),
  object_id       text,
  op              text not null check (op in ('raise', 'resume', 'create')),
  daily_delta_usd numeric(12,2) not null default 0 check (daily_delta_usd >= 0),
  amount_usd      numeric(12,2) not null default 0 check (amount_usd >= 0),
  released_usd    numeric(12,2) not null default 0 check (released_usd >= 0 and released_usd <= amount_usd),
  status          text not null default 'reserved' check (status in ('reserved', 'committed', 'released', 'refused')),
  reason          text check (reason is null or char_length(reason) <= 64),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (budget_id, idem_key)
);

alter table public.ad_budgets enable row level security;
alter table public.ad_budget_reservations enable row level security;

create policy ad_budgets_member_select on public.ad_budgets
  for select using (
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = ad_budgets.tenant_id
    )
  );
create policy ad_budgets_active_tenant_restrict
  on public.ad_budgets as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

create policy ad_budget_reservations_member_select on public.ad_budget_reservations
  for select using (
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = ad_budget_reservations.tenant_id
    )
  );
create policy ad_budget_reservations_active_tenant_restrict
  on public.ad_budget_reservations as restrictive for select
  using (tenant_id = nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid);

revoke all on public.ad_budgets, public.ad_budget_reservations from public, anon;
revoke insert, update, delete, truncate on public.ad_budgets, public.ad_budget_reservations from authenticated;
grant select on public.ad_budgets, public.ad_budget_reservations to authenticated;
grant all on public.ad_budgets, public.ad_budget_reservations to service_role;

create or replace function public.reserve_ad_spend(
  p_tenant_id       uuid,
  p_idem_key        text,
  p_platform        text,
  p_op              text,
  p_object_id       text,
  p_daily_delta_usd numeric
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget   ad_budgets%rowtype;
  v_res      ad_budget_reservations%rowtype;
  v_delta    numeric(12,2);
  v_days     int;
  v_amt      numeric(12,2);
  v_reason   text;
  v_updated  uuid;
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

  select * into v_budget from ad_budgets
   where tenant_id = p_tenant_id and status = 'active'
   for update;
  if not found then
    return jsonb_build_object('status', 'no_budget', 'amount_usd', 0, 'reason', null);
  end if;

  v_delta := ceil(p_daily_delta_usd * 100) / 100;
  if p_op = 'resume' then
    v_delta := greatest(v_delta - coalesce((
      select sum(daily_delta_usd) from ad_budget_reservations
       where budget_id = v_budget.id and platform = p_platform
         and object_id = p_object_id and status in ('reserved', 'committed')
    ), 0), 0);
  end if;
  v_days := greatest((v_budget.ends_on - current_date) + 1, 1);
  v_amt  := ceil(v_delta * v_days * v_budget.margin * 100) / 100;

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
      return jsonb_build_object('status', 'already_held', 'amount_usd', v_res.amount_usd - v_res.released_usd, 'reason', null, 'ends_on', v_budget.ends_on);
    end if;
    update ad_budget_reservations
       set daily_delta_usd = v_delta, amount_usd = v_amt, released_usd = 0,
           object_id = coalesce(p_object_id, object_id),
           status = 'reserved', reason = null, updated_at = now()
     where id = v_res.id
     returning * into v_res;
  end if;

  if current_date > v_budget.ends_on then
    v_reason := 'budget_ended';
  else
    update ad_budgets
       set committed_usd = committed_usd + v_amt, updated_at = now()
     where id = v_budget.id
       and status = 'active'
       and committed_usd + greatest(actual_usd, 0) + v_amt <= total_usd
       and (daily_limit_usd is null or coalesce((
             select sum(x.daily_delta_usd) from ad_budget_reservations x
              where x.budget_id = v_budget.id and x.id <> v_res.id
                and x.status in ('reserved', 'committed')
           ), 0) + v_delta <= daily_limit_usd)
    returning id into v_updated;
    if v_updated is not null then
      return jsonb_build_object('status', 'held', 'amount_usd', v_amt, 'reason', null, 'ends_on', v_budget.ends_on);
    end if;
    v_reason := case
      when v_budget.daily_limit_usd is not null and coalesce((
             select sum(x.daily_delta_usd) from ad_budget_reservations x
              where x.budget_id = v_budget.id and x.id <> v_res.id
                and x.status in ('reserved', 'committed')
           ), 0) + v_delta > v_budget.daily_limit_usd
        then 'over_daily_limit'
      else 'over_total'
    end;
  end if;

  update ad_budget_reservations
     set status = 'refused', reason = v_reason, updated_at = now()
   where id = v_res.id;
  return jsonb_build_object('status', 'refused', 'amount_usd', v_amt, 'reason', v_reason);
end $$;

create or replace function public.settle_ad_spend(
  p_tenant_id uuid,
  p_idem_key  text,
  p_outcome   text,
  p_object_id text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget_id uuid;
  v_res       ad_budget_reservations%rowtype;
  v_back      numeric(12,2);
begin
  if p_tenant_id is null or p_idem_key is null then
    raise exception 'settle_ad_spend: tenant and idem_key are required';
  end if;
  if p_outcome is null or p_outcome not in ('committed', 'released') then
    raise exception 'settle_ad_spend: invalid outcome %', p_outcome;
  end if;

  select budget_id into v_budget_id from ad_budget_reservations
   where tenant_id = p_tenant_id and idem_key = p_idem_key
   order by created_at desc limit 1;
  if v_budget_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform 1 from ad_budgets where id = v_budget_id and tenant_id = p_tenant_id for update;
  select * into v_res from ad_budget_reservations
   where budget_id = v_budget_id and idem_key = p_idem_key and tenant_id = p_tenant_id
   for update;
  if v_res.status <> 'reserved' then
    return jsonb_build_object('status', v_res.status);
  end if;

  if p_outcome = 'committed' then
    update ad_budget_reservations
       set status = 'committed', object_id = coalesce(object_id, p_object_id), updated_at = now()
     where id = v_res.id;
    return jsonb_build_object('status', 'committed');
  end if;

  v_back := v_res.amount_usd - v_res.released_usd;
  update ad_budgets
     set committed_usd = greatest(committed_usd - v_back, 0), updated_at = now()
   where id = v_budget_id;
  update ad_budget_reservations
     set status = 'released', released_usd = amount_usd, updated_at = now()
   where id = v_res.id;
  return jsonb_build_object('status', 'released', 'released_usd', v_back);
end $$;

create or replace function public.release_ad_spend_for_object(
  p_tenant_id uuid,
  p_platform  text,
  p_object_id text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget ad_budgets%rowtype;
  v_res    ad_budget_reservations%rowtype;
  v_left   int;
  v_back   numeric(12,2);
  v_total  numeric(12,2) := 0;
begin
  if p_tenant_id is null or p_platform is null or p_object_id is null then
    raise exception 'release_ad_spend_for_object: tenant, platform and object are required';
  end if;

  select * into v_budget from ad_budgets
   where tenant_id = p_tenant_id and status = 'active'
   for update;
  if not found then
    return jsonb_build_object('status', 'no_budget', 'released_usd', 0);
  end if;

  v_left := greatest(v_budget.ends_on - current_date, 0);
  for v_res in
    select * from ad_budget_reservations
     where budget_id = v_budget.id and platform = p_platform
       and object_id = p_object_id and status = 'committed'
     for update
  loop
    v_back := least(
      v_res.amount_usd - v_res.released_usd,
      floor(v_res.daily_delta_usd * v_left * v_budget.margin * 100) / 100
    );
    update ad_budget_reservations
       set status = 'released', released_usd = released_usd + v_back, updated_at = now()
     where id = v_res.id;
    v_total := v_total + v_back;
  end loop;

  if v_total > 0 then
    update ad_budgets
       set committed_usd = greatest(committed_usd - v_total, 0), updated_at = now()
     where id = v_budget.id;
  end if;
  return jsonb_build_object('status', 'released', 'released_usd', v_total);
end $$;

revoke all on function public.reserve_ad_spend(uuid, text, text, text, text, numeric) from public, anon, authenticated;
revoke all on function public.settle_ad_spend(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.release_ad_spend_for_object(uuid, text, text) from public, anon, authenticated;
grant execute on function public.reserve_ad_spend(uuid, text, text, text, text, numeric) to service_role;
grant execute on function public.settle_ad_spend(uuid, text, text, text) to service_role;
grant execute on function public.release_ad_spend_for_object(uuid, text, text) to service_role;

commit;
