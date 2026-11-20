
begin;

create table if not exists public.email_test_sends (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  rail       text not null check (rail in ('channel_actions', 'decisions')),
  card_id    uuid not null,
  variant    int  not null check (variant between 1 and 3),
  test_sha   text not null check (test_sha ~ '^[0-9a-f]{64}$'),
  user_id    uuid not null,
  created_at timestamptz not null default now()
);
alter table public.email_test_sends enable row level security;
revoke all on public.email_test_sends from anon, authenticated;
grant all on public.email_test_sends to service_role;

create or replace function public.email_card_test_sha(p_body jsonb, p_variant int)
returns text
language sql immutable set search_path = public, pg_temp as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'variant',            p_body->'variants'->(p_variant - 1),
    'template_snapshot',  p_body->'template_snapshot',
    'renderer_version',   p_body->'renderer_version',
    'tool',               p_body->'tool',
    'credential',         p_body->'credential',
    'audience_id',        p_body->'audience_id',
    'list_id',            p_body->'list_id',
    'list_version_id',    p_body->'list_version_id',
    'from_name',          p_body->'from_name',
    'from_email',         p_body->'from_email',
    'from_address',       p_body->'from_address',
    'reply_to',           p_body->'reply_to',
    'sendgrid_sender_id', p_body->'sendgrid_sender_id',
    'sendgrid_suppression_group_id', p_body->'sendgrid_suppression_group_id'
  )::text, 'UTF8')), 'hex')
$$;
revoke all on function public.email_card_test_sha(jsonb, int) from public, anon, authenticated;
grant execute on function public.email_card_test_sha(jsonb, int) to service_role;

