begin;
create table public.ads_conversion_sources (
  source_id text primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unique(source_id,tenant_id)
);
alter table public.ads_conversion_sources enable row level security;
revoke all on public.ads_conversion_sources from public, anon, authenticated;
grant all on public.ads_conversion_sources to service_role;
create table public.ads_resource_bindings (
  resource_id text primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('conversion_event','audience','product_feed')),
  source_id text,
  created_at timestamptz not null default now(),
  check ((kind = 'conversion_event') = (source_id is not null)),
  foreign key (source_id,tenant_id) references public.ads_conversion_sources(source_id,tenant_id) on delete cascade
);
create index ads_resource_bindings_tenant_idx on public.ads_resource_bindings(tenant_id);
alter table public.ads_resource_bindings enable row level security;
revoke all on public.ads_resource_bindings from public, anon, authenticated;
grant all on public.ads_resource_bindings to service_role;
commit;
