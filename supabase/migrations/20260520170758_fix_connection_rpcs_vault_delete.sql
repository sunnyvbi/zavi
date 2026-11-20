

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
  if v_old_at is not null then delete from vault.secrets where id = v_old_at; delete from secrets where tenant_id = p_tenant_id and key = 'meta_ads.access_token'; end if;
  v_new_at := vault.create_secret(p_access_token);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'meta_ads.access_token', v_new_at);

  select vault_secret_id into v_old_aa from secrets where tenant_id = p_tenant_id and key = 'meta_ads.ad_account_id';
  if v_old_aa is not null then delete from vault.secrets where id = v_old_aa; delete from secrets where tenant_id = p_tenant_id and key = 'meta_ads.ad_account_id'; end if;
  v_new_aa := vault.create_secret(p_ad_account_id);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'meta_ads.ad_account_id', v_new_aa);

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (p_tenant_id, 'meta_ads', p_ad_account_id, 'Meta Ads', array['ads_read', 'ads_management']::text[], now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id, scopes = excluded.scopes, connected_at = excluded.connected_at;

  insert into tenant_mcp_servers (tenant_id, server_id, transport, enabled)
  values (p_tenant_id, 'meta_ads', 'internal', true)
  on conflict (tenant_id, server_id) do update set
    transport = excluded.transport,
    enabled   = true;
end $$;

revoke all on function set_meta_ads_connection(uuid, text, text) from public;

create or replace function set_google_ads_connection(
  p_tenant_id uuid,
  p_refresh_token text,
  p_customer_id text,
  p_login_customer_id text
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  v_old uuid; v_new uuid;
begin
  select vault_secret_id into v_old from secrets where tenant_id = p_tenant_id and key = 'google_ads.refresh_token';
  if v_old is not null then delete from vault.secrets where id = v_old; delete from secrets where tenant_id = p_tenant_id and key = 'google_ads.refresh_token'; end if;
  v_new := vault.create_secret(p_refresh_token);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'google_ads.refresh_token', v_new);

  select vault_secret_id into v_old from secrets where tenant_id = p_tenant_id and key = 'google_ads.customer_id';
  if v_old is not null then delete from vault.secrets where id = v_old; delete from secrets where tenant_id = p_tenant_id and key = 'google_ads.customer_id'; end if;
  v_new := vault.create_secret(p_customer_id);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'google_ads.customer_id', v_new);

  select vault_secret_id into v_old from secrets where tenant_id = p_tenant_id and key = 'google_ads.login_customer_id';
  if v_old is not null then delete from vault.secrets where id = v_old; delete from secrets where tenant_id = p_tenant_id and key = 'google_ads.login_customer_id'; end if;
  if p_login_customer_id is not null and length(p_login_customer_id) > 0 then
    v_new := vault.create_secret(p_login_customer_id);
    insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'google_ads.login_customer_id', v_new);
  end if;

  for v_old in
    select vault_secret_id from secrets
    where tenant_id = p_tenant_id and key in (
      'google_ads.access_token', 'google_ads.developer_token',
      'google_ads.client_id', 'google_ads.client_secret'
    )
  loop
    delete from vault.secrets where id = v_old;
  end loop;
  delete from secrets where tenant_id = p_tenant_id
    and key in (
      'google_ads.access_token', 'google_ads.developer_token',
      'google_ads.client_id', 'google_ads.client_secret'
    );

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (p_tenant_id, 'google_ads', p_customer_id, 'Google Ads', array['adwords']::text[], now())
  on conflict (tenant_id, slug)
  do update set team_id = excluded.team_id, scopes = excluded.scopes, connected_at = excluded.connected_at;

  insert into tenant_mcp_servers (tenant_id, server_id, transport, enabled)
  values (p_tenant_id, 'google_ads', 'internal', true)
  on conflict (tenant_id, server_id) do update set
    transport = excluded.transport,
    enabled   = true;
end $$;

revoke all on function set_google_ads_connection(uuid, text, text, text) from public;

create or replace function set_stripe_connection(
  p_tenant_id uuid,
  p_api_key text,
  p_account_id text,
  p_account_email text,
  p_country text,
  p_default_currency text,
  p_capabilities text[]
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare v_old_id uuid; v_new_id uuid;
begin
  select vault_secret_id into v_old_id from secrets
  where tenant_id = p_tenant_id and key = 'stripe.api_key';
  if v_old_id is not null then
    delete from vault.secrets where id = v_old_id;
    delete from secrets where tenant_id = p_tenant_id and key = 'stripe.api_key';
  end if;

  v_new_id := vault.create_secret(p_api_key);
  insert into secrets (tenant_id, key, vault_secret_id)
  values (p_tenant_id, 'stripe.api_key', v_new_id);

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (
    p_tenant_id,
    'stripe',
    p_account_id,
    coalesce(p_account_email, 'unknown'),
    coalesce(p_capabilities, array[]::text[]),
    now()
  )
  on conflict (tenant_id, slug)
  do update set
    team_id = excluded.team_id,
    team_name = excluded.team_name,
    scopes = excluded.scopes,
    connected_at = excluded.connected_at;
end $$;
revoke all on function set_stripe_connection(uuid, text, text, text, text, text, text[]) from public;

create or replace function set_email_connection(
  p_tenant_id uuid,
  p_provider text,
  p_api_key text,
  p_from_address text,
  p_from_name text,
  p_capabilities text[]
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  v_old_api uuid;
  v_old_from uuid;
  v_old_from_name uuid;
  v_new_api uuid;
  v_new_from uuid;
  v_new_from_name uuid;
begin
  select vault_secret_id into v_old_api from secrets
    where tenant_id = p_tenant_id and key = 'email.api_key';
  if v_old_api is not null then
    delete from vault.secrets where id = v_old_api;
    delete from secrets where tenant_id = p_tenant_id and key = 'email.api_key';
  end if;
  v_new_api := vault.create_secret(p_api_key);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'email.api_key', v_new_api);

  select vault_secret_id into v_old_from from secrets
    where tenant_id = p_tenant_id and key = 'email.from_address';
  if v_old_from is not null then
    delete from vault.secrets where id = v_old_from;
    delete from secrets where tenant_id = p_tenant_id and key = 'email.from_address';
  end if;
  v_new_from := vault.create_secret(p_from_address);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'email.from_address', v_new_from);

  if p_from_name is not null and length(p_from_name) > 0 then
    select vault_secret_id into v_old_from_name from secrets
      where tenant_id = p_tenant_id and key = 'email.from_name';
    if v_old_from_name is not null then
      delete from vault.secrets where id = v_old_from_name;
      delete from secrets where tenant_id = p_tenant_id and key = 'email.from_name';
    end if;
    v_new_from_name := vault.create_secret(p_from_name);
    insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'email.from_name', v_new_from_name);
  end if;

  insert into connector_metadata (tenant_id, slug, team_id, team_name, scopes, connected_at)
  values (
    p_tenant_id,
    'email',
    coalesce(p_provider, 'sendgrid'),
    p_from_address,
    coalesce(p_capabilities, array['mail.send']::text[]),
    now()
  )
  on conflict (tenant_id, slug)
  do update set
    team_id = excluded.team_id,
    team_name = excluded.team_name,
    scopes = excluded.scopes,
    connected_at = excluded.connected_at;
end $$;
revoke all on function set_email_connection(uuid, text, text, text, text, text[]) from public;
