
create table if not exists digest_send_audit (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  source_worker text not null,
  subject_hash text not null,
  guard_verdict text not null
    check (guard_verdict in ('sent', 'blocked_content', 'skipped_low_signal')),
  violations jsonb not null default '[]'::jsonb
);

alter table digest_send_audit enable row level security;

