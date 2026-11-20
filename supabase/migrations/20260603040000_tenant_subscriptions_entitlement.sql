
create table if not exists tenant_subscriptions (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text,
  plan text not null default 'free'
    check (plan in ('free', 'solo', 'team', 'full', 'enterprise')),
  status text not null default 'active'
    check (status in ('active', 'trialing', 'past_due', 'canceled', 'incomplete')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  grandfathered boolean not null default false,
  stripe_event_created bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tenant_subscriptions enable row level security;

drop policy if exists tenant_subscriptions_select_own on tenant_subscriptions;
create policy tenant_subscriptions_select_own on tenant_subscriptions
  for select to authenticated
  using (tenant_id in (select tenant_id from tenant_users where user_id = auth.uid()));

create table if not exists stripe_billing_events (
  event_id text primary key,
  type text,
  received_at timestamptz not null default now()
);
alter table stripe_billing_events enable row level security;

create or replace function apply_subscription_state(
  p_tenant_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_plan text,
  p_status text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_event_created bigint
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into tenant_subscriptions (
    tenant_id, stripe_customer_id, stripe_subscription_id, plan, status,
    current_period_end, cancel_at_period_end, stripe_event_created, updated_at
  ) values (
    p_tenant_id, p_stripe_customer_id, p_stripe_subscription_id, p_plan, p_status,
    p_current_period_end, coalesce(p_cancel_at_period_end, false), p_event_created, now()
  )
  on conflict (tenant_id) do update set
    stripe_customer_id = coalesce(excluded.stripe_customer_id, tenant_subscriptions.stripe_customer_id),
    stripe_subscription_id = excluded.stripe_subscription_id,
    plan = excluded.plan,
    status = excluded.status,
    current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end,
    stripe_event_created = excluded.stripe_event_created,
    updated_at = now()
  where tenant_subscriptions.grandfathered = false
    and excluded.stripe_event_created > tenant_subscriptions.stripe_event_created;
end $$;
revoke all on function apply_subscription_state(uuid, text, text, text, text, timestamptz, boolean, bigint) from public, anon, authenticated;
grant execute on function apply_subscription_state(uuid, text, text, text, text, timestamptz, boolean, bigint) to service_role;

insert into tenant_subscriptions (tenant_id, plan, status, grandfathered)
select id, 'full', 'active', true from tenants
on conflict (tenant_id) do nothing;

do $$
declare n int;
begin
  select count(*) into n from tenant_subscriptions where grandfathered;
  raise notice '20260603040000: grandfathered % existing tenants to lifetime-free Full', n;
end $$;
