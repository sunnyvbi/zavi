
create table if not exists tenant_budget_counters (
  tenant_id      uuid not null,
  day            date not null,
  spend_estimate numeric(18, 6) not null default 0,
  spend_actual   numeric(18, 6) not null default 0,
  run_count      int  not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (tenant_id, day)
);

alter table tenant_budget_counters enable row level security;

drop policy if exists tenant_budget_counters_select on tenant_budget_counters;
create policy tenant_budget_counters_select on tenant_budget_counters
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = tenant_budget_counters.tenant_id)
  );

create or replace function consume_budget_or_reject(
  p_tenant_id uuid,
  p_day       date,
  p_estimate  numeric,
  p_daily_cap numeric
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_charged numeric;
begin
  if p_tenant_id is null or p_day is null or p_estimate is null or p_daily_cap is null then
    raise exception 'consume_budget_or_reject: null argument' using errcode = '22023';
  end if;
  if p_estimate < 0 then
    raise exception 'consume_budget_or_reject: estimate must be >= 0' using errcode = '22023';
  end if;

  insert into tenant_budget_counters (tenant_id, day)
  values (p_tenant_id, p_day)
  on conflict (tenant_id, day) do nothing;

  update tenant_budget_counters
     set spend_estimate = spend_estimate + p_estimate,
         run_count = run_count + 1,
         updated_at = now()
   where tenant_id = p_tenant_id
     and day = p_day
     and (p_daily_cap <= 0 or spend_estimate + p_estimate <= p_daily_cap)
  returning spend_estimate into v_charged;

  return v_charged is not null;
end $$;
revoke all on function consume_budget_or_reject(uuid, date, numeric, numeric) from public;
grant execute on function consume_budget_or_reject(uuid, date, numeric, numeric) to service_role;

create or replace function record_actual_spend(
  p_tenant_id uuid,
  p_day       date,
  p_actual    numeric
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_tenant_id is null or p_day is null or p_actual is null or p_actual < 0 then
    raise exception 'record_actual_spend: null/negative argument' using errcode = '22023';
  end if;
  insert into tenant_budget_counters (tenant_id, day, spend_actual)
  values (p_tenant_id, p_day, p_actual)
  on conflict (tenant_id, day) do update
    set spend_actual = tenant_budget_counters.spend_actual + excluded.spend_actual,
        updated_at = now();
end $$;
revoke all on function record_actual_spend(uuid, date, numeric) from public;
grant execute on function record_actual_spend(uuid, date, numeric) to service_role;
