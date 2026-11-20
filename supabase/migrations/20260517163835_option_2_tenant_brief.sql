
alter table tenants
  add column notification_email   text check (notification_email is null or notification_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  add column notification_phone   text check (notification_phone is null or notification_phone ~ '^\+[1-9]\d{1,14}$'),
  add column timezone             text not null default 'America/Los_Angeles',
  add column digest_frequency     text not null default 'off' check (digest_frequency in ('off', 'daily')),
  add column sms_enabled          boolean not null default false;

alter table decision_classes
  add column severity text not null default 'low' check (severity in ('low', 'medium', 'high'));

update decision_classes set severity = 'high' where slug in (
  'trust-safety.action',
  'payouts-recon.notify',
  'dispute-response.submit-evidence'
);

create table tenant_brief_dispatches (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  dispatch_date   date not null,
  surface         text not null check (surface in ('email', 'sms')),
  outcome         text not null check (outcome in ('claimed', 'sent', 'suppressed_no_delta', 'error')),
  outcome_reason  text,
  window_start    timestamptz,
  window_end      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, dispatch_date, surface)
);

alter table tenant_brief_dispatches enable row level security;

create policy briefs_member_select on tenant_brief_dispatches
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = tenant_brief_dispatches.tenant_id
    )
  );

