
CREATE OR REPLACE FUNCTION public._owned_clarify_request(p_request_id uuid)
 RETURNS TABLE(thread_id uuid, tenant_id uuid, agent_slug text, envelope jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
  end if;
  if not exists (select 1 from tenant_users
                 where user_id = v_user_id and tenant_id = v_tenant_id) then
    raise exception 'not a member of tenant' using errcode = '42501';
  end if;

  return query
    select t.id, t.tenant_id, t.agent_slug,
           (m.meta->'envelope')
    from agent_thread_messages m
    join agent_threads t on t.id = m.thread_id
    where m.sender_role = 'assistant'
      and m.meta->'envelope'->>'request_id' = p_request_id::text
      and m.meta->'envelope'->>'envelope_kind' = 'clarifying_questions'
      and t.tenant_id = v_tenant_id
      and t.user_id = v_user_id
    limit 1;

  if not found then
    raise exception 'clarification request not found or not owned' using errcode = '42501';
  end if;
end $function$
;

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
  if v_role = 'member' and not exists (
    select 1 from tenant_member_agents
     where tenant_id = v_tenant_id and user_id = v_user_id and agent_slug = v_slug
  ) then
    raise exception 'agent % not in member allowlist', v_slug using errcode = '42501';
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
