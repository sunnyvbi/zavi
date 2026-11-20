begin;

create or replace function public.email_bulk_settle_recipient(
  p_tenant_id  uuid,
  p_send_id    uuid,
  p_contact_id uuid,
  p_status     text
) returns boolean
language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_n int; v_domain text;
begin
  if p_tenant_id is null or p_send_id is null or p_contact_id is null
     or p_status not in ('sent', 'failed', 'unknown') then
    raise exception 'email_bulk_settle_recipient: invalid argument' using errcode = '22023';
  end if;
  if p_status = 'failed' then
    perform public._email_bulk_refund_claim(p_tenant_id, p_send_id, p_contact_id);
  end if;
  update public.email_bulk_send_recipients r
     set status = p_status, skip_reason = null, stamped_at = now()
   where r.send_id = p_send_id and r.tenant_id = p_tenant_id and r.contact_id = p_contact_id
     and (r.status = 'sending'
          or (r.status = 'unknown' and p_status in ('sent', 'failed'))
          or (r.status = 'skipped' and r.skip_reason = 'erased'));
  get diagnostics v_n = row_count;
  if v_n > 0 and p_status in ('sent', 'unknown') then
    select nullif(lower(split_part(s.from_address, '@', 2)), '') into v_domain
      from public.email_bulk_sends s
     where s.id = p_send_id and s.tenant_id = p_tenant_id;
    if v_domain is not null then
      perform public.touch_domain_warmup(p_tenant_id, v_domain, (now() at time zone 'utc')::date);
    end if;
  end if;
  return v_n > 0;
end $$;
revoke all on function public.email_bulk_settle_recipient(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.email_bulk_settle_recipient(uuid, uuid, uuid, text) to service_role;

commit;
