
create table if not exists public.site_form_notify (
  site_id    uuid primary key references public.sites (id) on delete cascade,
  muted      boolean not null default false,
  version    bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.site_form_notify enable row level security;
revoke all on public.site_form_notify from public, anon, authenticated;

create or replace function public.site_form_notify_target(p_site_id uuid)
returns table (
  tenant_id   uuid,
  owner_email text,
  hostname    text,
  label       text,
  status      text,
  muted       boolean,
  version     bigint
)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp as $$
begin
  return query
    select s.tenant_id,
           s.owner_email,
           s.hostname,
           coalesce(nullif(s.name, ''), s.label),
           s.status,
           coalesce(n.muted, false),
           coalesce(n.version, 0)
      from public.sites s
      left join public.site_form_notify n on n.site_id = s.id
     where s.id = p_site_id
     limit 1;
end $$;

create or replace function public.site_form_notify_set_muted(p_site_id uuid, p_muted boolean, p_expected_version bigint)
returns bigint
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare v bigint;
begin
  if p_site_id is null or p_muted is null or p_expected_version is null then
    raise exception 'invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from public.sites s where s.id = p_site_id) then
    return null;
  end if;
  insert into public.site_form_notify (site_id) values (p_site_id) on conflict (site_id) do nothing;
  update public.site_form_notify n
     set muted = p_muted, version = n.version + 1, updated_at = now()
   where n.site_id = p_site_id and n.version = p_expected_version
  returning n.version into v;
  return v;
end $$;

revoke all on function public.site_form_notify_target(uuid) from public, anon, authenticated;
revoke all on function public.site_form_notify_set_muted(uuid, boolean, bigint) from public, anon, authenticated;
grant execute on function public.site_form_notify_target(uuid) to service_role;
grant execute on function public.site_form_notify_set_muted(uuid, boolean, bigint) to service_role;
