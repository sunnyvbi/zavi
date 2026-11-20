begin;

create table if not exists public.site_design_briefs (
  site_id            uuid primary key references public.sites(id) on delete cascade,
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  conductor_run_id   uuid not null,
  brief              jsonb not null,
  directions         jsonb not null default '[]'::jsonb,
  theme_mode         text not null default 'none' check (theme_mode in ('theme_css', 'index_css', 'none')),
  chosen_direction   text not null default 'brand' check (chosen_direction ~ '^[a-z][a-z0-9-]{1,30}$'),
  chosen_by          uuid,
  chosen_at          timestamptz,
  applied_direction  text check (applied_direction is null or applied_direction ~ '^[a-z][a-z0-9-]{1,30}$'),
  applied_at         timestamptz,
  sealed_at          timestamptz,
  fidelity           jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists site_design_briefs_tenant_run_idx
  on public.site_design_briefs (tenant_id, conductor_run_id);

alter table public.site_design_briefs enable row level security;
revoke all on public.site_design_briefs from public, anon, authenticated;
grant select, insert, update, delete on public.site_design_briefs to service_role;

commit;
