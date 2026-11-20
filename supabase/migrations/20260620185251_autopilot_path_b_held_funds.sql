
create table if not exists autopilot_held_funds (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null,
  charge_id           text,
  amount_minor        bigint      not null,
  currency            text        not null default 'usd',
  client_reference    text        not null,
  status              text        not null default 'pending'
                        check (status in ('pending', 'held', 'remitting', 'remitted', 'refunded')),
  reserve_held_minor  bigint      not null default 0,
  platform_fee_minor  bigint      not null default 0,
  remitted_transfer_id text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, client_reference)
);

alter table autopilot_held_funds
  add column if not exists platform_fee_minor bigint not null default 0;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'autopilot_held_funds'::regclass
      and conname = 'autopilot_held_funds_status_check'
  ) then
    alter table autopilot_held_funds drop constraint autopilot_held_funds_status_check;
  end if;
  alter table autopilot_held_funds
    add constraint autopilot_held_funds_status_check
    check (status in ('pending', 'held', 'remitting', 'remitted', 'refunded'));
end $$;

create index if not exists autopilot_held_funds_tenant_status_idx
  on autopilot_held_funds (tenant_id, status);

alter table autopilot_held_funds enable row level security;

create or replace function autopilot_claim_held_fund_for_remit(p_id uuid)
returns autopilot_held_funds
language plpgsql security definer set search_path = public as $$
declare
  v_row autopilot_held_funds;
begin
  update autopilot_held_funds
     set status = 'remitting', updated_at = now()
   where id = p_id and status = 'held'
  returning * into v_row;
  return v_row;
end $$;
revoke all on function autopilot_claim_held_fund_for_remit(uuid) from public, anon, authenticated;

create or replace function autopilot_mark_held_fund_remitted(p_id uuid, p_transfer_id text)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  update autopilot_held_funds
     set status = 'remitted', remitted_transfer_id = p_transfer_id, updated_at = now()
   where id = p_id and status = 'remitting';
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function autopilot_mark_held_fund_remitted(uuid, text) from public, anon, authenticated;

create or replace function autopilot_release_held_fund_claim(p_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  update autopilot_held_funds
     set status = 'held', updated_at = now()
   where id = p_id and status = 'remitting';
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function autopilot_release_held_fund_claim(uuid) from public, anon, authenticated;

create or replace function autopilot_mark_held_fund_refunded(p_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  update autopilot_held_funds
     set status = 'refunded', updated_at = now()
   where id = p_id and status in ('pending', 'held');
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function autopilot_mark_held_fund_refunded(uuid) from public, anon, authenticated;

create table if not exists autopilot_payment_daily (
  tenant_id        uuid        not null,
  day              date        not null,
  collected_minor  bigint      not null default 0,
  count            integer     not null default 0,
  primary key (tenant_id, day)
);

alter table autopilot_payment_daily enable row level security;

create or replace function autopilot_record_payment_usage(
  p_tenant_id uuid,
  p_day date,
  p_amount_minor bigint
)
returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into autopilot_payment_daily (tenant_id, day, collected_minor, count)
  values (p_tenant_id, p_day, p_amount_minor, 1)
  on conflict (tenant_id, day) do update
    set collected_minor = autopilot_payment_daily.collected_minor + excluded.collected_minor,
        count           = autopilot_payment_daily.count + 1;
end $$;
revoke all on function autopilot_record_payment_usage(uuid, date, bigint) from public, anon, authenticated;

create unique index if not exists tenant_resources_stripe_account_uniq
  on tenant_resources ((external_ref->>'stripe_account_id'))
  where resource_kind = 'stripe' and external_ref->>'stripe_account_id' is not null;

update system_config
set blob = (
      case when blob ? 'autopilot_reserve_bps'
        then blob else jsonb_set(blob, '{autopilot_reserve_bps}', '0'::jsonb, true) end
    ),
    updated_at = now()
where id = 1;

update system_config
set blob = (
      case when blob ? 'autopilot_reserve_release_days'
        then blob else jsonb_set(blob, '{autopilot_reserve_release_days}', '7'::jsonb, true) end
    ),
    updated_at = now()
where id = 1;

update system_config
set blob = (
      case when blob ? 'autopilot_daily_cap_minor'
        then blob else jsonb_set(blob, '{autopilot_daily_cap_minor}', '200000'::jsonb, true) end
    ),
    updated_at = now()
where id = 1;

update system_config
set blob = (
      case when blob ? 'autopilot_daily_count_cap'
        then blob else jsonb_set(blob, '{autopilot_daily_count_cap}', '50'::jsonb, true) end
    ),
    updated_at = now()
where id = 1;
