begin;

create table if not exists public.site_logo_previews (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  site_id      uuid not null,
  free         boolean not null default false,
  description  text not null check (char_length(btrim(description)) between 3 and 400),
  svg          text check (svg is null or char_length(svg) <= 2097152),
  model        text,
  cost_usd     numeric(12, 6),
  created_at   timestamptz not null default now(),
  constraint site_logo_previews_site_tenant_fk
    foreign key (site_id, tenant_id) references public.sites (id, tenant_id) on delete cascade
);

create unique index if not exists site_logo_previews_one_free_per_site
  on public.site_logo_previews (site_id) where free;

alter table public.site_logo_previews enable row level security;
revoke all on table public.site_logo_previews from public, anon, authenticated;

commit;
