
create table if not exists public.investor_reference (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  title                text,
  primary_firm         text,
  check_buckets        text[]      default '{}',
  niches               text[]      default '{}',
  stages               text[]      default '{}',
  leads_rounds         boolean     default false,
  selected_investments text,
  email                text,
  geographies          text[]      default '{}',
  twitter              text,
  linkedin             text,
  bio                  text,
  based_in             text,
  last_modified        timestamptz,
  created_at           timestamptz not null default now()
);

alter table public.investor_reference enable row level security;

drop policy if exists investor_reference_read on public.investor_reference;
create policy investor_reference_read
  on public.investor_reference
  for select
  to authenticated
  using (true);

grant select on public.investor_reference to authenticated;
revoke insert, update, delete on public.investor_reference from authenticated, anon;
