
begin;

create or replace function purge_tenant_credentials(p_tenant_id uuid)
returns integer
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_secret record;
  v_purged integer := 0;
begin
  if p_tenant_id is null then
    raise exception 'purge_tenant_credentials: tenant_id is required';
  end if;

  for v_secret in
    select vault_secret_id from secrets where tenant_id = p_tenant_id
      and not exists (
        select 1 from public.site_providers sp
         where sp.tenant_id = p_tenant_id
           and sp.kind = 'supabase_project'
           and sp.state <> 'deleted'
           and secrets.key in ('site.' || sp.site_id::text || '.sb_service_role',
                               'site.' || sp.site_id::text || '.sb_anon',
                               'site.' || sp.site_id::text || '.sb_db_password'))
  loop
    delete from vault.secrets where id = v_secret.vault_secret_id;
    v_purged := v_purged + 1;
  end loop;

  delete from secrets where tenant_id = p_tenant_id
      and not exists (
        select 1 from public.site_providers sp
         where sp.tenant_id = p_tenant_id
           and sp.kind = 'supabase_project'
           and sp.state <> 'deleted'
           and secrets.key in ('site.' || sp.site_id::text || '.sb_service_role',
                               'site.' || sp.site_id::text || '.sb_anon',
                               'site.' || sp.site_id::text || '.sb_db_password'));
  delete from connector_metadata where tenant_id = p_tenant_id;

  update tenant_mcp_servers set enabled = false where tenant_id = p_tenant_id;

  return v_purged;
end $$;

comment on function purge_tenant_credentials(uuid) is
  'Deletes every Vault secret + connector_metadata row for one tenant and disables its MCP servers, EXCEPT a new-flow site''s own keys (site.<id>.sb_*) while its Supabase project is not yet hard-deleted (the 7-day undo; delete_site_secrets drops them later). Account-deletion teardown only (routes/account). Returns the number of Vault secrets removed.';

revoke all on function purge_tenant_credentials(uuid) from public, anon, authenticated;
grant execute on function purge_tenant_credentials(uuid) to service_role;

commit;
