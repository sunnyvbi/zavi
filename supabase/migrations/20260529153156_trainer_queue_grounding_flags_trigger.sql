
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
  where ar.grounding_flags @> '[{"severity":"hard"}]'::jsonb
    and ar.status in ('success', 'failed', 'parse_failed')
  order by priority_score desc, surfaced_at desc nulls last
  limit p_limit;
end $$;

revoke all on function list_trainer_queue(int) from public;
grant execute on function list_trainer_queue(int) to service_role;
