
create or replace function set_sendgrid_connection(
  p_tenant_id uuid,
  p_api_key text,
  p_scopes jsonb
) returns void
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_old_id uuid;
  v_new_id uuid;
  v_passed text[];
begin
  if p_tenant_id is null or p_api_key is null or length(btrim(p_api_key)) = 0 then
    raise exception 'set_sendgrid_connection: tenant and api key required' using errcode = '22023';
  end if;
  if p_scopes is null or jsonb_typeof(p_scopes) <> 'object' then
    raise exception 'set_sendgrid_connection: p_scopes must be an object' using errcode = '22023';
  end if;

  select coalesce(array_agg(k order by k), array[]::text[]) into v_passed
    from jsonb_each(p_scopes) as e(k, v)
    where v = 'true'::jsonb and k ~ '^[a-z_]{1,64}$';

  select vault_secret_id into v_old_id from secrets
    where tenant_id = p_tenant_id and key = 'email.api_key';
  if v_old_id is not null then
    delete from vault.secrets where id = v_old_id;
    delete from secrets where tenant_id = p_tenant_id and key = 'email.api_key';
  end if;
  v_new_id := vault.create_secret(p_api_key);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'email.api_key', v_new_id);

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (p_tenant_id, 'email', 'sendgrid', 'SendGrid', v_passed, now())
  on conflict (tenant_id, slug)
  do update set
    team_id = excluded.team_id,
    team_name = coalesce(connector_metadata.team_name, excluded.team_name),
    scopes = excluded.scopes,
    connected_at = excluded.connected_at;
end $$;

revoke all on function set_sendgrid_connection(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function set_sendgrid_connection(uuid, text, jsonb) to service_role;
