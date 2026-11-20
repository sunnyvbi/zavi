
create table if not exists admin_correction_eval_cases (
  id             bigint      generated always as identity primary key,
  tenant_id      uuid        not null,
  agent_slug     text        not null,
  decision_class text        not null,
  signature      text        not null,
  before_body    jsonb       not null,
  after_body     jsonb       not null,
  rationale      text,
  decision_id    uuid        not null,
  last_result    text        not null default 'untested'
                 check (last_result in ('untested', 'pass', 'fail')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, decision_id)
);

create index if not exists admin_correction_eval_cases_tenant_idx
  on admin_correction_eval_cases (tenant_id, agent_slug);

alter table admin_correction_eval_cases enable row level security;

create or replace function record_admin_correction_eval_case(
  p_tenant_id      uuid,
  p_agent_slug     text,
  p_decision_class text,
  p_signature      text,
  p_before_body    jsonb,
  p_after_body     jsonb,
  p_rationale      text,
  p_decision_id    uuid
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_decision_tenant uuid;
  v_id              bigint;
begin
  if p_tenant_id is null then
    raise exception 'record_admin_correction_eval_case: null tenant_id' using errcode = '22023';
  end if;
  if p_decision_id is null then
    raise exception 'record_admin_correction_eval_case: null decision_id' using errcode = '22023';
  end if;
  if p_agent_slug is null or char_length(p_agent_slug) < 1 then
    raise exception 'record_admin_correction_eval_case: empty agent_slug' using errcode = '22023';
  end if;

  select tenant_id into v_decision_tenant from decisions where id = p_decision_id;
  if v_decision_tenant is null then
    raise exception 'record_admin_correction_eval_case: decision % not found', p_decision_id
      using errcode = '22023';
  end if;
  if v_decision_tenant <> p_tenant_id then
    raise exception 'record_admin_correction_eval_case: decision % does not belong to tenant %',
      p_decision_id, p_tenant_id using errcode = '42501';
  end if;

  insert into admin_correction_eval_cases (
    tenant_id, agent_slug, decision_class, signature,
    before_body, after_body, rationale, decision_id
  ) values (
    p_tenant_id, p_agent_slug, p_decision_class, p_signature,
    coalesce(p_before_body, '{}'::jsonb), coalesce(p_after_body, '{}'::jsonb),
    left(coalesce(p_rationale, ''), 2000), p_decision_id
  )
  on conflict (tenant_id, decision_id) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from admin_correction_eval_cases
     where tenant_id = p_tenant_id and decision_id = p_decision_id;
  end if;

  return v_id;
end $$;
revoke all on function record_admin_correction_eval_case(uuid, text, text, text, jsonb, jsonb, text, uuid) from public;
revoke all on function record_admin_correction_eval_case(uuid, text, text, text, jsonb, jsonb, text, uuid) from authenticated;
grant execute on function record_admin_correction_eval_case(uuid, text, text, text, jsonb, jsonb, text, uuid) to service_role;
