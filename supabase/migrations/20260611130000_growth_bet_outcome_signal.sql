
create or replace function get_growth_bet_outcomes(
  p_tenant_id uuid,
  p_window    interval default interval '90 days',
  p_limit     int      default 20
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_since   timestamptz;
  v_rows    jsonb;
begin
  if p_tenant_id is null then
    raise exception 'get_growth_bet_outcomes: null tenant_id' using errcode = '22023';
  end if;
  v_since := now() - coalesce(p_window, interval '90 days');

  select coalesce(jsonb_agg(r order by r.bet_emitted_at desc), '[]'::jsonb)
    into v_rows
  from (
    select
      b.id                                   as bet_decision_id,
      b.decision_class                       as bet_class,
      (b.body->>'bet_claim')                 as bet_claim,
      b.emitted_at                           as bet_emitted_at,
      m.id                                   as outcome_decision_id,
      o.action_class                         as action_class,
      o.decision_outcome                     as decision_outcome,
      o.target_metric                        as target_metric,
      (o.delta_metrics->>'spend')::numeric   as spend_delta,
      (o.delta_metrics->>'roas')::numeric    as roas_delta,
      o.measured_at                          as measured_at
    from decisions b
    join decisions d
      on d.tenant_id = b.tenant_id
     and d.decision_class = 'growth-lead.dispatch-specialist'
     and d.body->>'origin_decision_id' = b.id::text
     and d.status in ('approved', 'acted', 'dispatched')
    join agent_runs ar
      on ar.tenant_id = b.tenant_id
     and ar.payload->>'source_decision_id' = d.id::text
    join decisions m
      on m.tenant_id = b.tenant_id
     and m.agent_run_id = ar.id
    join action_outcomes o
      on o.tenant_id = b.tenant_id
     and o.decision_id = m.id
     and o.reconcile_status = 'measured'
    where b.tenant_id = p_tenant_id
      and b.decision_class in (
        'growth-lead.reallocate-budget',
        'growth-lead.lifecycle-draft',
        'growth-lead.social-draft'
      )
      and b.emitted_at >= v_since
    order by b.emitted_at desc
    limit greatest(coalesce(p_limit, 20), 1)
  ) r;

  return jsonb_build_object(
    'tenant_id', p_tenant_id,
    'window', p_window::text,
    'bets', v_rows
  );
end $$;

revoke all on function get_growth_bet_outcomes(uuid, interval, int) from public;
revoke all on function get_growth_bet_outcomes(uuid, interval, int) from authenticated;
grant execute on function get_growth_bet_outcomes(uuid, interval, int) to service_role;
