
alter table action_outcomes
  add column if not exists outcome_tier text not null default 'business'
  constraint action_outcomes_outcome_tier_check
  check (outcome_tier in ('delivery', 'business'));

alter table action_outcomes
  drop constraint if exists action_outcomes_subject_type_check;
alter table action_outcomes
  add constraint action_outcomes_subject_type_check
  check (subject_type in ('campaign', 'adset', 'ad', 'pr', 'email', 'other'));

drop function if exists record_action_outcome(uuid, text, text, text, text, text, text, int, jsonb);

create or replace function record_action_outcome(
  p_decision_id             uuid,
  p_action_class            text,
  p_decision_outcome        text,
  p_subject_type            text,
  p_subject_id              text,
  p_subject_name            text default null,
  p_target_metric           text default 'spend',
  p_measurement_window_days int  default 14,
  p_baseline_metrics        jsonb default '{}'::jsonb,
  p_outcome_tier            text default 'business'
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_id     bigint;
  v_window int := coalesce(p_measurement_window_days, 14);
begin
  if p_decision_id is null then
    raise exception 'record_action_outcome: null decision_id' using errcode = '22023';
  end if;
  if p_decision_outcome not in ('approved', 'rejected') then
    raise exception 'record_action_outcome: invalid decision_outcome %', p_decision_outcome using errcode = '22023';
  end if;
  if p_subject_type not in ('campaign', 'adset', 'ad', 'pr', 'email', 'other') then
    raise exception 'record_action_outcome: invalid subject_type %', p_subject_type using errcode = '22023';
  end if;
  if p_outcome_tier not in ('delivery', 'business') then
    raise exception 'record_action_outcome: invalid outcome_tier %', p_outcome_tier using errcode = '22023';
  end if;
  if p_subject_id is null or char_length(p_subject_id) < 1 then
    raise exception 'record_action_outcome: empty subject_id' using errcode = '22023';
  end if;
  if v_window < 1 or v_window > 90 then
    raise exception 'record_action_outcome: window out of range %', v_window using errcode = '22023';
  end if;

  select tenant_id into v_tenant from decisions where id = p_decision_id;
  if v_tenant is null then
    return null;
  end if;

  insert into action_outcomes (
    tenant_id, decision_id, action_class, decision_outcome,
    subject_type, subject_id, subject_name, target_metric,
    baseline_metrics, baseline_status,
    measurement_window_days, reconcile_after, outcome_tier
  ) values (
    v_tenant, p_decision_id, p_action_class, p_decision_outcome,
    p_subject_type, p_subject_id, p_subject_name, coalesce(p_target_metric, 'spend'),
    coalesce(p_baseline_metrics, '{}'::jsonb),
    case when p_baseline_metrics is null or p_baseline_metrics = '{}'::jsonb
         then 'pending' else 'enriched' end,
    v_window, now() + make_interval(days => v_window),
    coalesce(p_outcome_tier, 'business')
  )
  on conflict (decision_id) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from action_outcomes where decision_id = p_decision_id;
  end if;

  return v_id;
end $$;
revoke all on function record_action_outcome(uuid, text, text, text, text, text, text, int, jsonb, text) from public;
revoke all on function record_action_outcome(uuid, text, text, text, text, text, text, int, jsonb, text) from authenticated;
grant execute on function record_action_outcome(uuid, text, text, text, text, text, text, int, jsonb, text) to service_role;

create or replace function get_action_outcome_signal(
  p_tenant_id uuid,
  p_window    interval default interval '90 days'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_since   timestamptz;
  v_signals jsonb;
begin
  if p_tenant_id is null then
    raise exception 'get_action_outcome_signal: null tenant_id' using errcode = '22023';
  end if;
  v_since := now() - coalesce(p_window, interval '90 days');

  select coalesce(jsonb_agg(s order by s.n desc), '[]'::jsonb) into v_signals
  from (
    select
      action_class,
      decision_outcome,
      count(*)                                                   as n,
      avg((delta_metrics->>'spend')::numeric)
        filter (where reconcile_status = 'measured'
                  and (delta_metrics ? 'spend'))                 as avg_spend_delta,
      avg((delta_metrics->>'roas')::numeric)
        filter (where reconcile_status = 'measured'
                  and (delta_metrics ? 'roas'))                  as avg_roas_delta,
      max(measured_at)                                           as last_measured_at
    from action_outcomes
    where tenant_id = p_tenant_id
      and created_at >= v_since
      and outcome_tier = 'business'
    group by action_class, decision_outcome
  ) s;

  return jsonb_build_object(
    'tenant_id', p_tenant_id,
    'window', p_window::text,
    'signals', v_signals
  );
end $$;
revoke all on function get_action_outcome_signal(uuid, interval) from public;
revoke all on function get_action_outcome_signal(uuid, interval) from authenticated;
grant execute on function get_action_outcome_signal(uuid, interval) to service_role;
