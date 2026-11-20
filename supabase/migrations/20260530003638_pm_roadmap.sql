
begin;

create extension if not exists pgcrypto;

create table if not exists public.pm_roadmap (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  dedup_key           text not null,
  theme_normalized    text,
  theme               text,
  status              text not null
                        check (status in ('proposed','in_flight','shipped','measured'))
                        default 'proposed',
  first_seen_at       timestamptz default now(),
  last_dispatched_at  timestamptz,
  child_run_id        uuid,
  baseline_signature  text,
  outcome             text check (outcome in ('won','recurred')),
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

create unique index if not exists pm_roadmap_tenant_dedup_uq
  on public.pm_roadmap (tenant_id, dedup_key);

create index if not exists pm_roadmap_tenant_status_idx
  on public.pm_roadmap (tenant_id, status, updated_at desc);

alter table public.pm_roadmap enable row level security;

create policy pm_roadmap_tenant_read
  on public.pm_roadmap
  for select
  to authenticated
  using (
    tenant_id in (
      select tenant_id from public.tenant_users where user_id = auth.uid()
    )
  );

revoke insert, update, delete on public.pm_roadmap from authenticated, anon;
grant select on public.pm_roadmap to authenticated;
grant all on public.pm_roadmap to service_role;

comment on table public.pm_roadmap is
  'Per-tenant pm agent roadmap: tracks a backlog theme proposed->in_flight->shipped->measured with a won/recurred outcome. Flag-gated reads (system_config.blob.pm_roadmap_enabled); always-on row writes on dispatch. service-role writes only; tenant-scoped RLS read.';

commit;
