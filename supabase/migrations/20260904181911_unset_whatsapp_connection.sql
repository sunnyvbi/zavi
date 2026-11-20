
create or replace function unset_whatsapp_connection(p_tenant_id uuid)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_disabled integer;
begin
  if p_tenant_id is null then
    raise exception 'unset_whatsapp_connection: p_tenant_id is required';
  end if;

  update whatsapp_threads
     set status = 'deleted',
         confirm_code = null,
         confirm_attempts = 0,
         pending_expires_at = null,
         updated_at = now()
   where tenant_id = p_tenant_id
     and status <> 'deleted';
  get diagnostics v_disabled = row_count;

  delete from connector_metadata
   where tenant_id = p_tenant_id and slug = 'whatsapp';

  return v_disabled;
end $$;

revoke all on function unset_whatsapp_connection(uuid) from public;

do $$
begin
  raise notice '20260904181911: unset_whatsapp_connection (tenant-scoped; deletes every non-deleted thread incl. pending binds, clears connector_metadata)';
end $$;
