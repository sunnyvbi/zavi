
set lock_timeout = '5s';

alter table tenant_users drop constraint if exists tenant_users_role_check;
alter table tenant_users
  add constraint tenant_users_role_check
  check (role in ('owner','admin','member','viewer'));

do $$
declare v_con text;
begin
  for v_con in
    select c.conname from pg_constraint c
     where c.conrelid = 'public.tenant_member_invites'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ilike '%role%'
  loop
    execute format('alter table tenant_member_invites drop constraint %I', v_con);
  end loop;
end $$;
alter table tenant_member_invites
  add constraint tenant_member_invites_role_check
  check (role in ('admin','member','viewer'));

drop policy if exists agent_runs_member_select on agent_runs;
create policy agent_runs_member_select on agent_runs for select using (
  exists (
    select 1 from tenant_users tu
     where tu.user_id = auth.uid()
       and tu.tenant_id = agent_runs.tenant_id
  )
);

drop policy if exists agent_run_events_member_select on agent_run_events;
create policy agent_run_events_member_select on agent_run_events for select using (
  exists (
    select 1 from tenant_users tu
     where tu.user_id = auth.uid()
       and tu.tenant_id = agent_run_events.tenant_id
  )
);

drop policy if exists decisions_member_select on decisions;
create policy decisions_member_select on decisions for select using (
  exists (
    select 1 from tenant_users tu
     where tu.user_id = auth.uid()
       and tu.tenant_id = decisions.tenant_id
  )
);

drop policy if exists test_cases_member_insert on public.test_cases;
create policy test_cases_member_insert on public.test_cases
  for insert with check (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = test_cases.tenant_id
        and tu.role <> 'viewer'
    )
  );

drop policy if exists test_cases_member_update on public.test_cases;
create policy test_cases_member_update on public.test_cases
  for update using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = test_cases.tenant_id
        and tu.role <> 'viewer'
    )
  )
  with check (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = test_cases.tenant_id
        and tu.role <> 'viewer'
    )
  );

