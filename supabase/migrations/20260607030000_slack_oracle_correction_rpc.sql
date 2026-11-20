
create extension if not exists pgcrypto;

create or replace function _oracle_uuid_from_text(p_key text)
returns uuid
language sql immutable as $$
  select (
    overlay(
      overlay(
        encode(substring(digest(p_key, 'sha256') from 1 for 16), 'hex')
        placing '5' from 13 for 1
      )
      placing '8' from 17 for 1
    )
  )::uuid;
$$;

create or replace function insert_oracle_correction(
  p_tenant_id      uuid,
  p_run_id         uuid,
  p_agent_slug     text,
  p_verdict        text,
  p_correction     text,
  p_callback_id    text
) returns table (case_id bigint, inserted boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_run_tenant  uuid;
  v_decision_id uuid;
  v_id          bigint;
begin
  if p_tenant_id is null then
    raise exception 'insert_oracle_correction: null tenant_id' using errcode = '22023';
  end if;
  if p_run_id is null then
    raise exception 'insert_oracle_correction: null run_id' using errcode = '22023';
  end if;
  if p_agent_slug is null or char_length(p_agent_slug) < 1 then
    raise exception 'insert_oracle_correction: empty agent_slug' using errcode = '22023';
  end if;
  if p_verdict is null or p_verdict not in ('pass', 'fail') then
    raise exception 'insert_oracle_correction: bad verdict %', p_verdict using errcode = '22023';
  end if;

  select tenant_id into v_run_tenant from agent_runs where id = p_run_id;
  if v_run_tenant is null then
    raise exception 'insert_oracle_correction: run % not found', p_run_id using errcode = '22023';
  end if;
  if v_run_tenant <> p_tenant_id then
    raise exception 'insert_oracle_correction: run % does not belong to tenant % (cross-tenant)',
      p_run_id, p_tenant_id using errcode = '42501';
  end if;

  v_decision_id := _oracle_uuid_from_text('d7-oracle|' || p_tenant_id::text || '|' || p_run_id::text);

  insert into admin_correction_eval_cases (
    tenant_id, agent_slug, decision_class, signature,
    before_body, after_body, rationale, decision_id
  ) values (
    p_tenant_id,
    p_agent_slug,
    p_agent_slug || '.oracle',
    encode(digest(p_tenant_id::text || '|' || p_run_id::text || '|oracle', 'sha256'), 'hex'),
    jsonb_build_object('run_id', p_run_id, 'source', 'slack_oracle', 'callback_id', left(coalesce(p_callback_id, ''), 200)),
    jsonb_build_object('verdict', p_verdict, 'should_not_emit', (p_verdict = 'fail')),
    left(coalesce(p_correction, ''), 4000),
    v_decision_id
  )
  on conflict (tenant_id, decision_id) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from admin_correction_eval_cases
     where tenant_id = p_tenant_id and decision_id = v_decision_id;
    return query select v_id, false;
  end if;

  return query select v_id, true;
end $$;

revoke all on function insert_oracle_correction(uuid, uuid, text, text, text, text) from public;
revoke all on function insert_oracle_correction(uuid, uuid, text, text, text, text) from authenticated;
grant execute on function insert_oracle_correction(uuid, uuid, text, text, text, text) to service_role;
