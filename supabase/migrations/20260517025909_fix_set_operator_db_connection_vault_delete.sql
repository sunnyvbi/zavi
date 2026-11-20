
create or replace function set_operator_db_connection(
  p_tenant_id uuid,
  p_type text,
  p_connection_string text,
  p_schema_map jsonb
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  v_old uuid;
  v_new uuid;
  v_secret_key text := 'operator_db.connection_string';
begin
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

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (
    p_tenant_id,
    'operator_db',
    p_type,
    'Operator DB',
    array['read', 'update_status']::text[],
    now()
  )
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id, connected_at = excluded.connected_at;
end $$;
revoke all on function set_operator_db_connection(uuid, text, text, jsonb) from public;
