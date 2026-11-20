begin;

create or replace function website_edit_merge_patch(p_prior jsonb, p_next jsonb)
returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v_out  jsonb := case when jsonb_typeof(p_prior) = 'object' then p_prior else '{}'::jsonb end;
  v_next jsonb := case when jsonb_typeof(p_next) = 'object' then p_next else '{}'::jsonb end;
begin
  if v_next ? 'text' then
    v_out := (v_out - 'segments') || jsonb_build_object('text', v_next->'text');
  end if;
  if v_next ? 'segments' then
    if jsonb_typeof(v_out->'segments') = 'array'
       and jsonb_typeof(v_next->'segments') = 'array'
       and jsonb_array_length(v_out->'segments') = jsonb_array_length(v_next->'segments') then
      v_out := (v_out - 'text') || jsonb_build_object('segments', (
        select coalesce(
                 jsonb_agg(case when jsonb_typeof(n.elem) = 'null' then p.elem else n.elem end order by n.ord),
                 '[]'::jsonb)
          from jsonb_array_elements(v_next->'segments') with ordinality as n(elem, ord)
          join jsonb_array_elements(v_out->'segments') with ordinality as p(elem, ord) on p.ord = n.ord
      ));
    else
      v_out := (v_out - 'text') || jsonb_build_object('segments', v_next->'segments');
    end if;
  end if;
  if jsonb_typeof(v_next->'style') = 'object' then
    v_out := v_out || jsonb_build_object('style',
      (case when jsonb_typeof(v_out->'style') = 'object' then v_out->'style' else '{}'::jsonb end)
      || (v_next->'style'));
  end if;
  if jsonb_typeof(v_next->'attrs') = 'object' then
    v_out := v_out || jsonb_build_object('attrs',
      (case when jsonb_typeof(v_out->'attrs') = 'object' then v_out->'attrs' else '{}'::jsonb end)
      || (v_next->'attrs'));
  end if;
  return v_out;
end $$;

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
  do update set patch = excluded.patch, removed = excluded.removed, updated_at = excluded.updated_at;
  return jsonb_build_object(
    'existed', v_found,
    'patch',   case when v_found then v_prior.patch else null end,
    'removed', case when v_found then v_prior.removed else false end
  );
end $$;

revoke all on function website_edit_merge_patch(jsonb, jsonb) from public, anon, authenticated;
grant execute on function website_edit_merge_patch(jsonb, jsonb) to service_role;
revoke all on function merge_website_edit(uuid, text, text, jsonb, boolean, boolean) from public, anon, authenticated;
grant execute on function merge_website_edit(uuid, text, text, jsonb, boolean, boolean) to service_role;

commit;
