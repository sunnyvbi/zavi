begin;

alter table public.sites add column if not exists preview_changed_at timestamptz;

create table if not exists public.site_preview_snapshots (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  site_id    uuid not null references public.sites(id) on delete cascade,
  device     text not null check (device in ('desktop', 'mobile')),
  path       text not null,
  taken_at   timestamptz not null,
  width      integer not null check (width between 1 and 4096),
  height     integer not null check (height between 1 and 4096),
  created_at timestamptz not null default now(),
  primary key (site_id, device)
);

alter table public.site_preview_snapshots enable row level security;
revoke all on public.site_preview_snapshots from public, anon, authenticated;
grant select, insert, update, delete on public.site_preview_snapshots to service_role;

create or replace function public.site_mark_preview_changed(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_at        timestamptz
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null or p_site_id is null or p_at is null then
    raise exception 'site_mark_preview_changed: tenant_id, site_id and at are required' using errcode = '22023';
  end if;
  update public.sites
     set preview_changed_at = greatest(coalesce(preview_changed_at, p_at), p_at)
   where id = p_site_id and tenant_id = p_tenant_id;
  return found;
end $$;

create or replace function public.site_set_preview_snapshot(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_device    text,
  p_path      text,
  p_taken_at  timestamptz,
  p_width     integer,
  p_height    integer
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_changed timestamptz;
  v_prev    text;
  v_at      timestamptz;
begin
  if p_tenant_id is null or p_site_id is null or p_taken_at is null or p_device is null then
    raise exception 'site_set_preview_snapshot: tenant_id, site_id, device and taken_at are required' using errcode = '22023';
  end if;
  if p_device not in ('desktop', 'mobile') then
    raise exception 'site_set_preview_snapshot: device must be desktop or mobile' using errcode = '22023';
  end if;
  if p_path is null
     or p_path !~ ('^' || lower(p_tenant_id::text) || '/' || lower(p_site_id::text) || '/site-preview-' || p_device || '-[0-9a-f]{12}\.jpg$') then
    raise exception 'site_set_preview_snapshot: the path is not this site''s snapshot' using errcode = '22023';
  end if;

  select s.preview_changed_at into v_changed
    from public.sites s
   where s.id = p_site_id and s.tenant_id = p_tenant_id
     and s.status not in ('deleting', 'deleted')
   for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found', 'replaced', null);
  end if;
  if v_changed is not null and v_changed >= p_taken_at then
    return jsonb_build_object('outcome', 'stale', 'replaced', null);
  end if;

  select p.path, p.taken_at into v_prev, v_at
    from public.site_preview_snapshots p
   where p.site_id = p_site_id and p.device = p_device
   for update;
  if found and v_at >= p_taken_at then
    return jsonb_build_object('outcome', 'stale', 'replaced', null);
  end if;

  insert into public.site_preview_snapshots (tenant_id, site_id, device, path, taken_at, width, height)
  values (p_tenant_id, p_site_id, p_device, p_path, p_taken_at, p_width, p_height)
  on conflict (site_id, device) do update
     set path = excluded.path, taken_at = excluded.taken_at,
         width = excluded.width, height = excluded.height, created_at = now();
  return jsonb_build_object('outcome', 'set', 'replaced', v_prev);
end $$;

revoke all on function public.site_mark_preview_changed(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.site_mark_preview_changed(uuid, uuid, timestamptz) to service_role;
revoke all on function public.site_set_preview_snapshot(uuid, uuid, text, text, timestamptz, integer, integer) from public, anon, authenticated;
grant execute on function public.site_set_preview_snapshot(uuid, uuid, text, text, timestamptz, integer, integer) to service_role;

commit;
