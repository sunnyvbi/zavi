
create or replace function unset_teams_connection(p_tenant_id uuid)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_removed integer;
begin
  delete from teams_tenants where tenant_id = p_tenant_id;
  get diagnostics v_removed = row_count;

  delete from connector_metadata
   where tenant_id = p_tenant_id and slug = 'teams';

  return v_removed;
end $$;

revoke all on function unset_teams_connection(uuid) from public;

do $$
begin
  raise notice '20260919200000: unset_teams_connection (delete tenant mapping + connector_metadata)';
end $$;
