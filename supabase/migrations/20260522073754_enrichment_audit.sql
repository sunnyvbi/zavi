
create table if not exists enrichment_audit (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid,
  mode            text not null check (mode in ('resolve_only','full')),
  outcome         text not null,
  resolved_domain text,
  pages_fetched   int  not null default 0,
  cost_usd        numeric(10,4) not null default 0,
  aborted_reason  text,
  total_ms        int  not null default 0,
  created_at      timestamptz not null default now()
);

create index if not exists enrichment_audit_created_idx
  on enrichment_audit (created_at desc);
create index if not exists enrichment_audit_outcome_idx
  on enrichment_audit (outcome);

alter table enrichment_audit enable row level security;
