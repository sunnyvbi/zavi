
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
    perform vault.delete_secret(v_old_id);
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
