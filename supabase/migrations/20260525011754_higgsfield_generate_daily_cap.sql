
create table if not exists higgsfield_generate_counters (
  tenant_id   uuid not null,
  day         date not null,
  gen_count   int  not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, day)
);

alter table higgsfield_generate_counters enable row level security;

drop policy if exists higgsfield_generate_counters_select on higgsfield_generate_counters;
create policy higgsfield_generate_counters_select on higgsfield_generate_counters
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = higgsfield_generate_counters.tenant_id)
  );

create table if not exists higgsfield_generate_attempts (
  tenant_id        uuid not null,
  idempotency_key  text not null,
  day              date not null,
  created_at       timestamptz not null default now(),
  primary key (tenant_id, idempotency_key)
);

alter table higgsfield_generate_attempts enable row level security;

create or replace function consume_higgsfield_generate_or_reject(
  p_tenant_id       uuid,
  p_day             date,
  p_idempotency_key text,
  p_daily_cap       int
) returns text
language plpgsql security definer set search_path = public as $$
declare v_inserted boolean; v_count int;
begin
  if p_tenant_id is null or p_day is null or p_idempotency_key is null
     or length(p_idempotency_key) = 0 or p_daily_cap is null then
    raise exception 'consume_higgsfield_generate_or_reject: null/empty argument' using errcode = '22023';
  end if;

  insert into higgsfield_generate_attempts (tenant_id, idempotency_key, day)
  values (p_tenant_id, p_idempotency_key, p_day)
  on conflict (tenant_id, idempotency_key) do nothing;
  get diagnostics v_count = row_count;
  v_inserted := v_count > 0;
  if not v_inserted then
    return 'already';
  end if;

  insert into higgsfield_generate_counters (tenant_id, day)
  values (p_tenant_id, p_day)
  on conflict (tenant_id, day) do nothing;

  update higgsfield_generate_counters
     set gen_count = gen_count + 1,
         updated_at = now()
   where tenant_id = p_tenant_id
     and day = p_day
     and (p_daily_cap <= 0 or gen_count + 1 <= p_daily_cap)
  returning gen_count into v_count;

  if v_count is null then
    delete from higgsfield_generate_attempts
      where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    return 'over_cap';
  end if;

  return 'charged';
end $$;
revoke all on function consume_higgsfield_generate_or_reject(uuid, date, text, int) from public;
grant execute on function consume_higgsfield_generate_or_reject(uuid, date, text, int) to service_role;
