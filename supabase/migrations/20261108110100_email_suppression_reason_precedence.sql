create or replace function public.email_suppression_reason_rank(p_reason text)
returns int
language sql immutable set search_path = public, pg_temp as $$
  select case p_reason
           when 'erased' then 5
           when 'complaint' then 4
           when 'unsubscribe' then 3
           when 'bounce' then 2
           else 1
         end
$$;
revoke all on function public.email_suppression_reason_rank(text) from public, anon, authenticated;
grant execute on function public.email_suppression_reason_rank(text) to service_role;

create or replace function suppress_email(
  p_tenant_id uuid,
  p_email     text,
  p_reason    text default 'unsubscribe'
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_token uuid;
begin
  if p_tenant_id is null or p_email is null then
    raise exception 'suppress_email: null argument' using errcode = '22023';
  end if;
  if p_reason not in ('unsubscribe', 'bounce', 'complaint', 'manual') then
    raise exception 'suppress_email: invalid reason %', p_reason using errcode = '22023';
  end if;

  insert into email_suppression (tenant_id, email, reason)
  values (p_tenant_id, lower(p_email), p_reason)
  on conflict (tenant_id, email) do update
    set reason = case
                   when public.email_suppression_reason_rank(excluded.reason) > public.email_suppression_reason_rank(email_suppression.reason)
                     then excluded.reason
                   else email_suppression.reason
                 end
  returning unsub_token into v_token;

  return v_token;
end $$;
revoke all on function suppress_email(uuid, text, text) from public, anon, authenticated;
grant execute on function suppress_email(uuid, text, text) to service_role;

create or replace function public.email_unsubscribe_and_count(p_tenant_id uuid, p_email text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_email   text := lower(trim(p_email));
  v_contact uuid;
  v_marked  uuid;
  v_counted int := 0;
begin
  if p_tenant_id is null or v_email is null or v_email = '' then
    raise exception 'email_unsubscribe_and_count: null argument' using errcode = '22023';
  end if;
  insert into email_suppression (tenant_id, email, reason)
  values (p_tenant_id, v_email, 'unsubscribe')
  on conflict (tenant_id, email) do update
    set reason = case
                   when public.email_suppression_reason_rank(excluded.reason) > public.email_suppression_reason_rank(email_suppression.reason)
                     then excluded.reason
                   else email_suppression.reason
                 end;
  select id into v_contact from email_contacts where tenant_id = p_tenant_id and email_norm = v_email;
  if v_contact is null then
    return jsonb_build_object('ok', true, 'new', false, 'sends_counted', 0);
  end if;
  insert into email_unsubscribe_marks (tenant_id, contact_id) values (p_tenant_id, v_contact)
  on conflict (tenant_id, contact_id) do nothing
  returning contact_id into v_marked;
  if v_marked is not null then
    update email_bulk_sends s
       set unsubscribes = s.unsubscribes + 1
      from (select distinct r.send_id
              from email_bulk_send_recipients r
             where r.tenant_id = p_tenant_id and r.contact_id = v_contact and r.status = 'sent') x
     where s.tenant_id = p_tenant_id and s.id = x.send_id
       and not exists (select 1 from email_send_results e
                        where e.rail = 'decisions' and e.card_id = s.decision_id and e.d7_published_at is not null);
    get diagnostics v_counted = row_count;
  end if;
  return jsonb_build_object('ok', true, 'new', v_marked is not null, 'sends_counted', v_counted);
end $$;
revoke all on function public.email_unsubscribe_and_count(uuid, text) from public, anon, authenticated;
grant execute on function public.email_unsubscribe_and_count(uuid, text) to service_role;
