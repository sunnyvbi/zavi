begin;

create table if not exists public.email_test_send_attempts (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  rail       text not null check (rail in ('channel_actions', 'decisions')),
  card_id    uuid not null,
  user_id    uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists email_test_send_attempts_recent on public.email_test_send_attempts (tenant_id, rail, card_id, user_id, created_at);
alter table public.email_test_send_attempts enable row level security;
revoke all on public.email_test_send_attempts from public, anon, authenticated;

create or replace function public._email_card_takeover_ready(p_tenant_id uuid, p_rail text, p_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_rail = 'channel_actions' and exists (
    select 1 from channel_actions ca
     where ca.id = p_id and ca.tenant_id = p_tenant_id
       and ca.exec_class = 'email_campaign.create_and_send'
       and ca.approved_by is not null and ca.exec_status = 'failed'
       and ca.status in ('pending', 'snoozed')
       and public._email_card_retryable(ca.exec_result));
$$;
revoke all on function public._email_card_takeover_ready(uuid, text, uuid) from public, anon, authenticated;

create or replace function public.email_card_for_test(
  p_tenant_id uuid, p_rail text, p_id uuid, p_variant int, p_user_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
  v_recent int;
begin
  if p_tenant_id is null or p_id is null or p_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into c from public._email_card(p_tenant_id, p_rail, p_id, false);
  if not c.o_found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if public._email_card_versions(c.o_body) = 0 then return jsonb_build_object('ok', false, 'code', 'redraft_required'); end if;
  if not c.o_open and not public._email_card_takeover_ready(p_tenant_id, p_rail, p_id) then
    return jsonb_build_object('ok', false, 'code', 'not_open', 'status', c.o_status);
  end if;
  if p_variant is null or p_variant < 1 or p_variant > public._email_card_versions(c.o_body) then
    return jsonb_build_object('ok', false, 'code', 'bad_variant');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('email_test_rate:' || p_tenant_id::text || ':' || p_rail || ':' || p_id::text || ':' || p_user_id::text, 0));
  select count(*) into v_recent from email_test_send_attempts
   where tenant_id = p_tenant_id and rail = p_rail and card_id = p_id and user_id = p_user_id
     and created_at > now() - interval '1 hour';
  if v_recent >= 5 then return jsonb_build_object('ok', false, 'code', 'rate_limited'); end if;
  insert into email_test_send_attempts (tenant_id, rail, card_id, user_id) values (p_tenant_id, p_rail, p_id, p_user_id);
  return jsonb_build_object('ok', true, 'class', c.o_class, 'body', c.o_body,
                            'test_sha', public.email_card_test_sha(c.o_body, p_variant));
end $$;
revoke all on function public.email_card_for_test(uuid, text, uuid, int, uuid) from public, anon, authenticated;
grant execute on function public.email_card_for_test(uuid, text, uuid, int, uuid) to service_role;

create or replace function public.record_email_test_send(
  p_tenant_id uuid, p_rail text, p_id uuid, p_variant int, p_user_id uuid, p_test_sha text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
  v_recent int;
begin
  if p_tenant_id is null or p_id is null or p_user_id is null or p_test_sha is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into c from public._email_card(p_tenant_id, p_rail, p_id, true);
  if not c.o_found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if public._email_card_versions(c.o_body) = 0 or p_variant is null
     or p_variant < 1 or p_variant > public._email_card_versions(c.o_body) then
    return jsonb_build_object('ok', false, 'code', 'bad_variant');
  end if;
  if not c.o_open and not public._email_card_takeover_ready(p_tenant_id, p_rail, p_id) then
    return jsonb_build_object('ok', false, 'code', 'not_open', 'status', c.o_status);
  end if;
  if public.email_card_test_sha(c.o_body, p_variant) <> p_test_sha then
    return jsonb_build_object('ok', false, 'code', 'card_changed');
  end if;
  select count(*) into v_recent from email_test_sends
   where tenant_id = p_tenant_id and rail = p_rail and card_id = p_id and user_id = p_user_id
     and created_at > now() - interval '1 hour';
  if v_recent >= 5 then return jsonb_build_object('ok', false, 'code', 'rate_limited'); end if;
  insert into email_test_sends (tenant_id, rail, card_id, variant, test_sha, user_id)
  values (p_tenant_id, p_rail, p_id, p_variant, p_test_sha, p_user_id);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.record_email_test_send(uuid, text, uuid, int, uuid, text) from public, anon, authenticated;
grant execute on function public.record_email_test_send(uuid, text, uuid, int, uuid, text) to service_role;

commit;
