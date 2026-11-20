
set local search_path = public;

create or replace function apply_baked_rule(
  p_decision_id uuid,
  p_merged_body_markdown text,
  p_frontmatter jsonb default '{}'::jsonb
) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_tenant_id uuid;
  v_agent_slug text;
  v_source_feedback_id uuid;
  v_status text;
  v_prev_version int;
  v_new_version int;
begin
  select tenant_id, body->>'target_agent_slug', source_feedback_id, status
    into v_tenant_id, v_agent_slug, v_source_feedback_id, v_status
    from decisions
    where id = p_decision_id;

  if v_tenant_id is null then
    raise exception 'decision % not found', p_decision_id using errcode = '42704';
  end if;
  if v_agent_slug is null or v_agent_slug = '' then
    raise exception 'decision % body missing target_agent_slug', p_decision_id
      using errcode = '22023';
  end if;
  if v_status not in ('approved', 'proposed') then
    if v_status = 'acted' then
      return 0;
    end if;
    raise exception 'decision % in status % (cannot bake)', p_decision_id, v_status
      using errcode = '22023';
  end if;

  select coalesce(max(version), 0) into v_prev_version
    from tenant_agents
    where tenant_id = v_tenant_id and slug = v_agent_slug;
  v_new_version := v_prev_version + 1;

  update tenant_agents
    set status = 'retired'
    where tenant_id = v_tenant_id
      and slug = v_agent_slug
      and status = 'active';

  insert into tenant_agents (
    tenant_id, slug, version, body_markdown, frontmatter,
    parent_version, parent_template, status, created_by
  ) values (
    v_tenant_id, v_agent_slug, v_new_version, p_merged_body_markdown, p_frontmatter,
    nullif(v_prev_version, 0), v_agent_slug, 'active', null
  );

  update decisions
    set status = 'acted', dispatched_at = now()
    where id = p_decision_id;

  if v_source_feedback_id is not null then
    update agent_feedback
      set state = 'applied'
      where id = v_source_feedback_id;
  end if;

  return v_new_version;
end $$;

revoke all on function apply_baked_rule(uuid, text, jsonb) from public;
grant execute on function apply_baked_rule(uuid, text, jsonb) to service_role;

create or replace function list_trainer_queue(p_limit int default 50)
returns table (
  type text,
  id uuid,
  tenant_id uuid,
  agent_slug text,
  priority_score int,
  surfaced_at timestamptz,
  preview text,
  source_feedback_id uuid,
  source_thread_id uuid
)
language plpgsql security definer set search_path = public as $$
begin
  return query
  select
    'decision'::text                     as type,
    d.id                                  as id,
    d.tenant_id                           as tenant_id,
    coalesce(d.body->>'target_agent_slug',
             (select ar.agent_slug from agent_runs ar where ar.id = d.agent_run_id),
             d.decision_class)            as agent_slug,
    100                                   as priority_score,
    d.emitted_at                          as surfaced_at,
    left(coalesce(d.body->>'rule_body_markdown', d.decision_class), 200) as preview,
    d.source_feedback_id                  as source_feedback_id,
    d.source_thread_id                    as source_thread_id
  from decisions d
  where d.status = 'proposed'
    and d.decision_class in ('proposed_rule', 'proposed_global_rule')
  union all
  select
    'agent_run'::text                     as type,
    ar.id                                 as id,
    ar.tenant_id                          as tenant_id,
    ar.agent_slug                         as agent_slug,
    case when ar.status = 'failed' then 50 else 30 end as priority_score,
    coalesce(ar.finished_at, ar.started_at, ar.enqueued_at) as surfaced_at,
    coalesce(left(ar.output_text, 200), ar.status)         as preview,
    null::uuid                            as source_feedback_id,
    null::uuid                            as source_thread_id
  from agent_runs ar
  where ar.needs_review = true
    and ar.status in ('success', 'failed', 'parse_failed')
  order by priority_score desc, surfaced_at desc nulls last
  limit p_limit;
end $$;

