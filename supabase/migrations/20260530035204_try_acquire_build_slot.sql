
begin;

alter table conductor_runs
  drop constraint conductor_runs_status_check;
alter table conductor_runs
  add constraint conductor_runs_status_check
    check (status in ('provisioning', 'active', 'halted', 'done', 'failed'));

create or replace function try_acquire_build_slot(
  p_tenant_id           uuid,
  p_objective           text,
  p_max_usd             numeric,
  p_provision_estimate  numeric,
  p_max_per_day         int,
  p_daily_cap_usd       numeric
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_active   int;
  v_today    int;
  v_charged  boolean;
  v_id       uuid;
begin
  if p_tenant_id is null or p_objective is null or p_max_usd is null
     or p_provision_estimate is null or p_max_per_day is null
     or p_daily_cap_usd is null then
    raise exception 'try_acquire_build_slot: null argument' using errcode = '22023';
  end if;
  if p_provision_estimate < 0 or p_max_usd < 0 or p_max_per_day < 0 or p_daily_cap_usd < 0 then
    raise exception 'try_acquire_build_slot: negative argument' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('build:' || p_tenant_id::text, 0));

  select count(*)::int into v_active
    from conductor_runs
   where tenant_id = p_tenant_id
     and status in ('provisioning', 'active');
  if v_active > 0 then
    raise exception 'double_build' using errcode = 'P0001';
  end if;

  select count(*)::int into v_today
    from conductor_runs
   where tenant_id = p_tenant_id
     and (created_at at time zone 'UTC')::date = (now() at time zone 'UTC')::date;
  if v_today >= p_max_per_day then
    raise exception 'daily_limit' using errcode = 'P0001';
  end if;

  v_charged := consume_budget_or_reject(
    p_tenant_id,
    (now() at time zone 'UTC')::date,
    p_provision_estimate,
    p_daily_cap_usd
  );
  if not v_charged then
    raise exception 'over_cap' using errcode = 'P0001';
  end if;

  insert into conductor_runs (tenant_id, objective, status, max_usd, goal_graph)
  values (p_tenant_id, p_objective, 'provisioning', p_max_usd, '[]'::jsonb)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function try_acquire_build_slot(uuid, text, numeric, numeric, int, numeric) from public;
grant execute on function try_acquire_build_slot(uuid, text, numeric, numeric, int, numeric) to service_role;

commit;
