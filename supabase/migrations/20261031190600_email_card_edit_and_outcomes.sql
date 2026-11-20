
begin;

create or replace function public.replace_email_card(
  p_tenant_id uuid,
  p_rail      text,
  p_id        uuid,
  p_new_rail  text,
  p_new_id    uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
  v_ptr jsonb;
begin
  if p_tenant_id is null or p_id is null or p_new_id is null or p_id = p_new_id
     or p_new_rail not in ('channel_actions', 'decisions') then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into c from public._email_card(p_tenant_id, p_rail, p_id, true);
  if not c.o_found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if not c.o_open or c.o_status = 'failed' then
    return jsonb_build_object('ok', true, 'replaced', false, 'status', c.o_status);
  end if;
  v_ptr := jsonb_build_object('replaced_by', jsonb_build_object('rail', p_new_rail, 'id', p_new_id));
  if p_rail = 'channel_actions' then
    update channel_actions
       set status = 'rejected', status_at = now(), note = 'replaced_by_newer_draft',
           exec_payload = exec_payload || v_ptr
     where id = p_id;
    insert into channel_action_events (tenant_id, action_id, event, actor_kind, note, event_key)
    values (p_tenant_id, p_id, 'rejected', 'system', 'replaced_by_newer_draft', 'replaced:' || p_new_id::text)
    on conflict (action_id, event_key) do nothing;
  else
    update decisions
       set status = 'rejected', rejected_at = now(), body = body || v_ptr || jsonb_build_object('rejected_reason', 'replaced_by_newer_draft')
     where id = p_id and status = 'proposed';
  end if;
  return jsonb_build_object('ok', true, 'replaced', true);
end $$;
revoke all on function public.replace_email_card(uuid, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.replace_email_card(uuid, text, uuid, text, uuid) to service_role;

create or replace function public.edit_email_card_variant(
  p_tenant_id    uuid,
  p_rail         text,
  p_id           uuid,
  p_variant      int,
  p_user_id       uuid,
  p_expected_body jsonb,
  p_sealed        jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
  v_n int;
  v_body jsonb;
begin
  if p_tenant_id is null or p_id is null or p_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into c from public._email_card(p_tenant_id, p_rail, p_id, true);
  if not c.o_found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  v_n := public._email_card_versions(c.o_body);
  if v_n = 0 then return jsonb_build_object('ok', false, 'code', 'redraft_required'); end if;
  if not c.o_open or c.o_status = 'failed' then
    return jsonb_build_object('ok', false, 'code', 'not_open', 'status', c.o_status);
  end if;
  if p_variant is null or p_variant < 1 or p_variant > v_n then
    return jsonb_build_object('ok', false, 'code', 'bad_variant');
  end if;
  if p_expected_body is null or c.o_body <> p_expected_body then
    return jsonb_build_object('ok', false, 'code', 'card_changed');
  end if;
  if jsonb_typeof(p_sealed) <> 'object' or jsonb_typeof(p_sealed->'content') <> 'object'
     or coalesce(p_sealed->>'html', '') = '' or coalesce(p_sealed->>'text', '') = ''
     or coalesce(p_sealed->>'render_sha', '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'bad_variant');
  end if;
  v_body := jsonb_set(c.o_body, array['variants', (p_variant - 1)::text], p_sealed)
            || jsonb_build_object('edited_by', p_user_id, 'edited_at', now());
  if p_rail = 'channel_actions' then
    update channel_actions set exec_payload = v_body where id = p_id;
  else
    update decisions set body = v_body where id = p_id and status = 'proposed';
  end if;
  return jsonb_build_object('ok', true, 'test_sha', public.email_card_test_sha(v_body, p_variant));
end $$;
revoke all on function public.edit_email_card_variant(uuid, text, uuid, int, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.edit_email_card_variant(uuid, text, uuid, int, uuid, jsonb, jsonb) to service_role;

create table if not exists public.email_send_outcomes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  rail       text not null check (rail in ('channel_actions', 'decisions')),
  card_id    uuid not null,
  outcome    text not null check (outcome in ('sent', 'failed')),
  line       text not null check (char_length(line) between 1 and 500),
  created_at timestamptz not null default now(),
  unique (rail, card_id, outcome)
);
alter table public.email_send_outcomes enable row level security;
revoke all on public.email_send_outcomes from anon, authenticated;
grant all on public.email_send_outcomes to service_role;

create or replace function public.claim_email_send_outcome(
  p_tenant_id uuid, p_rail text, p_card_id uuid, p_outcome text, p_line text
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id    uuid;
  v_found boolean;
begin
  if p_tenant_id is null or p_card_id is null then return false; end if;
  select o_found into v_found from public._email_card(p_tenant_id, p_rail, p_card_id, false);
  if not coalesce(v_found, false) then return false; end if;
  insert into email_send_outcomes (tenant_id, rail, card_id, outcome, line)
  values (p_tenant_id, p_rail, p_card_id, p_outcome, left(p_line, 500))
  on conflict (rail, card_id, outcome) do nothing
  returning id into v_id;
  return v_id is not null;
end $$;
revoke all on function public.claim_email_send_outcome(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_email_send_outcome(uuid, text, uuid, text, text) to service_role;

commit;
