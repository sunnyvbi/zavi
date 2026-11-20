
begin;

alter table public.sites add column if not exists thumbnail_path text;
alter table public.sites add column if not exists thumbnail_at timestamptz;

create or replace function public.site_set_thumbnail(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_path      text,
  p_taken_at  timestamptz
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_prev text;
  v_at   timestamptz;
begin
  if p_tenant_id is null or p_site_id is null or p_taken_at is null then
    raise exception 'site_set_thumbnail: tenant_id, site_id and taken_at are required' using errcode = '22023';
  end if;
  if p_path is null
     or p_path !~ ('^' || lower(p_tenant_id::text) || '/' || lower(p_site_id::text) || '/site-thumb-[0-9a-f]{12}\.jpg$') then
    raise exception 'site_set_thumbnail: the path is not this site''s thumbnail' using errcode = '22023';
  end if;

  select s.thumbnail_path, s.thumbnail_at into v_prev, v_at
    from public.sites s
   where s.id = p_site_id and s.tenant_id = p_tenant_id
     and s.status not in ('deleting', 'deleted')
   for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found', 'replaced', null);
  end if;
  if v_at is not null and v_at >= p_taken_at then
    return jsonb_build_object('outcome', 'stale', 'replaced', null);
  end if;

  update public.sites
     set thumbnail_path = p_path, thumbnail_at = p_taken_at
   where id = p_site_id and tenant_id = p_tenant_id;
  return jsonb_build_object('outcome', 'set', 'replaced', v_prev);
end $$;

revoke all on function public.site_set_thumbnail(uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.site_set_thumbnail(uuid, uuid, text, timestamptz) to service_role;

commit;
