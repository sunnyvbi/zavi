
create table if not exists patterns_run_log (
  id                       bigserial primary key,
  tenant_id                uuid not null references tenants(id) on delete cascade,
  started_at               timestamptz not null default now(),
  finished_at              timestamptz,
  status                   text not null check (status in ('ok','skip','error')),
  reason                   text,
  runs_considered          int not null default 0,
  artifacts_emitted        int not null default 0,
  artifacts_skipped_dup    int not null default 0,
  cost_usd                 numeric(10,4) default 0,
  error_text               text,
  created_at               timestamptz not null default now()
);

create index if not exists patterns_run_log_tenant_idx
  on patterns_run_log (tenant_id, started_at desc);

alter table patterns_run_log enable row level security;
