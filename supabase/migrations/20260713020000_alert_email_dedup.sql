
create table if not exists alert_email_dedup (
  dedupe_key   text primary key,
  sent_at      timestamptz not null default now(),
  confirmed_at timestamptz
);

create index if not exists alert_email_dedup_sent_at_idx
  on alert_email_dedup (sent_at);

alter table alert_email_dedup enable row level security;
