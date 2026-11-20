
create or replace function set_google_ads_connection(
  p_tenant_id uuid,
  p_access_token text,
  p_developer_token text,
  p_customer_id text,
  p_login_customer_id text
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  v_old_at uuid; v_new_at uuid;
  v_old_dt uuid; v_new_dt uuid;
  v_old_ci uuid; v_new_ci uuid;
  v_old_lci uuid; v_new_lci uuid;
begin
  select vault_secret_id into v_old_at from secrets where tenant_id = p_tenant_id and key = 'google_ads.access_token';
  if v_old_at is not null then perform vault.delete_secret(v_old_at); delete from secrets where tenant_id = p_tenant_id and key = 'google_ads.access_token'; end if;
  v_new_at := vault.create_secret(p_access_token);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'google_ads.access_token', v_new_at);

  select vault_secret_id into v_old_dt from secrets where tenant_id = p_tenant_id and key = 'google_ads.developer_token';
  if v_old_dt is not null then perform vault.delete_secret(v_old_dt); delete from secrets where tenant_id = p_tenant_id and key = 'google_ads.developer_token'; end if;
  v_new_dt := vault.create_secret(p_developer_token);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'google_ads.developer_token', v_new_dt);

  select vault_secret_id into v_old_ci from secrets where tenant_id = p_tenant_id and key = 'google_ads.customer_id';
  if v_old_ci is not null then perform vault.delete_secret(v_old_ci); delete from secrets where tenant_id = p_tenant_id and key = 'google_ads.customer_id'; end if;
  v_new_ci := vault.create_secret(p_customer_id);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'google_ads.customer_id', v_new_ci);

  if p_login_customer_id is not null and length(p_login_customer_id) > 0 then
    select vault_secret_id into v_old_lci from secrets where tenant_id = p_tenant_id and key = 'google_ads.login_customer_id';
    if v_old_lci is not null then perform vault.delete_secret(v_old_lci); delete from secrets where tenant_id = p_tenant_id and key = 'google_ads.login_customer_id'; end if;
    v_new_lci := vault.create_secret(p_login_customer_id);
    insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'google_ads.login_customer_id', v_new_lci);
  end if;

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (p_tenant_id, 'google_ads', p_customer_id, 'Google Ads', array['adwords']::text[], now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id, scopes = excluded.scopes, connected_at = excluded.connected_at;
end $$;
revoke all on function set_google_ads_connection(uuid, text, text, text, text) from public;

create or replace function set_meta_ads_connection(
  p_tenant_id uuid,
  p_access_token text,
  p_ad_account_id text
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  v_old_at uuid; v_new_at uuid;
  v_old_aa uuid; v_new_aa uuid;
begin
  select vault_secret_id into v_old_at from secrets where tenant_id = p_tenant_id and key = 'meta_ads.access_token';
  if v_old_at is not null then perform vault.delete_secret(v_old_at); delete from secrets where tenant_id = p_tenant_id and key = 'meta_ads.access_token'; end if;
  v_new_at := vault.create_secret(p_access_token);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'meta_ads.access_token', v_new_at);

  select vault_secret_id into v_old_aa from secrets where tenant_id = p_tenant_id and key = 'meta_ads.ad_account_id';
  if v_old_aa is not null then perform vault.delete_secret(v_old_aa); delete from secrets where tenant_id = p_tenant_id and key = 'meta_ads.ad_account_id'; end if;
  v_new_aa := vault.create_secret(p_ad_account_id);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'meta_ads.ad_account_id', v_new_aa);

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (p_tenant_id, 'meta_ads', p_ad_account_id, 'Meta Ads', array['ads_read', 'ads_management']::text[], now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id, scopes = excluded.scopes, connected_at = excluded.connected_at;
end $$;
revoke all on function set_meta_ads_connection(uuid, text, text) from public;
