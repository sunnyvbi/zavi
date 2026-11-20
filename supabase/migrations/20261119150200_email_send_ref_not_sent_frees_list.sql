begin;

alter table public.email_send_refs add column if not exists not_sent_at timestamptz;

create or replace function public.record_email_send_ref(
  p_tenant_id uuid, p_rail text, p_card_id uuid, p_route text, p_provider_ref text
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_found boolean;
begin
  if p_tenant_id is null or p_card_id is null or p_provider_ref is null then return false; end if;
  select o_found into v_found from public._email_card(p_tenant_id, p_rail, p_card_id, false);
  if not coalesce(v_found, false) then return false; end if;
  insert into email_send_refs (tenant_id, rail, card_id, route, provider_ref)
  values (p_tenant_id, p_rail, p_card_id, p_route, p_provider_ref)
  on conflict (rail, card_id) do update
    set provider_ref = excluded.provider_ref, route = excluded.route, recorded_at = now(), not_sent_at = null
    where email_send_refs.tenant_id = excluded.tenant_id;
  return true;
end $$;
revoke all on function public.record_email_send_ref(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_email_send_ref(uuid, text, uuid, text, text) to service_role;

create or replace function public.mark_email_send_ref_not_sent(p_tenant_id uuid, p_rail text, p_card_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  update email_send_refs s set not_sent_at = now()
   where s.tenant_id = p_tenant_id and s.rail = p_rail and s.card_id = p_card_id;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;
revoke all on function public.mark_email_send_ref_not_sent(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.mark_email_send_ref_not_sent(uuid, text, uuid) to service_role;

create or replace function public._email_decision_send_started(p_tenant_id uuid, p_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from email_bulk_sends b where b.decision_id = p_id and b.tenant_id = p_tenant_id
                   and b.total is distinct from 0)
      or exists (select 1 from email_send_refs s where s.rail = 'decisions' and s.card_id = p_id and s.tenant_id = p_tenant_id
                   and s.not_sent_at is null);
$$;
revoke all on function public._email_decision_send_started(uuid, uuid) from public, anon, authenticated;

commit;
