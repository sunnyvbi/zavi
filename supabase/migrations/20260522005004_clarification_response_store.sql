
create table if not exists agent_clarification_responses (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  thread_id uuid not null references agent_threads(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null,
  consuming_run_id uuid references agent_runs(id) on delete set null,
  draft_answers jsonb not null default '{}'::jsonb,
  submitted_answers jsonb,
  status text not null default 'draft' check (status in ('draft','submitted','consumed')),
  schema_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists agent_clarification_responses_uq
  on agent_clarification_responses (tenant_id, request_id, user_id);
create index if not exists agent_clarification_responses_thread
  on agent_clarification_responses (tenant_id, thread_id, updated_at desc);

create index if not exists agent_thread_messages_clarify_request
  on agent_thread_messages ((meta->'envelope'->>'request_id'))
  where sender_role = 'assistant';

alter table agent_clarification_responses enable row level security;

create policy agent_clarification_responses_member_select on agent_clarification_responses
  for select using (
    exists (
      select 1 from agent_threads t
      join tenant_users tu on tu.tenant_id = t.tenant_id and tu.user_id = auth.uid()
      where t.id = agent_clarification_responses.thread_id
        and t.user_id = auth.uid()
    )
  );

create or replace function _owned_clarify_request(p_request_id uuid)
returns table (thread_id uuid, tenant_id uuid, agent_slug text, envelope jsonb)
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select active_tenant_id into v_tenant_id from profiles where user_id = v_user_id;
  if v_tenant_id is null then
    raise exception 'no active tenant' using errcode = '42501';
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
end $$;

create or replace function _validate_clarify_answers(p_envelope jsonb, p_answers jsonb)
returns void
language plpgsql immutable as $$
declare
  v_ans jsonb;
  v_q jsonb;
  v_qid text;
  v_seen text[] := '{}';
  v_opt_ids text[];
  v_declared_ids text[];
  v_other text;
  v_skipped boolean;
  v_type text;
  v_allow_other boolean;
  v_allow_skip boolean;
  v_required boolean;
  v_max_len int;
begin
  if jsonb_typeof(p_answers) <> 'array' then
    raise exception 'answers must be an array' using errcode = '22023';
  end if;
  if jsonb_typeof(p_envelope->'questions') <> 'array' then
    raise exception 'envelope has no questions array' using errcode = '22023';
  end if;

  for v_ans in select * from jsonb_array_elements(p_answers) loop
    v_qid := v_ans->>'question_id';
    if v_qid is null then
      raise exception 'answer missing question_id' using errcode = '22023';
    end if;
    if v_qid = any (v_seen) then
      raise exception 'duplicate question_id %', v_qid using errcode = '22023';
    end if;
    v_seen := array_append(v_seen, v_qid);

    select elem into v_q
    from jsonb_array_elements(p_envelope->'questions') as t(elem)
    where elem->>'id' = v_qid
    limit 1;
    if v_q is null then
      raise exception 'unknown question_id %', v_qid using errcode = '22023';
    end if;

    v_type := v_q->>'type';
    v_allow_other := coalesce((v_q->>'allow_other')::boolean, false);
    v_allow_skip := coalesce((v_q->>'allow_skip')::boolean, false);
    v_required := coalesce((v_q->>'required')::boolean, false);
    v_max_len := coalesce((v_q->>'max_length')::int, 8000);
    v_skipped := coalesce((v_ans->>'skipped')::boolean, false);
    v_other := nullif(btrim(v_ans->>'other_text'), '');

    if v_skipped then
      if v_required then
        raise exception 'question % is required, cannot skip', v_qid using errcode = '22023';
      end if;
      if not v_allow_skip then
        raise exception 'question % does not allow skip', v_qid using errcode = '22023';
      end if;
      if (v_ans ? 'option_ids'
            and v_ans->'option_ids' <> '[]'::jsonb
            and v_ans->'option_ids' <> 'null'::jsonb)
         or v_other is not null then
        raise exception 'skipped question % must not carry option_ids/other_text', v_qid using errcode = '22023';
      end if;
      continue;
    end if;

    if v_ans ? 'option_ids' and jsonb_typeof(v_ans->'option_ids') <> 'array' then
      raise exception 'option_ids must be an array for %', v_qid using errcode = '22023';
    end if;
    select coalesce(array_agg(val), '{}') into v_opt_ids
    from jsonb_array_elements_text(coalesce(v_ans->'option_ids', '[]'::jsonb)) as t(val);

    if v_type = 'text' then
      if array_length(v_opt_ids, 1) > 0 then
        raise exception 'text question % cannot have option_ids', v_qid using errcode = '22023';
      end if;
    else
      select coalesce(array_agg(elem->>'id'), '{}') into v_declared_ids
      from jsonb_array_elements(v_q->'options') as t(elem);
      if exists (select 1 from unnest(v_opt_ids) oid where oid <> all (v_declared_ids)) then
        raise exception 'question % has option_ids not in declared options', v_qid using errcode = '22023';
      end if;
      if (select count(*) from unnest(v_opt_ids)) <> (select count(distinct x) from unnest(v_opt_ids) x) then
        raise exception 'question % has duplicate option_ids', v_qid using errcode = '22023';
      end if;
      if v_type = 'single' and array_length(v_opt_ids, 1) > 1 then
        raise exception 'single-select question % has multiple option_ids', v_qid using errcode = '22023';
      end if;
    end if;

    if v_other is not null then
      if not v_allow_other and v_type <> 'text' then
        raise exception 'question % does not allow other_text', v_qid using errcode = '22023';
      end if;
      if length(v_other) > v_max_len then
        raise exception 'other_text for % exceeds max_length', v_qid using errcode = '22023';
      end if;
    end if;

    if v_required
       and array_length(v_opt_ids, 1) is null
       and v_other is null then
      raise exception 'required question % has no answer', v_qid using errcode = '22023';
    end if;
  end loop;

  for v_q in select elem from jsonb_array_elements(p_envelope->'questions') as t(elem) loop
    if coalesce((v_q->>'required')::boolean, false) and not ((v_q->>'id') = any(v_seen)) then
      raise exception 'required question % has no answer', v_q->>'id' using errcode = '22023';
    end if;
  end loop;
end $$;

create or replace function _resolve_clarify_pairs(p_envelope jsonb, p_answers jsonb)
returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'question_id', q->>'id',
      'question', q->>'text',
      'answer', (
        with a as (
          select elem from jsonb_array_elements(p_answers) as ta(elem)
          where elem->>'question_id' = q->>'id' limit 1
        )
        select case
          when (select elem from a) is null then '(not answered)'
          when coalesce(((select elem from a)->>'skipped')::boolean, false) then '(skipped)'
          else nullif(trim(both ', ' from concat_ws(', ',
            (select string_agg(o->>'label', ', ' order by ord)
               from jsonb_array_elements(coalesce(q->'options', '[]'::jsonb))
                    with ordinality as topt(o, ord)
              where o->>'id' in (
                select val from jsonb_array_elements_text(
                  coalesce((select elem from a)->'option_ids', '[]'::jsonb)) as tv(val))),
            nullif((select elem from a)->>'other_text', '')
          )), '')
        end
      )
    ) order by ord
  ), '[]'::jsonb)
  from jsonb_array_elements(p_envelope->'questions') with ordinality as tq(q, ord);
