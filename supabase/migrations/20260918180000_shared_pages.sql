
create table if not exists public.shared_pages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  storage_path text not null,
  status text not null default 'private'
    check (status in ('private', 'public', 'revoked')),
  slug text,
  expires_at timestamptz,
  published_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint shared_pages_slug_uq unique (slug),
  constraint shared_pages_public_has_slug check (status <> 'public' or (slug is not null and expires_at is not null))
);

create index if not exists shared_pages_tenant_run_idx on public.shared_pages (tenant_id, run_id);

alter table public.shared_pages enable row level security;

create or replace function public.get_public_shared_page(p_slug text)
returns setof public.shared_pages
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select p.* from public.shared_pages p
  where p.slug = p_slug
    and p.status = 'public'
    and p.expires_at > now()
  limit 1;
$$;

revoke all on function public.get_public_shared_page(text) from public, anon, authenticated;
grant execute on function public.get_public_shared_page(text) to service_role;

insert into storage.buckets (id, name, public)
values ('shared-pages', 'shared-pages', false)
on conflict (id) do nothing;
