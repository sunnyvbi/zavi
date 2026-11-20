
create table if not exists public.engineer_prototype_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  slug text not null,
  artifact_path text not null,
  status text not null default 'published'
    check (status in ('published', 'blocked', 'revoked')),
  expires_at timestamptz not null default now() + interval '30 days',
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint engineer_prototype_links_run_uq unique (run_id),
  constraint engineer_prototype_links_slug_uq unique (slug)
);

alter table public.engineer_prototype_links enable row level security;

create or replace function public.create_prototype_link(
  p_run_id uuid,
  p_slug text,
  p_artifact_path text,
  p_status text default 'published',
  p_ttl_days int default 30
) returns public.engineer_prototype_links
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_row public.engineer_prototype_links;
begin
  select tenant_id into v_tenant from public.agent_runs where id = p_run_id;
  if v_tenant is null then
    raise exception 'run % not found', p_run_id using errcode = 'P0002';
  end if;

  insert into public.engineer_prototype_links
    (tenant_id, run_id, slug, artifact_path, status, expires_at)
  values
    (v_tenant, p_run_id, p_slug, p_artifact_path, p_status,
     now() + make_interval(days => greatest(1, least(p_ttl_days, 365))))
  on conflict (run_id) do update
    set artifact_path = excluded.artifact_path,
        status = excluded.status,
        expires_at = excluded.expires_at,
        revoked_at = null
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function public.create_prototype_link(uuid, text, text, text, int) from public, anon, authenticated;
grant execute on function public.create_prototype_link(uuid, text, text, text, int) to service_role;

create or replace function public.get_prototype_link_by_slug(p_slug text)
returns setof public.engineer_prototype_links
language sql
security definer
set search_path = public
stable
as $$
  select l.* from public.engineer_prototype_links l
  where l.slug = p_slug
    and l.status = 'published'
    and l.revoked_at is null
    and l.expires_at > now()
  limit 1;
$$;

revoke all on function public.get_prototype_link_by_slug(text) from public, anon, authenticated;
grant execute on function public.get_prototype_link_by_slug(text) to service_role;

create or replace function public.revoke_prototype_link(p_run_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link public.engineer_prototype_links;
begin
  select * into v_link from public.engineer_prototype_links where run_id = p_run_id;
  if v_link.id is null then
    return false;
  end if;
  if not exists (
    select 1 from public.tenant_users tu
    where tu.tenant_id = v_link.tenant_id and tu.user_id = auth.uid()
  ) then
    raise exception 'not a member of this tenant' using errcode = '42501';
  end if;
  update public.engineer_prototype_links
    set status = 'revoked', revoked_at = now()
    where id = v_link.id and status <> 'revoked';
  return true;
end;
$$;

revoke all on function public.revoke_prototype_link(uuid) from public, anon;
grant execute on function public.revoke_prototype_link(uuid) to authenticated, service_role;

insert into storage.buckets (id, name, public)
values ('prototype-links', 'prototype-links', false)
on conflict (id) do nothing;