revoke all on function list_trainer_queue(int) from public;
grant execute on function list_trainer_queue(int) to service_role;

create or replace function propose_global_rule(
  p_source_decision_id uuid,
  p_staff_user_id uuid,
  p_target_agent_slug text,
  p_body_markdown text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_staff_user_id is null then
    raise exception 'staff_user_id required' using errcode = '22023';
  end if;
  if length(coalesce(p_body_markdown, '')) < 1 then
    raise exception 'body_markdown required' using errcode = '22023';
  end if;

  insert into global_agent_rules (
    agent_slug, body_markdown, source_decision_id, source_feedback_id,
    status, proposed_by
  )
  select
    p_target_agent_slug,
    p_body_markdown,
    p_source_decision_id,
    d.source_feedback_id,
    'pending',
    p_staff_user_id
  from decisions d
  where d.id = p_source_decision_id
  returning id into v_id;

  if v_id is null then
    insert into global_agent_rules (
      agent_slug, body_markdown, source_decision_id, status, proposed_by
    ) values (
      p_target_agent_slug, p_body_markdown, p_source_decision_id, 'pending', p_staff_user_id
    )
    returning id into v_id;
  end if;

  return v_id;
end $$;

revoke all on function propose_global_rule(uuid, uuid, text, text) from public;
grant execute on function propose_global_rule(uuid, uuid, text, text) to service_role;

create or replace function approve_global_rule(
  p_global_rule_id uuid,
  p_approver_user_id uuid,
  p_target_tenant_ids uuid[]
) returns uuid[]
language plpgsql security definer set search_path = public as $$
declare
  v_slug text;
  v_body text;
  v_status text;
  v_decision_ids uuid[] := '{}'::uuid[];
  v_tenant_id uuid;
  v_feedback_id uuid;
  v_decision_id uuid;
begin
  if p_approver_user_id is null then
    raise exception 'approver_user_id required' using errcode = '22023';
  end if;
  if array_length(p_target_tenant_ids, 1) is null then
    raise exception 'target_tenant_ids cannot be empty' using errcode = '22023';
  end if;

  select agent_slug, body_markdown, status
    into v_slug, v_body, v_status
    from global_agent_rules
    where id = p_global_rule_id
    for update;

  if v_slug is null then
    raise exception 'global_agent_rules % not found', p_global_rule_id using errcode = '42704';
  end if;
  if v_status <> 'pending' then
    raise exception 'global_agent_rules % is in status % (must be pending)',
      p_global_rule_id, v_status using errcode = '22023';
  end if;

  foreach v_tenant_id in array p_target_tenant_ids loop
    insert into agent_feedback (
      tenant_id, target_type, target_id, agent_slug, kind, state,
      comment, created_by, created_by_role
    ) values (
      v_tenant_id, null, null, v_slug, 'rule', 'applied',
      v_body, p_approver_user_id, 'staff'
    )
    returning id into v_feedback_id;

    insert into decisions (
      tenant_id, agent_run_id, decision_class, body, status,
      autonomy_at_emit, handler, source_feedback_id,
      approved_by, approved_at
    ) values (
      v_tenant_id, null, 'proposed_rule',
      jsonb_build_object(
        'rule_body_markdown', v_body,
        'target_agent_slug', v_slug,
        'origin', 'global_propagation',
        'global_rule_id', p_global_rule_id
      ),
      'approved', 'approval', 'praxis.bake_rule', v_feedback_id,
      p_approver_user_id, now()
    )
    returning id into v_decision_id;

    v_decision_ids := array_append(v_decision_ids, v_decision_id);
  end loop;

  update global_agent_rules
    set status = 'approved',
        approved_by = p_approver_user_id,
        approved_at = now(),
        applied_to_tenants = applied_to_tenants || p_target_tenant_ids
    where id = p_global_rule_id;

  return v_decision_ids;
end $$;

revoke all on function approve_global_rule(uuid, uuid, uuid[]) from public;
grant execute on function approve_global_rule(uuid, uuid, uuid[]) to service_role;
