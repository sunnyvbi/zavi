
create table if not exists tenant_store_bindings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tenant_store_bindings enable row level security;
revoke all on table tenant_store_bindings from public, anon, authenticated;
grant all on table tenant_store_bindings to service_role;

alter table tenant_subscriptions
  add column if not exists source text
    check (source in ('stripe', 'app_store', 'play_store', 'test_store')),
  add column if not exists store_app_user_id text,
  add column if not exists store_product_id text,
  add column if not exists store_event_created bigint not null default 0;

create unique index if not exists tenant_subscriptions_store_app_user_id_key
  on tenant_subscriptions (store_app_user_id)
  where store_app_user_id is not null;

create table if not exists revenuecat_events (
  event_id text primary key,
  type text,
  received_at timestamptz not null default now()
);

alter table revenuecat_events enable row level security;
revoke all on table revenuecat_events from public, anon, authenticated;
grant all on table revenuecat_events to service_role;
