
begin;

create table if not exists public.extension_auth_codes (
  id         uuid primary key default gen_random_uuid(),
  code_hash  text not null unique,
  user_id    uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);

comment on table public.extension_auth_codes is
  'Single-use, 60s codes that hand a zaviagent.com session to the Zavi Chrome extension. Stores only the SHA-256 of the code. Server writes only; RLS on with no policies.';

alter table public.extension_auth_codes enable row level security;

revoke all on public.extension_auth_codes from anon, authenticated;

commit;
