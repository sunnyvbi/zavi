
begin;

alter table public.email_send_outcomes
  add column if not exists kind text not null default '' check (kind in ('', 'audience_mismatch'));
alter table public.email_send_outcomes drop constraint if exists email_send_outcomes_rail_card_id_outcome_key;
alter table public.email_send_outcomes
  add constraint email_send_outcomes_rail_card_id_outcome_kind_key unique (rail, card_id, outcome, kind);

drop function if exists public.claim_email_send_outcome(uuid, text, uuid, text, text);
create or replace function public.claim_email_send_outcome(
  p_tenant_id uuid, p_rail text, p_card_id uuid, p_outcome text, p_line text, p_kind text default ''
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id    uuid;
  v_found boolean;
begin
  if p_tenant_id is null or p_card_id is null then return false; end if;
  select o_found into v_found from public._email_card(p_tenant_id, p_rail, p_card_id, false);
  if not coalesce(v_found, false) then return false; end if;
  insert into email_send_outcomes (tenant_id, rail, card_id, outcome, line, kind)
  values (p_tenant_id, p_rail, p_card_id, p_outcome, left(p_line, 500), coalesce(p_kind, ''))
  on conflict (rail, card_id, outcome, kind) do nothing
  returning id into v_id;
  return v_id is not null;
end $$;
revoke all on function public.claim_email_send_outcome(uuid, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_email_send_outcome(uuid, text, uuid, text, text, text) to service_role;

commit;
