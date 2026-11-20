
alter table public.creator_invites
  add column if not exists signup_token uuid not null default gen_random_uuid();

create unique index if not exists creator_invites_signup_token_uq
  on public.creator_invites (signup_token);
