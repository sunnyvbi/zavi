
create table if not exists public.customer_email_once (
  dedupe_key text primary key,
  claimed_at timestamptz not null default now(),
  sent_at    timestamptz
);

alter table public.customer_email_once enable row level security;
revoke all on public.customer_email_once from anon, authenticated;
