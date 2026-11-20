
drop function if exists set_google_ads_connection(uuid, text, text, text, text);

create or replace function set_google_ads_connection(
  p_tenant_id uuid,
  p_refresh_token text,
  p_client_id text,
  p_client_secret text,
  p_developer_token text,
  p_customer_id text,
  p_login_customer_id text
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  k record;
  v_old uuid;
  v_new uuid;
begin
  for k in
    select * from (values
      ('google_ads.refresh_token', p_refresh_token),
      ('google_ads.client_id', p_client_id),
      ('google_ads.client_secret', p_client_secret),
      ('google_ads.developer_token', p_developer_token),
      ('google_ads.customer_id', p_customer_id),
      ('google_ads.login_customer_id', p_login_customer_id)
    ) as t(key, value)
  loop
    if k.value is null or length(k.value) = 0 then
      continue;
    end if;
    select vault_secret_id into v_old from secrets where tenant_id = p_tenant_id and key = k.key;
    if v_old is not null then
      perform vault.delete_secret(v_old);
      delete from secrets where tenant_id = p_tenant_id and key = k.key;
    end if;
    v_new := vault.create_secret(k.value);
    insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, k.key, v_new);
  end loop;

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (p_tenant_id, 'google_ads', p_customer_id, 'Google Ads', array['adwords']::text[], now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id, scopes = excluded.scopes, connected_at = excluded.connected_at;
end $$;
revoke all on function set_google_ads_connection(uuid, text, text, text, text, text, text) from public;
