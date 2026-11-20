
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
    perform vault.delete_secret(v_old_api);
    delete from secrets where tenant_id = p_tenant_id and key = 'email.api_key';
  end if;
  v_new_api := vault.create_secret(p_api_key);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'email.api_key', v_new_api);

  select vault_secret_id into v_old_from from secrets
    where tenant_id = p_tenant_id and key = 'email.from_address';
  if v_old_from is not null then
    perform vault.delete_secret(v_old_from);
    delete from secrets where tenant_id = p_tenant_id and key = 'email.from_address';
  end if;
  v_new_from := vault.create_secret(p_from_address);
  insert into secrets (tenant_id, key, vault_secret_id) values (p_tenant_id, 'email.from_address', v_new_from);

  if p_from_name is not null and length(p_from_name) > 0 then
    select vault_secret_id into v_old_from_name from secrets
      where tenant_id = p_tenant_id and key = 'email.from_name';
    if v_old_from_name is not null then
      perform vault.delete_secret(v_old_from_name);
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
