begin;

create or replace function public.system_config_merge(p_patch jsonb)
returns void language sql security definer set search_path=public,pg_temp as $$
  insert into system_config(id, blob) values (1, coalesce(p_patch, '{}'::jsonb))
  on conflict (id) do update set blob = system_config.blob || excluded.blob, updated_at = now();
$$;
revoke all on function public.system_config_merge(jsonb) from public,anon,authenticated;
grant execute on function public.system_config_merge(jsonb) to service_role;

create or replace function public.system_config_set_channel_lock(p_slug text, p_locked boolean, p_actor uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_before jsonb; v_after jsonb;
begin
 if p_slug is null or p_slug = '' or p_locked is null then raise exception 'channel lock needs a slug and a state'; end if;
 insert into system_config(id, blob) values (1, '{}'::jsonb) on conflict (id) do nothing;
 select case when jsonb_typeof(blob->'locked_channel_slugs') = 'array' then blob->'locked_channel_slugs' else '[]'::jsonb end
   into strict v_before from system_config where id = 1 for update;
 select coalesce(jsonb_agg(e.s order by e.o), '[]'::jsonb) into v_after
   from jsonb_array_elements(v_before) with ordinality e(s, o) where e.s is distinct from to_jsonb(p_slug);
 if p_locked then v_after := v_after || jsonb_build_array(p_slug); end if;
 update system_config
    set blob = jsonb_set(blob, '{locked_channel_slugs}', v_after, true), updated_at = now(), updated_by = p_actor
  where id = 1;
 return jsonb_build_object('before', v_before, 'after', v_after);
end $$;
revoke all on function public.system_config_set_channel_lock(text,boolean,uuid) from public,anon,authenticated;
grant execute on function public.system_config_set_channel_lock(text,boolean,uuid) to service_role;

commit;