create or replace function _custom_agent_authorize(p_tenant_id uuid)
returns void language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null then
    raise exception 'tenant required' using errcode = '22023';
  end if;
  if auth.role() is not distinct from 'service_role' then
    return;
  end if;
  if auth.uid() is null or not exists (
    select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
  end if;
  if exists (
    select 1 from tenant_users
     where user_id = auth.uid() and tenant_id = p_tenant_id and role = 'viewer'
  ) then
    raise exception 'viewer role is read-only' using errcode = '42501';
  end if;
end $$;
revoke all on function _custom_agent_authorize(uuid) from public, anon, authenticated;

create or replace function send_agent_chat_turn(
  p_agent_slug text,
  p_agent_hash text,
  p_message text,
  p_thread_id uuid default null
) returns table (thread_id uuid, user_message_id uuid, run_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_role text;
  v_thread_id uuid;
  v_user_message_id uuid;
  v_run_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;

  select role into v_role from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id;
  if v_role is null then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  if v_role = 'viewer' then
    raise exception 'viewer role is read-only' using errcode = '42501';
  end if;

  if length(coalesce(p_message, '')) = 0 or length(p_message) > 32000 then
    raise exception 'message length out of bounds' using errcode = '22023';
  end if;

  if p_thread_id is null then
    insert into agent_threads (tenant_id, agent_slug, user_id, title)
    values (v_tenant_id, p_agent_slug, v_user_id, left(p_message, 80))
    returning id into v_thread_id;
  else
    select id into v_thread_id from agent_threads
      where id = p_thread_id
        and tenant_id = v_tenant_id
        and agent_slug = p_agent_slug
        and user_id = v_user_id;
    if v_thread_id is null then
      raise exception 'thread not found or not owned' using errcode = '42501';
    end if;
    update agent_threads set last_message_at = now() where id = v_thread_id;
  end if;

  insert into agent_runs
    (tenant_id, agent_slug, agent_definition_hash, trigger, status, enqueued_by, payload)
  values
    (v_tenant_id, p_agent_slug, p_agent_hash, 'chat', 'queued', v_user_id,
     jsonb_build_object('thread_id', v_thread_id))
  returning id into v_run_id;

  insert into agent_thread_messages
    (thread_id, tenant_id, sender_role, body, agent_run_id)
  values
    (v_thread_id, v_tenant_id, 'user', p_message, v_run_id)
  returning id into v_user_message_id;

  update agent_runs
    set payload = jsonb_build_object(
      'thread_id', v_thread_id,
      'user_message_id', v_user_message_id
    )
    where id = v_run_id;

  return query select v_thread_id, v_user_message_id, v_run_id;
end $$;
revoke all on function send_agent_chat_turn(text, text, text, uuid) from public, anon, authenticated;
grant execute on function send_agent_chat_turn(text, text, text, uuid) to authenticated;

create or replace function send_agent_chat_turn_v2(
  p_agent_slug text,
  p_agent_hash text,
  p_message text,
  p_thread_id uuid,
  p_image_paths text[]
) returns table (thread_id uuid, user_message_id uuid, run_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_role text;
  v_thread_id uuid;
  v_user_message_id uuid;
  v_run_id uuid;
  v_path text;
  v_attachments jsonb;
  v_path_regex text;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;

  select role into v_role from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id;
  if v_role is null then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  if v_role = 'viewer' then
    raise exception 'viewer role is read-only' using errcode = '42501';
  end if;

  if (coalesce(p_message, '') = '' and coalesce(array_length(p_image_paths, 1), 0) = 0)
     or length(coalesce(p_message, '')) > 32000 then
    raise exception 'message length out of bounds' using errcode = '22023';
  end if;

  if coalesce(array_length(p_image_paths, 1), 0) > 4 then
    raise exception 'too many images (max 4)' using errcode = '22023';
  end if;

  v_path_regex := '^' || v_tenant_id::text || '/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$';
  if p_image_paths is not null then
    foreach v_path in array p_image_paths loop
      if v_path !~ v_path_regex then
        raise exception 'image path % does not belong to tenant', v_path using errcode = '42501';
      end if;
    end loop;
  end if;

  if p_thread_id is null then
    insert into agent_threads (tenant_id, agent_slug, user_id, title)
    values (v_tenant_id, p_agent_slug, v_user_id,
            left(coalesce(nullif(p_message, ''), 'image attached'), 80))
    returning id into v_thread_id;
  else
    select id into v_thread_id from agent_threads
      where id = p_thread_id
        and tenant_id = v_tenant_id
        and agent_slug = p_agent_slug
        and user_id = v_user_id;
    if v_thread_id is null then
      raise exception 'thread not found or not owned' using errcode = '42501';
    end if;
    update agent_threads set last_message_at = now() where id = v_thread_id;
  end if;

  if p_image_paths is not null and array_length(p_image_paths, 1) > 0 then
    select jsonb_agg(jsonb_build_object('path', p))
      into v_attachments
      from unnest(p_image_paths) as p;
  else
    v_attachments := null;
  end if;

  insert into agent_runs
    (tenant_id, agent_slug, agent_definition_hash, trigger, status, enqueued_by, payload)
  values
    (v_tenant_id, p_agent_slug, p_agent_hash, 'chat', 'queued', v_user_id,
     jsonb_build_object('thread_id', v_thread_id,
                        'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb)))
  returning id into v_run_id;

  insert into agent_thread_messages
    (thread_id, tenant_id, sender_role, body, agent_run_id, attachments)
  values
    (v_thread_id, v_tenant_id, 'user', coalesce(p_message, ''), v_run_id, v_attachments)
  returning id into v_user_message_id;

  update agent_runs
    set payload = jsonb_build_object(
      'thread_id', v_thread_id,
      'user_message_id', v_user_message_id,
      'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb)
    )
    where id = v_run_id;

  return query select v_thread_id, v_user_message_id, v_run_id;
end $$;
revoke all on function send_agent_chat_turn_v2(text, text, text, uuid, text[]) from public, anon, authenticated;
grant execute on function send_agent_chat_turn_v2(text, text, text, uuid, text[]) to authenticated;

create or replace function send_agent_chat_turn_v3(
  p_agent_slug text,
  p_agent_hash text,
  p_message text,
  p_thread_id uuid,
  p_image_paths text[],
  p_doc_paths text[]
) returns table (thread_id uuid, user_message_id uuid, run_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_role text;
  v_thread_id uuid;
  v_user_message_id uuid;
  v_run_id uuid;
  v_path text;
  v_image_attachments jsonb;
  v_doc_attachments jsonb;
  v_attachments jsonb;
  v_img_regex text;
  v_doc_regex text;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;

  select role into v_role from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id;
  if v_role is null then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  if v_role = 'viewer' then
    raise exception 'viewer role is read-only' using errcode = '42501';
  end if;

  if (coalesce(p_message, '') = ''
      and coalesce(array_length(p_image_paths, 1), 0) = 0
      and coalesce(array_length(p_doc_paths, 1), 0) = 0)
     or length(coalesce(p_message, '')) > 32000 then
    raise exception 'message length out of bounds' using errcode = '22023';
  end if;

  if coalesce(array_length(p_image_paths, 1), 0) > 4 then
    raise exception 'too many images (max 4)' using errcode = '22023';
  end if;
  if coalesce(array_length(p_doc_paths, 1), 0) > 4 then
    raise exception 'too many docs (max 4)' using errcode = '22023';
  end if;

  v_img_regex := '^' || v_tenant_id::text || '/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$';
  if p_image_paths is not null then
    foreach v_path in array p_image_paths loop
      if v_path !~ v_img_regex then
        raise exception 'image path % does not belong to tenant', v_path using errcode = '42501';
      end if;
    end loop;
  end if;

  v_doc_regex := '^' || v_tenant_id::text || '/[0-9a-f-]{36}\.(pdf|docx|csv|txt)$';
  if p_doc_paths is not null then
    foreach v_path in array p_doc_paths loop
      if v_path !~ v_doc_regex then
        raise exception 'doc path % does not belong to tenant', v_path using errcode = '42501';
      end if;
    end loop;
  end if;

  if p_thread_id is null then
    insert into agent_threads (tenant_id, agent_slug, user_id, title)
    values (v_tenant_id, p_agent_slug, v_user_id,
            left(coalesce(nullif(p_message, ''), 'attachment'), 80))
    returning id into v_thread_id;
  else
    select id into v_thread_id from agent_threads
      where id = p_thread_id
        and tenant_id = v_tenant_id
        and agent_slug = p_agent_slug
        and user_id = v_user_id
        and deleted_at is null;
    if v_thread_id is null then
      raise exception 'thread not found or not owned' using errcode = '42501';
    end if;
    update agent_threads set last_message_at = now() where id = v_thread_id;
  end if;

  if p_image_paths is not null and array_length(p_image_paths, 1) > 0 then
    select jsonb_agg(jsonb_build_object('path', p, 'kind', 'image'))
      into v_image_attachments from unnest(p_image_paths) as p;
  else
    v_image_attachments := '[]'::jsonb;
  end if;
  if p_doc_paths is not null and array_length(p_doc_paths, 1) > 0 then
    select jsonb_agg(jsonb_build_object('path', p, 'kind', 'doc'))
      into v_doc_attachments from unnest(p_doc_paths) as p;
  else
    v_doc_attachments := '[]'::jsonb;
  end if;
  v_attachments := v_image_attachments || v_doc_attachments;
  if jsonb_array_length(v_attachments) = 0 then
    v_attachments := null;
  end if;

  insert into agent_runs
    (tenant_id, agent_slug, agent_definition_hash, trigger, status, enqueued_by, payload)
  values
    (v_tenant_id, p_agent_slug, p_agent_hash, 'chat', 'queued', v_user_id,
     jsonb_build_object('thread_id', v_thread_id,
                        'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb),
                        'doc_paths', coalesce(to_jsonb(p_doc_paths), 'null'::jsonb)))
  returning id into v_run_id;

  insert into agent_thread_messages
    (thread_id, tenant_id, sender_role, body, agent_run_id, attachments)
  values
    (v_thread_id, v_tenant_id, 'user', coalesce(p_message, ''), v_run_id, v_attachments)
  returning id into v_user_message_id;

  update agent_runs
    set payload = jsonb_build_object(
      'thread_id', v_thread_id,
      'user_message_id', v_user_message_id,
      'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb),
      'doc_paths', coalesce(to_jsonb(p_doc_paths), 'null'::jsonb)
    )
    where id = v_run_id;

  return query select v_thread_id, v_user_message_id, v_run_id;
end $$;
revoke all on function send_agent_chat_turn_v3(text, text, text, uuid, text[], text[]) from public, anon, authenticated;
grant execute on function send_agent_chat_turn_v3(text, text, text, uuid, text[], text[]) to authenticated;

create or replace function send_agent_chat_turn_v3(
  p_agent_slug text,
  p_agent_hash text,
  p_message text,
  p_thread_id uuid,
  p_image_paths text[],
  p_doc_paths text[],
  p_tenant_id uuid
) returns table (thread_id uuid, user_message_id uuid, run_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_role text;
  v_thread_id uuid;
  v_user_message_id uuid;
  v_run_id uuid;
  v_path text;
  v_image_attachments jsonb;
  v_doc_attachments jsonb;
  v_attachments jsonb;
  v_img_regex text;
  v_doc_regex text;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select app_active_tenant() into v_tenant_id;
  if p_tenant_id is not null then
    v_tenant_id := p_tenant_id;
  end if;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;

  select role into v_role from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id;
  if v_role is null then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  if v_role = 'viewer' then
    raise exception 'viewer role is read-only' using errcode = '42501';
  end if;

  if (coalesce(p_message, '') = ''
      and coalesce(array_length(p_image_paths, 1), 0) = 0
      and coalesce(array_length(p_doc_paths, 1), 0) = 0)
     or length(coalesce(p_message, '')) > 32000 then
    raise exception 'message length out of bounds' using errcode = '22023';
  end if;

  if coalesce(array_length(p_image_paths, 1), 0) > 4 then
    raise exception 'too many images (max 4)' using errcode = '22023';
  end if;
  if coalesce(array_length(p_doc_paths, 1), 0) > 4 then
    raise exception 'too many docs (max 4)' using errcode = '22023';
  end if;

  v_img_regex := '^' || v_tenant_id::text || '/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$';
  if p_image_paths is not null then
    foreach v_path in array p_image_paths loop
      if v_path !~ v_img_regex then
        raise exception 'image path % does not belong to tenant', v_path using errcode = '42501';
      end if;
    end loop;
  end if;

  v_doc_regex := '^' || v_tenant_id::text || '/[0-9a-f-]{36}\.(pdf|docx|csv|txt)$';
  if p_doc_paths is not null then
    foreach v_path in array p_doc_paths loop
      if v_path !~ v_doc_regex then
        raise exception 'doc path % does not belong to tenant', v_path using errcode = '42501';
      end if;
    end loop;
  end if;

  if p_thread_id is null then
    insert into agent_threads (tenant_id, agent_slug, user_id, title)
    values (v_tenant_id, p_agent_slug, v_user_id,
            left(coalesce(nullif(p_message, ''), 'attachment'), 80))
    returning id into v_thread_id;
  else
    select id into v_thread_id from agent_threads
      where id = p_thread_id
        and tenant_id = v_tenant_id
        and agent_slug = p_agent_slug
        and user_id = v_user_id
        and deleted_at is null;
    if v_thread_id is null then
      raise exception 'thread not found or not owned' using errcode = '42501';
    end if;
    update agent_threads set last_message_at = now() where id = v_thread_id;
  end if;

  if p_image_paths is not null and array_length(p_image_paths, 1) > 0 then
    select jsonb_agg(jsonb_build_object('path', p, 'kind', 'image'))
      into v_image_attachments from unnest(p_image_paths) as p;
  else
    v_image_attachments := '[]'::jsonb;
  end if;
  if p_doc_paths is not null and array_length(p_doc_paths, 1) > 0 then
    select jsonb_agg(jsonb_build_object('path', p, 'kind', 'doc'))
      into v_doc_attachments from unnest(p_doc_paths) as p;
  else
    v_doc_attachments := '[]'::jsonb;
  end if;
  v_attachments := v_image_attachments || v_doc_attachments;
  if jsonb_array_length(v_attachments) = 0 then
    v_attachments := null;
  end if;

  insert into agent_runs
    (tenant_id, agent_slug, agent_definition_hash, trigger, status, enqueued_by, payload)
  values
    (v_tenant_id, p_agent_slug, p_agent_hash, 'chat', 'queued', v_user_id,
     jsonb_build_object('thread_id', v_thread_id,
                        'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb),
                        'doc_paths', coalesce(to_jsonb(p_doc_paths), 'null'::jsonb)))
  returning id into v_run_id;

  insert into agent_thread_messages
    (thread_id, tenant_id, sender_role, body, agent_run_id, attachments)
  values
    (v_thread_id, v_tenant_id, 'user', coalesce(p_message, ''), v_run_id, v_attachments)
  returning id into v_user_message_id;

  update agent_runs
    set payload = jsonb_build_object(
      'thread_id', v_thread_id,
      'user_message_id', v_user_message_id,
      'image_paths', coalesce(to_jsonb(p_image_paths), 'null'::jsonb),
      'doc_paths', coalesce(to_jsonb(p_doc_paths), 'null'::jsonb)
    )
    where id = v_run_id;

  return query select v_thread_id, v_user_message_id, v_run_id;
end $$;
revoke all on function send_agent_chat_turn_v3(text, text, text, uuid, text[], text[], uuid) from public, anon, authenticated;
grant execute on function send_agent_chat_turn_v3(text, text, text, uuid, text[], text[], uuid) to authenticated;

CREATE OR REPLACE FUNCTION public.submit_clarification_response(p_request_id uuid, p_agent_hash text, p_answers jsonb)
 RETURNS TABLE(run_id uuid, agent_slug text, thread_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
declare
  v_user_id uuid := auth.uid();
  v_ctx record;
  v_tenant_id uuid;
  v_role text;
  v_slug text;
  v_thread_id uuid;
  v_resp agent_clarification_responses;
  v_run_id uuid;
  v_user_message_id uuid;
  v_body text;
  v_resolved jsonb;
begin
  select * into v_ctx from _owned_clarify_request(p_request_id);
  v_tenant_id := v_ctx.tenant_id;
  v_slug := v_ctx.agent_slug;
  v_thread_id := v_ctx.thread_id;

  select role into v_role from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id;
  if v_role is null then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;
  if v_role = 'viewer' then
    raise exception 'viewer role is read-only' using errcode = '42501';
  end if;

  perform _validate_clarify_answers(v_ctx.envelope, p_answers);
  v_resolved := _resolve_clarify_pairs(v_ctx.envelope, p_answers);

  insert into agent_clarification_responses (request_id, thread_id, tenant_id, user_id, draft_answers)
  values (p_request_id, v_thread_id, v_tenant_id, v_user_id, '{}'::jsonb)
  on conflict (tenant_id, request_id, user_id) do nothing;

  select * into v_resp from agent_clarification_responses
    where tenant_id = v_tenant_id and request_id = p_request_id and user_id = v_user_id
    for update;

  if v_resp.status = 'consumed' then
    raise exception 'clarification already consumed' using errcode = '22023';
  end if;
  if v_resp.consuming_run_id is not null and exists (
    select 1 from agent_runs r
     where r.id = v_resp.consuming_run_id
       and r.status in ('queued','running','blocked')
  ) then
    raise exception 'a submission for this request is already in progress' using errcode = '22023';
  end if;

  v_body := 'Answered the clarifying questions.';
  insert into agent_runs
    (tenant_id, agent_slug, agent_definition_hash, trigger, status, enqueued_by, payload)
  values
    (v_tenant_id, v_slug, p_agent_hash, 'chat', 'queued', v_user_id,
     jsonb_build_object('thread_id', v_thread_id))
  returning id into v_run_id;

  insert into agent_thread_messages
    (thread_id, tenant_id, sender_role, body, agent_run_id, meta)
  values
    (v_thread_id, v_tenant_id, 'user', v_body, v_run_id,
     jsonb_build_object('clarification_response',
        jsonb_build_object('request_id', p_request_id, 'answers', p_answers,
          'resolved', v_resolved)))
  returning id into v_user_message_id;

  update agent_runs set payload = jsonb_build_object(
      'thread_id', v_thread_id,
      'user_message_id', v_user_message_id,
      'prior_run_id', (select agent_run_id from agent_thread_messages
                       where tenant_id = v_tenant_id and thread_id = v_thread_id
                         and sender_role = 'assistant'
                         and meta->'envelope'->>'request_id' = p_request_id::text
                         and meta->'envelope'->>'envelope_kind' = 'clarifying_questions' limit 1),
      'clarification_response', jsonb_build_object('request_id', p_request_id, 'answers', p_answers,
        'resolved', v_resolved)
    ) where id = v_run_id;

  update agent_clarification_responses
    set submitted_answers = p_answers, status = 'submitted',
        consuming_run_id = v_run_id, updated_at = now()
    where id = v_resp.id;

  update agent_threads set last_message_at = now() where id = v_thread_id;

  return query select v_run_id, v_slug, v_thread_id;
end $function$
;
revoke all on function submit_clarification_response(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function submit_clarification_response(uuid, text, jsonb) to authenticated;

create or replace function add_agent_note(
  p_agent_slug text,
  p_body text,
  p_scope jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_id uuid;
begin
  if v_user_id is null then
    raise exception 'unauthenticated';
  end if;
  if p_agent_slug is null or length(p_agent_slug) = 0 then
    raise exception 'agent_slug required';
  end if;
  if p_body is null or length(p_body) = 0 then
    raise exception 'body required';
  end if;
  if length(p_body) > 4000 then
    raise exception 'note body too long (≤4000 chars)';
  end if;

  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id
  ) then
    raise exception 'not a member of tenant';
  end if;
  if exists (
    select 1 from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id and role = 'viewer'
  ) then
    raise exception 'viewer role is read-only' using errcode = '42501';
  end if;

  insert into agent_feedback (
    tenant_id, target_type, target_id, agent_slug, rating, comment,
    created_by, kind, state, scope
  ) values (
    v_tenant_id, null, null, p_agent_slug, null, p_body,
    v_user_id, 'note', 'open', p_scope
  )
  returning id into v_id;

  return v_id;
end;
$$;
revoke all on function add_agent_note(text, text, jsonb) from public, anon, authenticated;
grant execute on function add_agent_note(text, text, jsonb) to authenticated;

create or replace function add_agent_rule(
  p_agent_slug text,
  p_body text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_id uuid;
begin
  if v_user_id is null then
    raise exception 'unauthenticated';
  end if;
  if p_agent_slug is null or length(p_agent_slug) = 0 then
    raise exception 'agent_slug required';
  end if;
  if p_body is null or length(p_body) = 0 then
    raise exception 'body required';
  end if;
  if length(p_body) > 500 then
    raise exception 'rule body too long (≤500 chars)';
  end if;

  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id
  ) then
    raise exception 'not a member of tenant';
  end if;
  if exists (
    select 1 from tenant_users
    where user_id = v_user_id and tenant_id = v_tenant_id and role = 'viewer'
  ) then
    raise exception 'viewer role is read-only' using errcode = '42501';
  end if;

  insert into agent_feedback (
    tenant_id, target_type, target_id, agent_slug, rating, comment,
    created_by, kind, state, scope
  ) values (
    v_tenant_id, null, null, p_agent_slug, null, p_body,
    v_user_id, 'rule', 'open', null
  )
  returning id into v_id;

  return v_id;
end;
$$;
revoke all on function add_agent_rule(text, text) from public, anon, authenticated;
grant execute on function add_agent_rule(text, text) to authenticated;

create or replace function invite_member(
  p_email text,
  p_role text,
  p_agent_slugs text[]
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_email_normalized text;
  v_existing_seats int;
  v_open_invites int;
  v_max int;
  v_tier text;
  v_invite_id uuid;
  v_slugs text[];
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select app_active_tenant() into v_tenant;
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  perform _assert_tenant_admin(v_tenant);

  if p_role is null or p_role not in ('admin','member','viewer') then
    raise exception 'invalid role %; must be admin, member or viewer', p_role using errcode = '22023';
  end if;

  v_email_normalized := lower(trim(coalesce(p_email, '')));
  if v_email_normalized = '' then
    raise exception 'email required' using errcode = '22023';
  end if;

  v_slugs := array[]::text[];

  select tier into v_tier from tenants where id = v_tenant;
  select max_seats into v_max from tenant_seat_limits where tier = coalesce(v_tier, 'pilot');
  if v_max is null then
    raise exception 'no seat limit defined for tier %', v_tier using errcode = '22023';
  end if;
  if v_max >= 0 then
    select count(*) into v_existing_seats from tenant_users where tenant_id = v_tenant;
    select count(*) into v_open_invites from tenant_member_invites
      where tenant_id = v_tenant
        and accepted_at is null
        and revoked_at is null;
    if (v_existing_seats + v_open_invites) >= v_max then
      raise exception 'seat_cap_exceeded — tier % allows % seats (%/% used)',
        v_tier, v_max, v_existing_seats + v_open_invites, v_max
        using errcode = '42501';
    end if;
  end if;

  insert into tenant_member_invites (tenant_id, email, role, invited_by, agent_slugs)
  values (v_tenant, v_email_normalized, p_role, auth.uid(), v_slugs)
  on conflict (tenant_id, lower(email))
    where accepted_at is null and revoked_at is null
  do update set
    role         = excluded.role,
    invited_by   = excluded.invited_by,
    agent_slugs  = excluded.agent_slugs,
    invited_at   = now()
  returning id into v_invite_id;

  return v_invite_id;
end $$;
revoke all on function invite_member(text, text, text[]) from public, anon, authenticated;
grant execute on function invite_member(text, text, text[]) to authenticated;

create or replace function set_member_role(p_user_id uuid, p_role text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_caller_role text;
  v_target_role text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select app_active_tenant() into v_tenant;
  if v_tenant is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  select role into v_caller_role from tenant_users
    where tenant_id = v_tenant and user_id = auth.uid();
  if v_caller_role is null then
    raise exception 'not a member of tenant %', v_tenant using errcode = '42501';
  end if;
  if v_caller_role <> 'owner' then
    raise exception 'only owner can change roles' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('admin','member','viewer') then
    raise exception 'invalid role %; must be admin, member or viewer', p_role using errcode = '22023';
  end if;

  select role into v_target_role from tenant_users
    where tenant_id = v_tenant and user_id = p_user_id;
  if v_target_role is null then
    raise exception 'target user is not a member' using errcode = '42704';
  end if;
  if v_target_role = 'owner' then
    raise exception 'cannot change the owner''s role; transfer ownership instead' using errcode = '22023';
  end if;
  if v_target_role = p_role then
    return;
  end if;

  update tenant_users
     set role = p_role
   where tenant_id = v_tenant and user_id = p_user_id;
end $$;
revoke all on function set_member_role(uuid, text) from public, anon, authenticated;
grant execute on function set_member_role(uuid, text) to authenticated;

create or replace function is_tenant_member_email(p_tenant_id uuid, p_email text)
returns boolean
language sql stable security definer set search_path = public, auth, pg_temp as $$
  select exists (
    select 1
    from tenant_users tu
    join auth.users u on u.id = tu.user_id
    where tu.tenant_id = p_tenant_id
      and tu.role <> 'viewer'
      and coalesce(btrim(p_email), '') <> ''
      and lower(u.email) = lower(btrim(p_email))
  );
$$;
revoke all on function is_tenant_member_email(uuid, text) from public, anon, authenticated;
grant execute on function is_tenant_member_email(uuid, text) to service_role;

create or replace function _refuse_viewer_write() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_tenant uuid;
begin
  if v_uid is null then
    return coalesce(new, old);
  end if;
  v_tenant := case when tg_op = 'DELETE' then old.tenant_id else new.tenant_id end;
  if exists (
    select 1 from tenant_users
     where user_id = v_uid and tenant_id = v_tenant and role = 'viewer'
  ) then
    raise exception 'viewer role is read-only' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
revoke all on function _refuse_viewer_write() from public, anon, authenticated;

do $$
declare v_t text;
begin
  foreach v_t in array array[
    'agent_runs', 'agent_threads', 'agent_thread_messages', 'agent_run_steers',
    'agent_work_items', 'tenant_decision_class_overrides', 'tenant_agent_schedules',
    'autopilot_goals', 'agent_email_recipients', 'agent_feedback',
    'agent_clarification_responses', 'tenant_build_credits',
    'tenant_ad_snapshots'
  ] loop
    execute format('drop trigger if exists %I on public.%I', 'zz_refuse_viewer_write', v_t);
    execute format(
      'create trigger %I before insert or update or delete on public.%I
         for each row execute function _refuse_viewer_write()',
      'zz_refuse_viewer_write', v_t);
  end loop;
end $$;
