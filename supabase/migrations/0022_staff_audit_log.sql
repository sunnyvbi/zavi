
create table staff_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null,
  actor_email text not null,
  action text not null,
  target_table text,
  target_id text,
  tenant_id uuid,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index staff_audit_log_actor_idx
  on staff_audit_log (actor_user_id, created_at desc);
create index staff_audit_log_target_idx
  on staff_audit_log (target_table, target_id);

