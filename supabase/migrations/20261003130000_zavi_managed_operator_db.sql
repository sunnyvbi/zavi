
alter table connector_metadata add column if not exists managed_by text;

alter table tenant_resources add column if not exists metrics_declaration jsonb;

create or replace function set_operator_db_connection(
  p_tenant_id uuid,
  p_type text,
  p_connection_string text,
  p_schema_map jsonb
) returns void
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_old uuid;
  v_new uuid;
  v_secret_key text := 'operator_db.connection_string';
begin
  perform _assert_tenant_admin(p_tenant_id);
  perform pg_advisory_xact_lock(hashtext('operator_db_connection:' || p_tenant_id::text));

  select vault_secret_id into v_old from secrets
   where tenant_id = p_tenant_id and key = v_secret_key;
  if v_old is not null then
    delete from vault.secrets where id = v_old;
    delete from secrets where tenant_id = p_tenant_id and key = v_secret_key;
  end if;
  v_new := vault.create_secret(p_connection_string);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, v_secret_key, v_new);

  insert into tenant_db_config (tenant_id, type, connection_secret_key, schema_map, updated_at)
  values (p_tenant_id, p_type::operator_db_type, v_secret_key, p_schema_map, now())
  on conflict (tenant_id)
  do update set
    type = excluded.type,
    connection_secret_key = excluded.connection_secret_key,
    schema_map = excluded.schema_map,
    updated_at = now();

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at, managed_by)
  values (
    p_tenant_id,
    'operator_db',
    p_type,
    'Operator DB',
    array['read', 'update_status']::text[],
    now(),
    null
  )
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id, connected_at = excluded.connected_at, managed_by = null;
end $$;
revoke all on function set_operator_db_connection(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function set_operator_db_connection(uuid, text, text, jsonb) to authenticated, service_role;

create or replace function set_managed_operator_db_connection(
  p_tenant_id uuid,
  p_connection_string text
) returns boolean
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_old uuid;
  v_new uuid;
  v_secret_key text := 'operator_db.connection_string';
begin
  if p_tenant_id is null or p_connection_string is null or length(p_connection_string) < 8 then
    raise exception 'tenant and connection string are required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from tenant_resources
     where tenant_id = p_tenant_id and resource_kind = 'db' and mode = 'provisioned'
  ) then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtext('operator_db_connection:' || p_tenant_id::text));

  if exists (
    select 1 from connector_metadata
     where tenant_id = p_tenant_id and slug = 'operator_db'
       and managed_by is distinct from 'zavi'
  ) then
    return false;
  end if;

  select vault_secret_id into v_old from secrets
   where tenant_id = p_tenant_id and key = v_secret_key;
  if v_old is not null then
    delete from vault.secrets where id = v_old;
    delete from secrets where tenant_id = p_tenant_id and key = v_secret_key;
  end if;
  v_new := vault.create_secret(p_connection_string);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, v_secret_key, v_new);

  insert into tenant_db_config (tenant_id, type, connection_secret_key, schema_map, updated_at)
  values (p_tenant_id, 'postgres'::operator_db_type, v_secret_key, '{}'::jsonb, now())
  on conflict (tenant_id)
  do update set
    type = excluded.type,
    connection_secret_key = excluded.connection_secret_key,
    schema_map = excluded.schema_map,
    updated_at = now();

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at, managed_by)
  values (p_tenant_id, 'operator_db', 'postgres', 'Operator DB', array['read']::text[], now(), 'zavi')
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id, connected_at = excluded.connected_at, managed_by = 'zavi'
  where connector_metadata.managed_by = 'zavi';

  return true;
end $$;
revoke all on function set_managed_operator_db_connection(uuid, text) from public, anon, authenticated;
grant execute on function set_managed_operator_db_connection(uuid, text) to service_role;

create or replace function set_mapping_confirmed_by_zavi(
  p_tenant_id uuid,
  p_catalog_hash text,
  p_confirmed_map jsonb
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_current_hash text;
  v_catalog jsonb;
  v_disc_err text;
  v_key text;
  v_val jsonb;
  v_table text;
  v_fkey text;
  v_fval text;
begin
  if p_confirmed_map is null or jsonb_typeof(p_confirmed_map) <> 'object' then
    raise exception 'confirmed_map must be a json object' using errcode = '22023';
  end if;

  if not exists (
    select 1 from connector_metadata
     where tenant_id = p_tenant_id and slug = 'operator_db' and managed_by = 'zavi'
  ) then
    return false;
  end if;

  select catalog_hash, catalog, discovery_error
    into v_current_hash, v_catalog, v_disc_err
    from tenant_db_catalog
   where tenant_id = p_tenant_id;

  if v_current_hash is null or v_disc_err is not null then
    return false;
  end if;
  if p_catalog_hash is null or p_catalog_hash <> v_current_hash then
    return false;
  end if;

  for v_key, v_val in select * from jsonb_each(p_confirmed_map)
  loop
    if jsonb_typeof(v_val) = 'object' and (v_val ? 'table') then
      v_table := v_val->>'table';

      if v_table is null or length(trim(v_table)) = 0 then
        raise exception 'mapping key % has empty table', v_key using errcode = '22023';
      end if;

      if not exists (
        select 1 from jsonb_array_elements(coalesce(v_catalog->'tables', '[]'::jsonb)) t
         where t->>'name' = v_table
      ) then
        raise exception 'mapping key % references unknown table %', v_key, v_table
          using errcode = '22023';
      end if;

      for v_fkey, v_fval in select * from jsonb_each_text(v_val)
      loop
        if (v_fkey = 'field' or v_fkey ~ '_field$')
           and v_fval is not null and length(trim(v_fval)) > 0 then
          if not exists (
            select 1
              from jsonb_array_elements(coalesce(v_catalog->'tables', '[]'::jsonb)) t,
                   jsonb_array_elements(coalesce(t->'columns', '[]'::jsonb)) c
             where t->>'name' = v_table
               and c->>'name' = v_fval
          ) then
            raise exception 'mapping key %.% references unknown field %.%',
              v_key, v_fkey, v_table, v_fval
              using errcode = '22023';
          end if;
        end if;
      end loop;
    end if;
  end loop;

  insert into mapping_confirmed (tenant_id, catalog_hash, confirmed_map, confirmed_by)
  values (p_tenant_id, p_catalog_hash, p_confirmed_map, null)
  on conflict (tenant_id, catalog_hash)
  do update set
    confirmed_map = excluded.confirmed_map,
    confirmed_at  = now(),
    updated_at    = now()
  where mapping_confirmed.confirmed_by is null;

  return true;
end $$;
revoke all on function set_mapping_confirmed_by_zavi(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function set_mapping_confirmed_by_zavi(uuid, text, jsonb) to service_role;
