begin;

create table if not exists public.tiktok_launch_claims (
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  advertiser_id text not null check (advertiser_id ~ '^[0-9]{1,32}$'),
  action_id     uuid not null,
  token         uuid not null,
  claimed_at    timestamptz not null default now(),
  primary key (tenant_id, advertiser_id)
);
alter table public.tiktok_launch_claims enable row level security;
revoke all on public.tiktok_launch_claims from public, anon, authenticated;
grant all on public.tiktok_launch_claims to service_role;

commit;
