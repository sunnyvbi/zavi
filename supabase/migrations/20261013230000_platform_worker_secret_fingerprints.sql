
begin;

create table if not exists platform_worker_secret_fingerprints (
  account_id   text not null check (char_length(account_id) between 1 and 64),
  worker_name  text not null check (char_length(worker_name) between 1 and 63),
  secret_name  text not null check (secret_name ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  fingerprint  text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  updated_at   timestamptz not null default now(),
  primary key (account_id, worker_name, secret_name)
);

alter table platform_worker_secret_fingerprints enable row level security;
revoke all on public.platform_worker_secret_fingerprints from public, anon, authenticated;

commit;
