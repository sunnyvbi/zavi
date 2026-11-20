
begin;

create table if not exists public.extension_screenshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null,
  image_path text not null unique,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

comment on table public.extension_screenshots is
  'Ownership + daily-cap ledger for Zavi Chrome-extension screenshots stored in agent-chat-images. Server writes only; revoke soft-deletes (deleted_at) after removing the storage object.';

alter table public.extension_screenshots enable row level security;

revoke all on public.extension_screenshots from anon, authenticated;

commit;
