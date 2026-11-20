create or replace function public.email_contact_erase(p_tenant_id uuid, p_contact_id uuid)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_email text;
begin
  if p_tenant_id is null or p_contact_id is null then
    raise exception 'email_contact_erase: null argument' using errcode = '22023';
  end if;
  select c.email_norm into v_email from public.email_contacts c
   where c.id = p_contact_id and c.tenant_id = p_tenant_id and c.erased_at is null
   for update;
  if v_email is null then
    return false;
  end if;
  insert into public.email_suppression (tenant_id, email, reason)
  values (p_tenant_id, v_email, 'erased')
  on conflict (tenant_id, email) do update
    set reason = case
                   when public.email_suppression_reason_rank(excluded.reason) > public.email_suppression_reason_rank(email_suppression.reason)
                     then excluded.reason
                   else email_suppression.reason
                 end;
  update public.email_bulk_send_recipients r
     set status = 'skipped', skip_reason = 'erased', stamped_at = now()
   where r.tenant_id = p_tenant_id and r.contact_id = p_contact_id and r.status in ('pending', 'sending');
  update public.email_bulk_send_recipients r
     set email_at_send = null
   where r.tenant_id = p_tenant_id and r.contact_id = p_contact_id;
  update public.email_contacts c
     set erased_at = now(), email_norm = null, display_name = null, updated_at = now()
   where c.id = p_contact_id and c.tenant_id = p_tenant_id;
  return true;
end $$;
revoke all on function public.email_contact_erase(uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_contact_erase(uuid, uuid) to service_role;
