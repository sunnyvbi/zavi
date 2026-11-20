
begin;

create or replace function public.email_bulk_resolve_recipient(p_send_id uuid, p_email text)
returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select r.tenant_id
    from public.email_bulk_send_recipients r
   where r.send_id = p_send_id
     and r.email_at_send = lower(trim(p_email))
   limit 1
$$;
revoke all on function public.email_bulk_resolve_recipient(uuid, text) from public, anon, authenticated;
grant execute on function public.email_bulk_resolve_recipient(uuid, text) to service_role;

create index if not exists email_bulk_send_recipients_send_email_idx
  on public.email_bulk_send_recipients (send_id, email_at_send);

commit;
