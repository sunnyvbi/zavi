
create table if not exists public.start_card_reports (
  id                 uuid primary key default gen_random_uuid(),
  card_id            uuid not null references public.start_cards(id) on delete cascade,
  kind               text not null check (kind in ('removal','report')),
  email              text check (email is null or length(email) <= 320),
  reason             text check (reason is null or length(reason) <= 1000),
  verify_token_hash  text unique,
  created_at         timestamptz not null default now(),
  handled_at         timestamptz,
  check ((kind = 'removal' and verify_token_hash is not null and email is null)
      or (kind = 'report' and verify_token_hash is null and email is not null))
);

alter table public.start_card_reports enable row level security;
alter table public.start_card_reports force row level security;

revoke all on table public.start_card_reports from public, anon, authenticated;
grant all on table public.start_card_reports to service_role;
