
begin;

create table if not exists public.site_preview_leases (
  site_id    uuid primary key references public.sites(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  kind       text not null check (kind in ('restart', 'wake', 'edit')),
  token      uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.site_preview_leases enable row level security;
revoke all on public.site_preview_leases from public, anon, authenticated;

create or replace function public.claim_site_preview_lease(
  p_tenant_id   uuid,
  p_site_id     uuid,
  p_kind        text,
  p_ttl_seconds integer
) returns table (token uuid, held_kind text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row   public.site_preview_leases;
  v_token uuid := gen_random_uuid();
begin
  if p_tenant_id is null or p_site_id is null or p_kind not in ('restart', 'wake', 'edit')
     or p_ttl_seconds is null or p_ttl_seconds < 1 or p_ttl_seconds > 3600 then
    raise exception 'claim_site_preview_lease: tenant, site, kind and a 1..3600s ttl are required' using errcode = '22023';
  end if;
  perform 1 from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'claim_site_preview_lease: site % is not this tenant''s', p_site_id using errcode = 'P0002';
  end if;
  select * into v_row from public.site_preview_leases l where l.site_id = p_site_id;
  if found and v_row.expires_at > now() then
    return query select null::uuid, v_row.kind;
    return;
  end if;
  insert into public.site_preview_leases as l (site_id, tenant_id, kind, token, expires_at)
  values (p_site_id, p_tenant_id, p_kind, v_token, now() + make_interval(secs => p_ttl_seconds))
  on conflict (site_id) do update
    set tenant_id = excluded.tenant_id, kind = excluded.kind, token = excluded.token,
        expires_at = excluded.expires_at, created_at = now();
  return query select v_token, null::text;
end $$;

create or replace function public.release_site_preview_lease(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_token     uuid default null,
  p_kind      text default null
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null or p_site_id is null or (p_token is null and p_kind is null) then
    raise exception 'release_site_preview_lease: tenant, site and a token or kind are required' using errcode = '22023';
  end if;
  delete from public.site_preview_leases l
   where l.site_id = p_site_id and l.tenant_id = p_tenant_id
     and (case when p_token is not null then l.token = p_token else l.kind = p_kind end);
  return found;
end $$;

create or replace function public.site_preview_lease_held(
  p_tenant_id uuid,
  p_site_id   uuid
) returns text
language sql security definer stable
set search_path = pg_catalog, pg_temp as $$
  select l.kind from public.site_preview_leases l
   where l.site_id = p_site_id and l.tenant_id = p_tenant_id and l.expires_at > now();
$$;

create table if not exists public.site_inline_edit_calls (
  id         bigint generated always as identity primary key,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  app_id     text not null check (length(app_id) between 1 and 200),
  created_at timestamptz not null default now()
);
create index if not exists site_inline_edit_calls_tenant_time_idx
  on public.site_inline_edit_calls (tenant_id, created_at desc);
alter table public.site_inline_edit_calls enable row level security;
revoke all on public.site_inline_edit_calls from public, anon, authenticated;

create or replace function public.take_inline_edit_call(
  p_tenant_id          uuid,
  p_app_id             text,
  p_per_site_per_min   integer,
  p_per_tenant_per_day integer
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_n integer;
begin
  if p_tenant_id is null or p_app_id is null or length(p_app_id) not between 1 and 200
     or p_per_site_per_min is null or p_per_site_per_min < 1
     or p_per_tenant_per_day is null or p_per_tenant_per_day < 1 then
    raise exception 'take_inline_edit_call: tenant, app and positive limits are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('inline_edit:' || p_tenant_id::text, 0));
  delete from public.site_inline_edit_calls c
   where c.tenant_id = p_tenant_id and c.created_at < now() - interval '2 days';
  select count(*) into v_n from public.site_inline_edit_calls c
   where c.tenant_id = p_tenant_id and c.app_id = p_app_id and c.created_at > now() - interval '1 minute';
  if v_n >= p_per_site_per_min then
    return 'site_rate_limited';
  end if;
  select count(*) into v_n from public.site_inline_edit_calls c
   where c.tenant_id = p_tenant_id and c.created_at > now() - interval '1 day';
  if v_n >= p_per_tenant_per_day then
    return 'daily_cap';
  end if;
  insert into public.site_inline_edit_calls (tenant_id, app_id) values (p_tenant_id, p_app_id);
  return 'ok';
end $$;

revoke execute on function public.claim_site_preview_lease(uuid, uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.release_site_preview_lease(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.site_preview_lease_held(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.take_inline_edit_call(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_site_preview_lease(uuid, uuid, text, integer) to service_role;
grant execute on function public.release_site_preview_lease(uuid, uuid, uuid, text) to service_role;
grant execute on function public.site_preview_lease_held(uuid, uuid) to service_role;
grant execute on function public.take_inline_edit_call(uuid, text, integer, integer) to service_role;

commit;
