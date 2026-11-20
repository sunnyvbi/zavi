begin;

create or replace function public.peek_domain_warmup(
  p_tenant_id uuid,
  p_domain    text,
  p_day       date
) returns int
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare w email_domain_warmup%rowtype;
begin
  if p_tenant_id is null or p_domain is null or p_day is null then
    raise exception 'peek_domain_warmup: null argument' using errcode = '22023';
  end if;
  select * into w from email_domain_warmup d where d.tenant_id = p_tenant_id and d.domain = lower(p_domain);
  if not found then return 0; end if;
  if w.last_sent_on is null or w.last_sent_on < p_day then return w.day_index + 1; end if;
  return w.day_index;
end $$;
revoke all on function public.peek_domain_warmup(uuid, text, date) from public, anon, authenticated;
grant execute on function public.peek_domain_warmup(uuid, text, date) to service_role;

create or replace function public.consume_email_send_or_reject(
  p_tenant_id   uuid,
  p_day         date,
  p_daily_cap   int,
  p_warmup_cap  int
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count int;
begin
  if p_tenant_id is null or p_day is null or p_daily_cap is null or p_warmup_cap is null then
    raise exception 'consume_email_send_or_reject: null argument' using errcode = '22023';
  end if;
  insert into email_send_counters (tenant_id, day)
  values (p_tenant_id, p_day)
  on conflict (tenant_id, day) do nothing;
  update email_send_counters
     set sent_count = sent_count + 1, updated_at = now()
   where tenant_id = p_tenant_id
     and day = p_day
     and (p_daily_cap <= 0 or sent_count + 1 <= p_daily_cap)
     and (p_warmup_cap <= 0 or sent_count - bulk_sent_count + 1 <= p_warmup_cap)
  returning sent_count into v_count;
  return v_count is not null;
end $$;
revoke all on function public.consume_email_send_or_reject(uuid, date, int, int) from public, anon, authenticated;
grant execute on function public.consume_email_send_or_reject(uuid, date, int, int) to service_role;

commit;
