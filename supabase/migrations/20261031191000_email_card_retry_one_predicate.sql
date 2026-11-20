
begin;

create or replace function public._email_card_retry_refusal(
  p_status text, p_exec_status text, p_approved boolean, p_result jsonb
) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case
    when not coalesce(p_approved, false)
      or p_exec_status is distinct from 'failed'
      or coalesce(p_status, '') not in ('pending', 'snoozed') then 'not_open'
    when not public._email_card_retryable(p_result) then 'exec_partial_no_retry'
  end
$$;
revoke all on function public._email_card_retry_refusal(text, text, boolean, jsonb) from public, anon, authenticated;

create or replace function public._email_card_retry(
  p_tenant_id uuid, p_id uuid, p_actor_user_id uuid, p_event_key text, p_approved_count int
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row     channel_actions%rowtype;
  v_key     text := left(nullif(trim(coalesce(p_event_key, '')), ''), 200);
  v_attempt int;
  v_refusal text;
begin
  select * into v_row from channel_actions where id = p_id and tenant_id = p_tenant_id for update;
  if not found or v_row.approved_by is null then
    return jsonb_build_object('ok', false, 'code', 'not_open');
  end if;
  if v_key is null then return jsonb_build_object('ok', false, 'code', 'event_key_required'); end if;
  if exists (select 1 from channel_action_events where action_id = p_id and event_key = v_key) then
    select count(*) into v_attempt from channel_action_events where action_id = p_id and event = 'approved';
    return jsonb_build_object('ok', true, 'replayed', true, 'attempt', v_attempt, 'exec_status', v_row.exec_status);
  end if;
  if v_row.exec_status in ('queued', 'dispatching') then
    select count(*) into v_attempt from channel_action_events where action_id = p_id and event = 'approved';
    return jsonb_build_object('ok', true, 'replayed', true, 'queued', true, 'attempt', v_attempt, 'exec_status', v_row.exec_status);
  end if;
  v_refusal := public._email_card_retry_refusal(v_row.status, v_row.exec_status, v_row.approved_by is not null, v_row.exec_result);
  if v_refusal = 'not_open' then
    return jsonb_build_object('ok', false, 'code', v_refusal, 'status', coalesce(v_row.exec_status, v_row.status));
  elsif v_refusal is not null then
    return jsonb_build_object('ok', false, 'code', v_refusal);
  end if;
  if p_approved_count is null or p_approved_count < 1 then
    return jsonb_build_object('ok', false, 'code', 'count_required');
  end if;
  perform set_config('zavi.email_card_approve', 'on', true);
  update channel_actions
     set exec_status     = 'queued',
         exec_result     = null,
         exec_claim_id   = null,
         exec_claimed_at = null,
         exec_payload    = exec_payload || jsonb_build_object('approved_count', p_approved_count)
   where id = p_id;
  insert into channel_action_events (tenant_id, action_id, event, actor_kind, actor_user_id, event_key)
  values (p_tenant_id, p_id, 'approved', 'founder', p_actor_user_id, v_key);
  perform set_config('zavi.email_card_approve', '', true);
  select count(*) into v_attempt from channel_action_events where action_id = p_id and event = 'approved';
  return jsonb_build_object('ok', true, 'replayed', false, 'attempt', v_attempt, 'exec_class', v_row.exec_class);
end $$;
revoke all on function public._email_card_retry(uuid, uuid, uuid, text, int) from public, anon, authenticated;

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
  v_retryable boolean := false;
  v_ca channel_actions%rowtype;
begin
  select role into v_role from tenant_users where tenant_id = p_tenant_id and user_id = p_user_id;
  if v_role is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  select * into c from public._email_card(p_tenant_id, p_rail, p_id, false);
  if not c.o_found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  v_n := public._email_card_versions(c.o_body);
  if p_rail = 'channel_actions' then
    select * into v_ca from channel_actions where id = p_id and tenant_id = p_tenant_id;
    v_retryable := found and public._email_card_retry_refusal(v_ca.status, v_ca.exec_status, v_ca.approved_by is not null, v_ca.exec_result) is null;
  end if;
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
                            'status', c.o_status, 'role', v_role, 'versions', v_n, 'tests', v_tests,
                            'retryable', v_retryable,
                            'failure_reason', case when c.o_status = 'failed' then left(c.o_exec_result->>'error', 500) end);
end $$;
revoke all on function public.email_card_view_state(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.email_card_view_state(uuid, text, uuid, uuid) to service_role;

commit;
