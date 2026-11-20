begin;

create or replace function merge_website_edit(
  p_tenant_id uuid,
  p_app_id    text,
  p_selector  text,
  p_patch     jsonb,
  p_remove    boolean default false,
  p_replace   boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prior website_edits%rowtype;
  v_current website_edits%rowtype;
  v_found boolean;
  v_patch jsonb;
begin
  if p_tenant_id is null or coalesce(p_app_id, '') = '' or coalesce(p_selector, '') = '' then
    raise exception 'merge_website_edit: tenant, app and selector are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('website_edit:' || p_tenant_id::text || ':' || p_app_id || ':' || p_selector, 0));
  select * into v_prior
    from website_edits
   where tenant_id = p_tenant_id
     and app_id = p_app_id
     and selector = p_selector
   for update;
  v_found := found;
  if coalesce(p_remove, false) then
    v_patch := '{}'::jsonb;
  elsif coalesce(p_replace, false) or not v_found or v_prior.removed then
    v_patch := case when jsonb_typeof(p_patch) = 'object' then p_patch else '{}'::jsonb end;
  else
    v_patch := website_edit_merge_patch(v_prior.patch, p_patch);
  end if;
  insert into website_edits (tenant_id, app_id, selector, patch, removed, updated_at)
  values (p_tenant_id, p_app_id, p_selector, v_patch, coalesce(p_remove, false), now())
  on conflict (tenant_id, app_id, selector)
  do update set patch = excluded.patch, removed = excluded.removed, updated_at = excluded.updated_at
  returning * into v_current;
  return jsonb_build_object(
    'existed', v_found,
    'patch', case when v_found then v_prior.patch else null end,
    'removed', case when v_found then v_prior.removed else false end,
    'id', v_current.id,
    'updated_at', v_current.updated_at,
    'current_patch', v_current.patch
  );
end $$;

revoke all on function merge_website_edit(uuid, text, text, jsonb, boolean, boolean) from public, anon, authenticated;
grant execute on function merge_website_edit(uuid, text, text, jsonb, boolean, boolean) to service_role;

commit;