$$;
revoke all on function _resolve_clarify_pairs(jsonb, jsonb) from public;
revoke all on function _resolve_clarify_pairs(jsonb, jsonb) from authenticated;

create or replace function upsert_clarification_draft(p_request_id uuid, p_answers jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_ctx record;
begin
  select * into v_ctx from _owned_clarify_request(p_request_id);
  insert into agent_clarification_responses (request_id, thread_id, tenant_id, user_id, draft_answers)
  values (p_request_id, v_ctx.thread_id, v_ctx.tenant_id, auth.uid(), coalesce(p_answers, '{}'::jsonb))
  on conflict (tenant_id, request_id, user_id) do update
    set draft_answers = excluded.draft_answers, updated_at = now()
    where agent_clarification_responses.status = 'draft';
end $$;

create or replace function submit_clarification_response(
  p_request_id uuid,
  p_agent_hash text,
  p_answers jsonb
) returns table (run_id uuid, agent_slug text, thread_id uuid)
language plpgsql security definer set search_path = public as $$
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
end $$;

revoke all on function submit_clarification_response(uuid, text, jsonb) from public;
grant execute on function submit_clarification_response(uuid, text, jsonb) to authenticated;
revoke all on function upsert_clarification_draft(uuid, jsonb) from public;
grant execute on function upsert_clarification_draft(uuid, jsonb) to authenticated;
revoke all on function _owned_clarify_request(uuid) from public, authenticated;
revoke all on function _validate_clarify_answers(jsonb, jsonb) from public, authenticated;
