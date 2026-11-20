
begin;

create or replace function public.site_set_name(
  p_tenant_id     uuid,
  p_site_id       uuid,
  p_expected_name text,
  p_name          text
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_name text;
  v_cur  text;
begin
  if p_tenant_id is null or p_site_id is null then
    raise exception 'site_set_name: tenant_id and site_id are required' using errcode = '22023';
  end if;
  v_name := nullif(btrim(left(btrim(regexp_replace(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', ' ', 'g'), '\s+', ' ', 'g')), 60)), '');
  if v_name is null then
    raise exception 'site_set_name: the name is empty' using errcode = '22023';
  end if;

  select s.name into v_cur
    from public.sites s
   where s.id = p_site_id and s.tenant_id = p_tenant_id
   for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found', 'name', null);
  end if;
  if v_cur is not distinct from v_name then
    return jsonb_build_object('outcome', 'already_applied', 'name', v_cur);
  end if;
  if v_cur is distinct from p_expected_name then
    return jsonb_build_object('outcome', 'stale_preview', 'name', null);
  end if;

  update public.sites
     set name = v_name, updated_at = now()
   where id = p_site_id and tenant_id = p_tenant_id;
  return jsonb_build_object('outcome', 'updated', 'name', v_name);
end $$;

revoke all on function public.site_set_name(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.site_set_name(uuid, uuid, text, text) to service_role;

commit;
