begin;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'email_send_outcomes' and column_name = 'claimed_at'
  ) then
    alter table public.email_send_outcomes add column claimed_at timestamptz;
    update public.email_send_outcomes set claimed_at = created_at;
  end if;
end $$;
alter table public.email_send_outcomes alter column claimed_at set default now();

create or replace function public.claim_email_send_outcome_tell(
  p_tenant_id uuid, p_rail text, p_card_id uuid, p_outcome text, p_line text, p_kind text default ''
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_inserted boolean;
  v_found    boolean;
begin
  if p_tenant_id is null or p_card_id is null then return 'taken'; end if;
  select o_found into v_found from public._email_card(p_tenant_id, p_rail, p_card_id, false);
  if not coalesce(v_found, false) then return 'taken'; end if;
  insert into email_send_outcomes as x (tenant_id, rail, card_id, outcome, line, kind, claimed_at)
  values (p_tenant_id, p_rail, p_card_id, p_outcome, left(p_line, 500), coalesce(p_kind, ''), now())
  on conflict (rail, card_id, outcome, kind) do update
    set claimed_at = now(), line = excluded.line
    where x.claimed_at is null and x.tenant_id = p_tenant_id
  returning (xmax = 0) into v_inserted;
  if v_inserted is null then return 'taken'; end if;
  return case when v_inserted then 'claimed' else 'reclaimed' end;
end $$;
revoke all on function public.claim_email_send_outcome_tell(uuid, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_email_send_outcome_tell(uuid, text, uuid, text, text, text) to service_role;

create or replace function public.release_email_send_outcome(
  p_tenant_id uuid, p_rail text, p_card_id uuid, p_outcome text, p_kind text default ''
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n int;
begin
  if p_tenant_id is null or p_card_id is null then return false; end if;
  update email_send_outcomes
     set claimed_at = null
   where tenant_id = p_tenant_id and rail = p_rail and card_id = p_card_id
     and outcome = p_outcome and kind = coalesce(p_kind, '') and claimed_at is not null;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;
revoke all on function public.release_email_send_outcome(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.release_email_send_outcome(uuid, text, uuid, text, text) to service_role;

create or replace function public.keep_email_send_outcome_line(
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
  insert into email_send_outcomes (tenant_id, rail, card_id, outcome, line, kind, claimed_at)
  values (p_tenant_id, p_rail, p_card_id, p_outcome, left(p_line, 500), coalesce(p_kind, ''), null)
  on conflict (rail, card_id, outcome, kind) do nothing
  returning id into v_id;
  return v_id is not null;
end $$;
revoke all on function public.keep_email_send_outcome_line(uuid, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.keep_email_send_outcome_line(uuid, text, uuid, text, text, text) to service_role;

commit;
