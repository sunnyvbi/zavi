
create table if not exists action_outcomes (
  id                       bigint      generated always as identity primary key,
  tenant_id                uuid        not null,
  decision_id              uuid        not null unique
                           references decisions(id) on delete restrict,
  action_class             text        not null,
  decision_outcome         text        not null
                           check (decision_outcome in ('approved', 'rejected')),
  subject_type             text        not null
                           check (subject_type in ('campaign', 'adset', 'ad')),
  subject_id               text        not null,
  subject_name             text,
  target_metric            text        not null,
  baseline_metrics         jsonb       not null default '{}'::jsonb,
  outcome_metrics          jsonb       not null default '{}'::jsonb,
  delta_metrics            jsonb       not null default '{}'::jsonb,
  baseline_status          text        not null default 'pending'
                           check (baseline_status in ('pending', 'enriched', 'no_data', 'error')),
  reconcile_status         text        not null default 'pending'
                           check (reconcile_status in ('pending', 'measured', 'no_data', 'error')),
  measurement_window_days  int         not null default 14,
  measurement_window_start timestamptz,
  measurement_window_end   timestamptz,
  errors                   jsonb       not null default '[]'::jsonb,
  attempt_count            int         not null default 0,
  last_attempted_at        timestamptz,
  metrics_schema_version   int         not null default 1,
  reconcile_after          timestamptz not null,
  measured_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists action_outcomes_due_idx
  on action_outcomes (reconcile_after)
  where reconcile_status = 'pending';

create index if not exists action_outcomes_tenant_created_idx
  on action_outcomes (tenant_id, created_at desc);

alter table action_outcomes enable row level security;

drop policy if exists action_outcomes_select on action_outcomes;
create policy action_outcomes_select on action_outcomes
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = action_outcomes.tenant_id)
  );

create or replace function record_action_outcome(
  p_decision_id             uuid,
  p_action_class            text,
  p_decision_outcome        text,
  p_subject_type            text,
  p_subject_id              text,
  p_subject_name            text default null,
  p_target_metric           text default 'spend',
  p_measurement_window_days int  default 14,
  p_baseline_metrics        jsonb default '{}'::jsonb
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
  if p_subject_type not in ('campaign', 'adset', 'ad') then
    raise exception 'record_action_outcome: invalid subject_type %', p_subject_type using errcode = '22023';
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
    measurement_window_days, reconcile_after
  ) values (
    v_tenant, p_decision_id, p_action_class, p_decision_outcome,
    p_subject_type, p_subject_id, p_subject_name, coalesce(p_target_metric, 'spend'),
    coalesce(p_baseline_metrics, '{}'::jsonb),
    case when p_baseline_metrics is null or p_baseline_metrics = '{}'::jsonb
         then 'pending' else 'enriched' end,
    v_window, now() + make_interval(days => v_window)
  )
  on conflict (decision_id) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from action_outcomes where decision_id = p_decision_id;
  end if;

  return v_id;
end $$;
revoke all on function record_action_outcome(uuid, text, text, text, text, text, text, int, jsonb) from public;
revoke all on function record_action_outcome(uuid, text, text, text, text, text, text, int, jsonb) from authenticated;
grant execute on function record_action_outcome(uuid, text, text, text, text, text, text, int, jsonb) to service_role;

create or replace function enrich_action_outcome_baseline(
  p_id               bigint,
  p_baseline_metrics jsonb,
  p_status           text default 'enriched',
  p_subject_name     text default null,
  p_error            text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_changed bigint;
begin
  if p_id is null then
    raise exception 'enrich_action_outcome_baseline: null id' using errcode = '22023';
  end if;
  if p_status not in ('enriched', 'no_data', 'error') then
    raise exception 'enrich_action_outcome_baseline: invalid status %', p_status using errcode = '22023';
  end if;

  update action_outcomes
     set baseline_metrics = case when p_status = 'enriched' then coalesce(p_baseline_metrics, baseline_metrics) else baseline_metrics end,
         baseline_status  = p_status,
         subject_name     = coalesce(p_subject_name, subject_name),
         errors           = case when p_error is null then errors
                                 else errors || jsonb_build_object('stage', 'baseline', 'message', left(p_error, 300), 'at', now()) end,
         updated_at       = now()
   where id = p_id and baseline_status = 'pending';

  get diagnostics v_changed = row_count;
  return v_changed > 0;
end $$;
revoke all on function enrich_action_outcome_baseline(bigint, jsonb, text, text, text) from public;
revoke all on function enrich_action_outcome_baseline(bigint, jsonb, text, text, text) from authenticated;
grant execute on function enrich_action_outcome_baseline(bigint, jsonb, text, text, text) to service_role;

create or replace function reconcile_action_outcome(
  p_id              bigint,
  p_status          text,
  p_outcome_metrics jsonb default '{}'::jsonb,
  p_delta_metrics   jsonb default '{}'::jsonb,
  p_window_start    timestamptz default null,
  p_window_end      timestamptz default null,
  p_error           text default null
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_changed bigint;
begin
  if p_id is null then
    raise exception 'reconcile_action_outcome: null id' using errcode = '22023';
  end if;
  if p_status not in ('measured', 'no_data', 'error') then
    raise exception 'reconcile_action_outcome: invalid status %', p_status using errcode = '22023';
  end if;

  update action_outcomes
     set reconcile_status        = p_status,
         outcome_metrics          = coalesce(p_outcome_metrics, '{}'::jsonb),
         delta_metrics            = coalesce(p_delta_metrics, '{}'::jsonb),
         measurement_window_start = coalesce(p_window_start, measurement_window_start),
         measurement_window_end   = coalesce(p_window_end, measurement_window_end),
         measured_at              = now(),
         attempt_count            = attempt_count + 1,
         last_attempted_at        = now(),
         errors                   = case when p_error is null then errors
                                         else errors || jsonb_build_object('stage', 'reconcile', 'message', left(p_error, 300), 'at', now()) end,
         updated_at               = now()
   where id = p_id and reconcile_status = 'pending';

  get diagnostics v_changed = row_count;
  return v_changed > 0;
end $$;
revoke all on function reconcile_action_outcome(bigint, text, jsonb, jsonb, timestamptz, timestamptz, text) from public;
revoke all on function reconcile_action_outcome(bigint, text, jsonb, jsonb, timestamptz, timestamptz, text) from authenticated;
grant execute on function reconcile_action_outcome(bigint, text, jsonb, jsonb, timestamptz, timestamptz, text) to service_role;

create or replace function bump_action_outcome_attempt(
  p_id    bigint,
  p_error text default null
) returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if p_id is null then
    raise exception 'bump_action_outcome_attempt: null id' using errcode = '22023';
  end if;
  update action_outcomes
     set attempt_count     = attempt_count + 1,
         last_attempted_at = now(),
         errors            = case when p_error is null then errors
                                  else errors || jsonb_build_object('stage', 'reconcile_attempt', 'message', left(p_error, 300), 'at', now()) end,
         updated_at        = now()
   where id = p_id and reconcile_status = 'pending'
   returning attempt_count into v_n;
  return coalesce(v_n, -1);
end $$;
revoke all on function bump_action_outcome_attempt(bigint, text) from public;
revoke all on function bump_action_outcome_attempt(bigint, text) from authenticated;
grant execute on function bump_action_outcome_attempt(bigint, text) to service_role;

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
