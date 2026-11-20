begin;

create table if not exists seo_audit_snapshots (
  tenant_id      uuid        primary key references tenants(id) on delete cascade,
  site           text        check (length(site) <= 2000),
  status         text        not null check (status in ('ok', 'error')),
  error_code     text        check (length(error_code) <= 200),
  report         jsonb       check (report is null or jsonb_typeof(report) = 'object'),
  notes          jsonb       not null default '[]'::jsonb
                             check (jsonb_typeof(notes) = 'array'),
  schema_version int         not null default 1,
  fetched_at     timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint seo_audit_snapshots_ok_has_report
    check (status <> 'ok' or report is not null),
  constraint seo_audit_snapshots_error_has_code
    check (status <> 'error' or error_code is not null)
);

alter table seo_audit_snapshots enable row level security;
revoke all on table seo_audit_snapshots from public, anon, authenticated;
grant all on table seo_audit_snapshots to service_role;

commit;
