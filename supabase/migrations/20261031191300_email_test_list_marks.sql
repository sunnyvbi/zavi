
begin;

create or replace function public._email_test_list_key(p_class text, p_body jsonb)
returns text
language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_class = 'bulk_outbound.send' and nullif(trim(p_body->>'list_id'), '') is not null
      then 'zavi_list:' || lower(trim(p_body->>'list_id'))
    when p_class = 'email_campaign.create_and_send'
         and nullif(trim(p_body->>'tool'), '') is not null and nullif(trim(p_body->>'audience_id'), '') is not null
      then trim(p_body->>'tool') || ':' || trim(p_body->>'audience_id')
    else null end;
$$;
revoke all on function public._email_test_list_key(text, jsonb) from public, anon, authenticated;

create or replace function public._email_test_list_marked(p_tenant_id uuid, p_key text)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null or p_key is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('email_test_list:' || p_tenant_id::text || ':' || p_key, 0));
  return exists (
    select 1 from channel_settings
     where tenant_id = p_tenant_id and channel_slug = 'email_marketing' and field_id = 'email_test_lists'
       and item = p_key and status is distinct from 'dismissed');
end $$;
revoke all on function public._email_test_list_marked(uuid, text) from public, anon, authenticated;

create or replace function public.set_email_test_list(
  p_tenant_id uuid, p_actor_user_id uuid, p_key text, p_marked boolean
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_route text;
  v_id    text;
  v_n     int;
begin
  if p_tenant_id is null or p_actor_user_id is null or p_marked is null
     or p_key is null or p_key !~ '^(sendgrid|mailchimp|klaviyo|zavi_list):[A-Za-z0-9_-]{1,128}$' then
    return jsonb_build_object('ok', false, 'code', 'bad_list');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id
                    and role in ('owner', 'admin')) then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  v_route := split_part(p_key, ':', 1);
  v_id := substr(p_key, length(v_route) + 2);
  if v_route = 'zavi_list' then
    v_id := lower(v_id);
    if v_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return jsonb_build_object('ok', false, 'code', 'bad_list');
    end if;
    p_key := 'zavi_list:' || v_id;
    if p_marked and not exists (select 1 from email_lists where tenant_id = p_tenant_id and id = v_id::uuid and archived_at is null) then
      return jsonb_build_object('ok', false, 'code', 'list_not_found');
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('email_test_list:' || p_tenant_id::text || ':' || p_key, 0));
  if p_marked then
    if not exists (select 1 from tenant_channels where tenant_id = p_tenant_id and channel_slug = 'email_marketing') then
      return jsonb_build_object('ok', false, 'code', 'channel_missing');
    end if;
    insert into channel_settings (tenant_id, channel_slug, field_id, item, status, updated_by)
    values (p_tenant_id, 'email_marketing', 'email_test_lists', p_key, null, p_actor_user_id)
    on conflict (tenant_id, channel_slug, field_id, item) do update
      set status = null, updated_at = now(), updated_by = excluded.updated_by
      where channel_settings.status = 'dismissed';
    get diagnostics v_n = row_count;
  else
    delete from channel_settings
     where tenant_id = p_tenant_id and channel_slug = 'email_marketing' and field_id = 'email_test_lists' and item = p_key;
    get diagnostics v_n = row_count;
  end if;
  return jsonb_build_object('ok', true, 'changed', v_n > 0, 'marked', p_marked);
end $$;
revoke all on function public.set_email_test_list(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.set_email_test_list(uuid, uuid, text, boolean) to service_role;

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
  c        record;
  v_sha    text;
  v_out    jsonb;
  v_pre    record;
  v_key    text;
  v_marked boolean := false;
begin
  if p_tenant_id is null or p_id is null or p_actor_user_id is null or p_rail not in ('channel_actions', 'decisions') then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  select * into v_pre from public._email_card(p_tenant_id, p_rail, p_id, false);
  if not coalesce(v_pre.o_found, false) then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  v_key := public._email_test_list_key(v_pre.o_class, v_pre.o_body);
  v_marked := public._email_test_list_marked(p_tenant_id, v_key);
  select * into c from public._email_card(p_tenant_id, p_rail, p_id, true);
  if not c.o_found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if public._email_test_list_key(c.o_class, c.o_body) is distinct from v_key then
    return jsonb_build_object('ok', false, 'code', 'card_changed');
  end if;
  if public._email_card_versions(c.o_body) = 0 then
    return jsonb_build_object('ok', false, 'code', 'redraft_required');
  end if;
  if v_marked then
    return jsonb_build_object('ok', false, 'code', 'test_list');
  end if;
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_actor_user_id
                    and role in ('owner', 'admin')) then
    return jsonb_build_object('ok', false, 'code', 'not_authorized');
  end if;
  if p_variant is null or p_variant < 1 or p_variant > public._email_card_versions(c.o_body) then
    return jsonb_build_object('ok', false, 'code', 'bad_variant');
  end if;
  if not c.o_open then
    if not c.o_approved or (c.o_body->>'chosen_variant')::int is distinct from p_variant then
      return jsonb_build_object('ok', false, 'code', 'not_open', 'status', c.o_status);
    end if;
    if p_rail = 'channel_actions' then
      return public._email_card_retry(p_tenant_id, p_id, p_actor_user_id, p_event_key, p_approved_count);
    end if;
    if c.o_status in ('approved', 'dispatching') then
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
  if public._email_test_list_marked(p_tenant_id, v_tool || ':' || v_audience) then
    return jsonb_build_object('ok', false, 'code', 'test_list');
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
  if v_versions and coalesce((v_out->>'ok')::boolean, false) and not coalesce((v_out->>'replayed')::boolean, false) then
    update channel_actions
       set exec_payload = exec_payload || jsonb_build_object('chosen_variant', 1, 'approved_count', p_approved_count)
     where id = p_action_id;
  end if;
  perform set_config('zavi.email_card_approve', '', true);
  return v_out;
end $$;

revoke all on function approve_email_campaign_send_as_cgo(uuid, uuid, text, uuid, int)
  from public, anon, authenticated;
grant execute on function approve_email_campaign_send_as_cgo(uuid, uuid, text, uuid, int) to service_role;

commit;
