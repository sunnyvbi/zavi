begin;

create table if not exists public.site_seo_audits (
  site_id        uuid        primary key references public.sites (id) on delete cascade,
  tenant_id      uuid        not null references public.tenants (id) on delete cascade,
  url            text        not null check (length(url) <= 2000),
  deploy_id      text        check (length(deploy_id) <= 200),
  status         text        not null check (status in ('ok', 'error')),
  error_code     text        check (length(error_code) <= 200),
  report         jsonb       check (report is null or jsonb_typeof(report) = 'object'),
  geo_report     jsonb       check (geo_report is null or jsonb_typeof(geo_report) = 'object'),
  notes          jsonb       not null default '[]'::jsonb check (jsonb_typeof(notes) = 'array'),
  schema_version int         not null default 1,
  fetched_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint site_seo_audits_ok_has_report check (status <> 'ok' or (report is not null and geo_report is not null)),
  constraint site_seo_audits_error_has_code check (status <> 'error' or error_code is not null),
  constraint site_seo_audits_tenant_site unique (tenant_id, site_id)
);

alter table public.site_seo_audits enable row level security;
revoke all on table public.site_seo_audits from public, anon, authenticated;
grant all on table public.site_seo_audits to service_role;

commit;