create or replace function public._email_card(p_tenant_id uuid, p_rail text, p_id uuid, p_lock boolean,
  out o_found boolean, out o_class text, out o_body jsonb, out o_open boolean, out o_status text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ca channel_actions%rowtype;
  v_d  decisions%rowtype;
begin
  o_found := false;
  if p_rail = 'channel_actions' then
    if p_lock then
      select * into v_ca from channel_actions where id = p_id for update;
    else
      select * into v_ca from channel_actions where id = p_id;
    end if;
    if not found or v_ca.tenant_id is distinct from p_tenant_id
       or v_ca.exec_class is distinct from 'email_campaign.create_and_send' then
      return;
    end if;
    o_found := true;
    o_class := v_ca.exec_class;
    o_body := v_ca.exec_payload;
    o_status := coalesce(v_ca.exec_status, v_ca.status);
    o_open := v_ca.status in ('pending', 'snoozed') and (v_ca.exec_status is null or v_ca.exec_status = 'failed');
  elsif p_rail = 'decisions' then
    if p_lock then
      select * into v_d from decisions where id = p_id for update;
    else
      select * into v_d from decisions where id = p_id;
    end if;
    if not found or v_d.tenant_id is distinct from p_tenant_id
       or v_d.decision_class is null
       or v_d.decision_class not in ('email_campaign.create_and_send', 'bulk_outbound.send') then
      return;
    end if;
    o_found := true;
    o_class := v_d.decision_class;
    o_body := v_d.body;
    o_status := v_d.status;
    o_open := v_d.status = 'proposed';
  end if;
end $$;
revoke all on function public._email_card(uuid, text, uuid, boolean) from public, anon, authenticated;

create or replace function public._email_card_versions(p_body jsonb) returns int
language sql immutable set search_path = public, pg_temp as $$
  select case when jsonb_typeof(p_body->'variants') = 'array'
                   and p_body ? 'template_snapshot' and p_body ? 'renderer_version'
              then jsonb_array_length(p_body->'variants') else 0 end
$$;
revoke all on function public._email_card_versions(jsonb) from public, anon, authenticated;

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
  if not c.o_open then return jsonb_build_object('ok', false, 'code', 'not_open', 'status', c.o_status); end if;
  if p_variant is null or p_variant < 1 or p_variant > public._email_card_versions(c.o_body) then
    return jsonb_build_object('ok', false, 'code', 'bad_variant');
  end if;
  select count(*) into v_recent from email_test_sends
   where tenant_id = p_tenant_id and rail = p_rail and card_id = p_id and user_id = p_user_id
     and created_at > now() - interval '1 hour';
  if v_recent >= 5 then return jsonb_build_object('ok', false, 'code', 'rate_limited'); end if;
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
  if not c.o_open then return jsonb_build_object('ok', false, 'code', 'not_open', 'status', c.o_status); end if;
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

create or replace function public.email_card_view_state(
  p_tenant_id uuid, p_rail text, p_id uuid, p_user_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
  v_role text;
  v_n int;
  v_tests jsonb := '[]'::jsonb;
  v_sha text;
begin
  select role into v_role from tenant_users where tenant_id = p_tenant_id and user_id = p_user_id;
  if v_role is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  select * into c from public._email_card(p_tenant_id, p_rail, p_id, false);
  if not c.o_found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  v_n := public._email_card_versions(c.o_body);
  for i in 1..v_n loop
    v_sha := public.email_card_test_sha(c.o_body, i);
    v_tests := v_tests || jsonb_build_object(
      'variant', i,
      'tested_by_me', exists (select 1 from email_test_sends t
                               where t.tenant_id = p_tenant_id and t.rail = p_rail and t.card_id = p_id
                                 and t.variant = i and t.test_sha = v_sha and t.user_id = p_user_id),
      'tested_by_approver', exists (select 1 from email_test_sends t
                                     join tenant_users tu on tu.tenant_id = t.tenant_id and tu.user_id = t.user_id
                                    where t.tenant_id = p_tenant_id and t.rail = p_rail and t.card_id = p_id
                                      and t.variant = i and t.test_sha = v_sha and tu.role in ('owner', 'admin')));
  end loop;
  return jsonb_build_object('ok', true, 'class', c.o_class, 'body', c.o_body, 'open', c.o_open,
                            'status', c.o_status, 'role', v_role, 'versions', v_n, 'tests', v_tests);
end $$;
revoke all on function public.email_card_view_state(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_card_view_state(uuid, text, uuid, uuid) to service_role;

create or replace function public.approve_email_card(
  p_tenant_id      uuid,
  p_rail           text,
  p_id             uuid,
  p_variant        int,
  p_actor_user_id  uuid,
  p_event_key      text,
  p_approved_count int
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c     record;
  v_sha text;
  v_out jsonb;
begin
  if p_tenant_id is null or p_id is null or p_actor_user_id is null or p_rail not in ('channel_actions', 'decisions') then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into c from public._email_card(p_tenant_id, p_rail, p_id, true);
  if not c.o_found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if public._email_card_versions(c.o_body) = 0 then
    return jsonb_build_object('ok', false, 'code', 'redraft_required');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id
                    and role in ('owner', 'admin')) then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  if p_variant is null or p_variant < 1 or p_variant > public._email_card_versions(c.o_body) then
    return jsonb_build_object('ok', false, 'code', 'bad_variant');
  end if;
  if not c.o_open then
    if p_rail = 'channel_actions' and (c.o_body->>'chosen_variant')::int is not distinct from p_variant then
      perform set_config('zavi.email_card_approve', 'on', true);
      v_out := approve_channel_action(p_tenant_id, p_id, coalesce(p_event_key, 'email-card'), p_actor_user_id, null);
      perform set_config('zavi.email_card_approve', '', true);
      return v_out;
    end if;
    if p_rail = 'decisions' and c.o_status in ('approved', 'dispatching')
       and (c.o_body->>'chosen_variant')::int is not distinct from p_variant then
      return jsonb_build_object('ok', true, 'changed', false, 'status', c.o_status, 'class', c.o_class);
    end if;
    return jsonb_build_object('ok', false, 'code', 'not_open', 'status', c.o_status);
  end if;
  v_sha := public.email_card_test_sha(c.o_body, p_variant);
  if not exists (select 1 from email_test_sends t
                   join tenant_users tu on tu.tenant_id = t.tenant_id and tu.user_id = t.user_id
                  where t.tenant_id = p_tenant_id and t.rail = p_rail and t.card_id = p_id
                    and t.variant = p_variant and t.test_sha = v_sha and tu.role in ('owner', 'admin')) then
    return jsonb_build_object('ok', false, 'code', 'test_required');
  end if;
  if p_approved_count is null or p_approved_count < 1 then
    return jsonb_build_object('ok', false, 'code', 'count_required');
  end if;

  perform set_config('zavi.email_card_approve', 'on', true);
  if p_rail = 'channel_actions' then
    v_out := approve_channel_action(p_tenant_id, p_id, coalesce(p_event_key, 'email-card'), p_actor_user_id, null);
    if coalesce((v_out->>'ok')::boolean, false) then
      update channel_actions
         set exec_payload = exec_payload || jsonb_build_object('chosen_variant', p_variant, 'approved_count', p_approved_count)
       where id = p_id;
    end if;
  else
    update decisions
       set body        = body || jsonb_build_object('chosen_variant', p_variant, 'approved_count', p_approved_count),
           status      = 'approved',
           approved_by = p_actor_user_id,
           approved_at = now()
     where id = p_id and status = 'proposed';
    v_out := jsonb_build_object('ok', true, 'changed', true, 'status', 'approved', 'class', c.o_class);
  end if;
  perform set_config('zavi.email_card_approve', '', true);
  return v_out;
end $$;
revoke all on function public.approve_email_card(uuid, text, uuid, int, uuid, text, int) from public, anon, authenticated;
grant execute on function public.approve_email_card(uuid, text, uuid, int, uuid, text, int) to service_role;

drop function if exists approve_email_campaign_send_as_cgo(uuid, uuid, text, uuid);

create or replace function approve_email_campaign_send_as_cgo(
  p_tenant_id      uuid,
  p_action_id      uuid,
  p_event_key      text,
  p_actor_user_id  uuid,
  p_approved_count int default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row      channel_actions%rowtype;
  v_tool     text;
  v_audience text;
  v_out      jsonb;
  v_versions boolean;
begin
  if p_tenant_id is null or p_action_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into v_row from channel_actions where id = p_action_id;
  if not found or v_row.tenant_id is distinct from p_tenant_id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_row.exec_class is distinct from 'email_campaign.create_and_send' then
    return jsonb_build_object('ok', false, 'code', 'not_email_send');
  end if;
  v_tool     := nullif(trim(v_row.exec_payload->>'tool'), '');
  v_audience := nullif(trim(v_row.exec_payload->>'audience_id'), '');
  if v_tool is null or v_audience is null then
    return jsonb_build_object('ok', false, 'code', 'audience_unknown');
  end if;
  v_versions := public._email_card_versions(v_row.exec_payload) > 0;
  if v_versions and v_row.exec_status is null and (p_approved_count is null or p_approved_count < 1) then
    return jsonb_build_object('ok', false, 'code', 'count_required');
  end if;
  if v_versions and p_approved_count > 1000 then
    return jsonb_build_object('ok', false, 'code', 'audience_over_limit');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cgo_email_send:' || p_tenant_id::text || ':' || v_tool || ':' || v_audience, 0));

  if exists (
    select 1 from channel_actions c
     where c.tenant_id = p_tenant_id
       and c.id <> p_action_id
       and c.exec_class = 'email_campaign.create_and_send'
       and c.approved_by_source = 'cgo'
       and c.exec_payload->>'tool' = v_tool
       and c.exec_payload->>'audience_id' = v_audience
       and (c.exec_status = 'queued'
            or (c.exec_status = 'dispatching' and c.exec_claimed_at >= now() - interval '7 days')
            or (c.exec_status = 'executed' and c.executed_at >= now() - interval '7 days')
            or (c.exec_status = 'failed'
                and c.exec_progress->>'stage' in ('send_requested', 'sent')
                and c.exec_claimed_at >= now() - interval '7 days'))
  ) then
    return jsonb_build_object('ok', false, 'code', 'cgo_email_sent_recently');
  end if;

  perform set_config('zavi.email_card_approve', 'on', true);
  v_out := approve_channel_action(p_tenant_id, p_action_id, p_event_key, p_actor_user_id, 'cgo');
  perform set_config('zavi.email_card_approve', '', true);
  if v_versions and coalesce((v_out->>'ok')::boolean, false) and not coalesce((v_out->>'replayed')::boolean, false) then
    update channel_actions
       set exec_payload = exec_payload || jsonb_build_object('chosen_variant', 1, 'approved_count', p_approved_count)
     where id = p_action_id;
  end if;
  return v_out;
end $$;

revoke all on function approve_email_campaign_send_as_cgo(uuid, uuid, text, uuid, int)
  from public, anon, authenticated;
grant execute on function approve_email_campaign_send_as_cgo(uuid, uuid, text, uuid, int) to service_role;

commit;
