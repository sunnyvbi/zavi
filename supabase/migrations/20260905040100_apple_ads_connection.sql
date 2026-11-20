
create or replace function set_apple_ads_connection(
  p_tenant_id uuid,
  p_client_id text,
  p_team_id text,
  p_key_id text,
  p_private_key_pem text,
  p_refresh_token text,
  p_team_label text
) returns void
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare v_old_id uuid; v_new_id uuid; v_key text; v_val text;
begin
  if p_client_id is null or p_team_id is null or p_key_id is null or p_private_key_pem is null then
    raise exception 'set_apple_ads_connection: client_id, team_id, key_id, private_key_pem required' using errcode = '22023';
  end if;

  foreach v_key in array array[
    'apple_ads.client_id', 'apple_ads.team_id', 'apple_ads.key_id',
    'apple_ads.private_key_pem', 'apple_ads.refresh_token'
  ] loop
    select vault_secret_id into v_old_id from secrets
    where tenant_id = p_tenant_id and key = v_key;
    if v_old_id is not null then
      delete from vault.secrets where id = v_old_id;
      delete from secrets where tenant_id = p_tenant_id and key = v_key;
    end if;
  end loop;

  for v_key, v_val in
    select * from (values
      ('apple_ads.client_id', p_client_id),
      ('apple_ads.team_id', p_team_id),
      ('apple_ads.key_id', p_key_id),
      ('apple_ads.private_key_pem', p_private_key_pem),
      ('apple_ads.refresh_token', p_refresh_token)
    ) as t(k, v)
  loop
    if v_val is not null and v_val <> '' then
      v_new_id := vault.create_secret(v_val);
      insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, v_key, v_new_id);
    end if;
  end loop;

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (p_tenant_id, 'apple_ads', p_client_id, coalesce(p_team_label, 'Apple Ads'),
          array['searchadsorg']::text[], now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id, team_name = excluded.team_name,
                scopes = excluded.scopes, connected_at = excluded.connected_at;
end $$;

revoke all on function set_apple_ads_connection(uuid, text, text, text, text, text, text) from public;
grant execute on function set_apple_ads_connection(uuid, text, text, text, text, text, text) to service_role;
