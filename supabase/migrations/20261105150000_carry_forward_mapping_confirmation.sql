
create or replace function carry_forward_mapping_confirmation(
  p_tenant_id uuid,
  p_catalog_hash text
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_current_hash text;
  v_catalog jsonb;
  v_disc_err text;
  v_from_hash text;
  v_map jsonb;
  v_by uuid;
  v_at timestamptz;
  v_mode text;
  v_secret_at timestamptz;
  v_key text;
  v_val jsonb;
  v_table text;
  v_fkey text;
  v_fval text;
  v_type text;
  v_types text[];
  v_new jsonb := '{}'::jsonb;
  v_roles int := 0;
begin
  if p_tenant_id is null or p_catalog_hash is null then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtext('operator_db_connection:' || p_tenant_id::text));
  select catalog_hash, catalog, discovery_error
    into v_current_hash, v_catalog, v_disc_err
    from tenant_db_catalog
   where tenant_id = p_tenant_id
   for update;
  if v_current_hash is null or v_disc_err is not null or v_current_hash <> p_catalog_hash then
    return false;
  end if;

  if exists (select 1 from mapping_confirmed where tenant_id = p_tenant_id and catalog_hash = p_catalog_hash) then
    return false;
  end if;

  select catalog_hash, confirmed_map, confirmed_by, confirmed_at
    into v_from_hash, v_map, v_by, v_at
    from mapping_confirmed
   where tenant_id = p_tenant_id and confirmed_by is not null
   order by confirmed_at desc
   limit 1;
  if v_map is null or jsonb_typeof(v_map) <> 'object' then
    return false;
  end if;

  select c.mode, s.created_at into v_mode, v_secret_at
    from tenant_db_config c
    left join secrets s on s.tenant_id = c.tenant_id and s.key = c.connection_secret_key
   where c.tenant_id = p_tenant_id;
  if coalesce(v_mode, 'direct') <> 'direct' or v_secret_at is null or v_secret_at > v_at then
    return false;
  end if;

  for v_key, v_val in select * from jsonb_each(v_map)
  loop
    if jsonb_typeof(v_val) = 'object' and (v_val ? 'table') then
      v_table := v_val->>'table';
      if v_table is null or length(trim(v_table)) = 0 then
        return false;
      end if;
      if (select count(*) from jsonb_array_elements(coalesce(v_catalog->'tables', '[]'::jsonb)) t
           where t->>'name' = v_table) <> 1 then
        return false;
      end if;
      for v_fkey, v_fval in select * from jsonb_each_text(v_val)
      loop
        if (v_fkey = 'field' or v_fkey ~ '_field$')
           and v_fval is not null and length(trim(v_fval)) > 0 then
          select c->>'type' into v_type
            from jsonb_array_elements(coalesce(v_catalog->'tables', '[]'::jsonb)) t,
                 jsonb_array_elements(coalesce(t->'columns', '[]'::jsonb)) c
           where t->>'name' = v_table and c->>'name' = v_fval
           limit 1;
          if not found then
            return false;
          end if;
          if v_fkey in ('created_at_field', 'listed_at_field') then
            v_types := array_remove(string_to_array(coalesce(trim(v_type), ''), '|'), 'Null');
            if coalesce(array_length(v_types, 1), 0) <> 1
               or trim(v_types[1]) !~* '^(date|datetime|timestamp|timestamptz)([^a-z]|$)' then
              return false;
            end if;
          end if;
        end if;
      end loop;
      v_new := v_new || jsonb_build_object(v_key, v_val || jsonb_build_object('carried_from', v_from_hash));
      v_roles := v_roles + 1;
    else
      v_new := v_new || jsonb_build_object(v_key, v_val);
    end if;
  end loop;

  if v_roles = 0 then
    return false;
  end if;

  insert into mapping_confirmed (tenant_id, catalog_hash, confirmed_map, confirmed_by, confirmed_at)
  values (p_tenant_id, p_catalog_hash, v_new, v_by, v_at)
  on conflict (tenant_id, catalog_hash) do nothing;

  return found;
end $$;
revoke all on function carry_forward_mapping_confirmation(uuid, text) from public, anon, authenticated;
grant execute on function carry_forward_mapping_confirmation(uuid, text) to service_role;
