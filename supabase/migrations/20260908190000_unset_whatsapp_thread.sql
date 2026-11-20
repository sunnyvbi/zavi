
create or replace function unset_whatsapp_thread(
  p_tenant_id uuid,
  p_thread_id uuid
) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_updated integer;
  v_left integer;
begin
  if p_tenant_id is null or p_thread_id is null then
    raise exception 'unset_whatsapp_thread: p_tenant_id and p_thread_id are required';
  end if;

  update whatsapp_threads
     set status = 'deleted',
         confirm_code = null,
         confirm_attempts = 0,
         pending_expires_at = null,
         updated_at = now()
   where id = p_thread_id
     and tenant_id = p_tenant_id
     and status <> 'deleted';
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    return null;
  end if;

  select count(*) into v_left
    from whatsapp_threads
   where tenant_id = p_tenant_id
     and status = 'enabled';

  if v_left = 0 then
    delete from connector_metadata
     where tenant_id = p_tenant_id and slug = 'whatsapp';
  end if;

  return v_left;
end $$;

revoke all on function unset_whatsapp_thread(uuid, uuid) from public;

do $$
begin
  raise notice '20260908190000: unset_whatsapp_thread (one thread by tenant + id; clears connector_metadata only when no enabled thread remains)';
end $$;
