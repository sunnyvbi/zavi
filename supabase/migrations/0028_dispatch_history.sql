
create extension if not exists pgcrypto;

create table if not exists public.dispatch_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source_agent_slug text not null,
  source_run_id uuid not null,
  target_agent_slug text not null,
  target_run_id uuid,
  dedup_key text not null,
  created_at timestamptz not null default now()
);

create index if not exists dispatch_history_dedup_lookup
  on public.dispatch_history (tenant_id, dedup_key, created_at desc);

create index if not exists dispatch_history_by_source_run
  on public.dispatch_history (tenant_id, source_run_id);

alter table public.dispatch_history enable row level security;

create policy dispatch_history_tenant_read
  on public.dispatch_history
  for select
  using (
    tenant_id in (
      select tenant_id from public.tenant_users where user_id = auth.uid()
    )
  );

comment on table public.dispatch_history is
  'A2A dispatch audit + dedup. Initial caller: supply-demand-balancer (agent #23). dedup_key shape = "<source_slug>:<target_slug>:<slug(city)>:<slug(category)>".';
