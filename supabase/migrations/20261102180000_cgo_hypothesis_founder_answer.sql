create unique index if not exists cgo_questions_one_open_hypothesis
  on cgo_questions (tenant_id) where status = 'open' and on_yes->>'kind' = 'hypothesis_check';

create or replace function answer_hypothesis_question(
  p_tenant_id   uuid,
  p_question_id uuid,
  p_kind        text,
  p_answer      text,
  p_words       text,
  p_via         text,
  p_actor       uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_q        cgo_questions%rowtype;
  v_h        cgo_hypotheses%rowtype;
  v_now      timestamptz := now();
  v_status   text;
  v_entry    jsonb;
  v_evidence jsonb;
  v_line     text;
  v_reason   text;
  v_evicted  jsonb;
  v_drop     bigint;
  v_all      jsonb;
  v_uuid     constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if p_tenant_id is null or p_question_id is null or p_kind not in ('yes', 'no', 'words')
     or nullif(trim(coalesce(p_answer, '')), '') is null
     or (p_kind = 'words' and nullif(trim(coalesce(p_words, '')), '') is null) then
    raise exception 'answer_hypothesis_question: tenant, question, kind and answer are required'
      using errcode = '22023';
  end if;

  select * into v_q from cgo_questions
   where id = p_question_id and tenant_id = p_tenant_id and status = 'open'
   for update;
  if not found then
    return jsonb_build_object('outcome', 'not_open');
  end if;
  if coalesce(v_q.on_yes->>'kind', '') <> 'hypothesis_check' then
    return jsonb_build_object('outcome', 'wrong_kind');
  end if;

  if coalesce(v_q.on_yes->>'hypothesis_id', '') !~ v_uuid or coalesce(v_q.on_yes->>'goal_id', '') !~ v_uuid
     or nullif(v_q.on_yes->>'claim', '') is null then
    v_reason := 'gone';
  else
    select * into v_h from cgo_hypotheses
     where id = (v_q.on_yes->>'hypothesis_id')::uuid
       and tenant_id = p_tenant_id
       and goal_id = (v_q.on_yes->>'goal_id')::uuid
     for update;
  end if;
  if v_reason is not null then
    null;
  elsif not found then
    v_reason := 'gone';
  elsif v_h.status not in ('listed', 'testing') then
    v_reason := v_h.status;
  elsif v_h.claim is distinct from v_q.on_yes->>'claim' then
    v_reason := 'reworded';
  end if;

  if v_reason is not null then
    update cgo_questions
       set status = 'withdrawn', answer = left(p_answer, 500), answered_at = v_now,
           answered_via = p_via, answered_by = p_actor, founder_replied_at = v_now
     where id = v_q.id and tenant_id = p_tenant_id;
    return jsonb_build_object('outcome', 'stale', 'reason', v_reason);
  end if;

  v_entry := jsonb_build_object(
    'at', v_now, 'kind', 'founder', 'ref', v_q.id::text,
    'excerpt', case p_kind
      when 'yes' then left('The founder confirmed this is true for their business: ' || v_h.claim, 500)
      when 'no' then left('The founder said this is not true for their business: ' || v_h.claim, 500)
      else left('The founder wrote: ' || regexp_replace(trim(p_words), '\s+', ' ', 'g'), 500)
    end);
  if p_kind in ('yes', 'no') then
    v_status := case p_kind when 'yes' then 'confirmed' else 'ruled_out' end;
    v_entry := v_entry || jsonb_build_object(
      'verdict', v_status, 'why', 'The founder answered about their own records', 'checker', 'founder');
  else
    v_status := v_h.status;
  end if;

  v_all := v_h.evidence || jsonb_build_array(v_entry);
  if jsonb_array_length(v_all) > 40 then
    select i into v_drop from jsonb_array_elements(v_all) with ordinality t(e, i)
     where coalesce(e->>'kind', '') <> 'founder' order by i limit 1;
  end if;
  if v_drop is not null then
    v_evicted := v_all->(v_drop::int - 1);
  end if;
  select coalesce(jsonb_agg(e order by i), '[]'::jsonb) into v_evidence
    from jsonb_array_elements(v_all) with ordinality t(e, i)
   where v_drop is null or i <> v_drop;

  update cgo_hypotheses
     set evidence = v_evidence,
         evidence_version = v_h.evidence_version + 1,
         status = v_status,
         status_at = case when v_status <> v_h.status then v_now else status_at end,
         updated_at = v_now
   where id = v_h.id and tenant_id = p_tenant_id;

  v_line := case p_kind
    when 'yes' then left('Marked as true for your business: "' || v_h.claim || '".', 400)
    when 'no' then left('Marked as not true for your business: "' || v_h.claim || '".', 400)
    else left('Saved your words about "' || v_h.claim || '" for the next check.', 400)
  end;

  update cgo_questions
     set status = 'answered', answer = left(p_answer, 500), answered_at = v_now,
         answered_via = p_via, answered_by = p_actor, founder_replied_at = v_now,
         applied_line = v_line,
         on_yes = v_q.on_yes || jsonb_build_object(
           'prior_status', v_h.status, 'written_version', v_h.evidence_version + 1, 'applied_at', v_now)
           || case when v_evicted is not null then jsonb_build_object('evicted', v_evicted, 'evicted_at', v_drop - 1) else '{}'::jsonb end
   where id = v_q.id and tenant_id = p_tenant_id;

  return jsonb_build_object('outcome', 'applied', 'status', v_status, 'prior_status', v_h.status, 'line', v_line);
end $$;
revoke all on function answer_hypothesis_question(uuid, uuid, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function answer_hypothesis_question(uuid, uuid, text, text, text, text, uuid) to service_role;

create or replace function undo_hypothesis_answer(
  p_tenant_id   uuid,
  p_question_id uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_q        cgo_questions%rowtype;
  v_h        cgo_hypotheses%rowtype;
  v_now      timestamptz := now();
  v_prior    text;
  v_evidence jsonb;
begin
  if p_tenant_id is null or p_question_id is null then
    raise exception 'undo_hypothesis_answer: tenant and question are required' using errcode = '22023';
  end if;

  select * into v_q from cgo_questions
   where id = p_question_id and tenant_id = p_tenant_id and status = 'answered'
     and on_yes->>'kind' = 'hypothesis_check'
     and on_yes->>'undone_at' is null
     and on_yes->>'written_version' ~ '^[0-9]{1,9}$'
     and on_yes->>'hypothesis_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   for update;
  if not found then
    return jsonb_build_object('outcome', 'nothing');
  end if;
  v_prior := v_q.on_yes->>'prior_status';
  if v_prior is null or v_prior not in ('listed', 'testing') then
    return jsonb_build_object('outcome', 'nothing');
  end if;

  select * into v_h from cgo_hypotheses
   where id = (v_q.on_yes->>'hypothesis_id')::uuid
     and tenant_id = p_tenant_id
     and evidence_version = (v_q.on_yes->>'written_version')::int
   for update;
  if not found then
    return jsonb_build_object('outcome', 'changed');
  end if;

  select coalesce(jsonb_agg(e order by i), '[]'::jsonb) into v_evidence
    from jsonb_array_elements(v_h.evidence) with ordinality t(e, i)
   where not (e->>'kind' = 'founder' and e->>'ref' = v_q.id::text);
  if v_q.on_yes ? 'evicted' and coalesce(v_q.on_yes->>'evicted_at', '') ~ '^[0-9]{1,3}$' then
    v_evidence := jsonb_insert(v_evidence, array[(v_q.on_yes->>'evicted_at')], v_q.on_yes->'evicted');
  end if;

  update cgo_hypotheses
     set evidence = v_evidence,
         evidence_version = v_h.evidence_version + 1,
         status = v_prior,
         status_at = case when v_prior <> v_h.status then v_now else status_at end,
         updated_at = v_now
   where id = v_h.id and tenant_id = p_tenant_id;

  update cgo_questions
     set status = 'withdrawn', applied_line = null,
         on_yes = v_q.on_yes || jsonb_build_object('undone_at', v_now)
   where id = v_q.id and tenant_id = p_tenant_id;

  return jsonb_build_object('outcome', 'undone', 'claim', v_h.claim);
end $$;
revoke all on function undo_hypothesis_answer(uuid, uuid) from public, anon, authenticated;
grant execute on function undo_hypothesis_answer(uuid, uuid) to service_role;

do $$ begin
  raise notice '20261102180000: answer_hypothesis_question + undo_hypothesis_answer';
end $$;
