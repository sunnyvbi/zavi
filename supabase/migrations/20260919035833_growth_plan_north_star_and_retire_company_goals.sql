
begin;

alter table growth_plan rename column target_metric to north_star_metric;

create or replace function set_growth_plan(
  p_tenant_id             uuid,
  p_objective             text,
  p_target_metric         text,
  p_constraint_statement  text,
  p_constraint_confidence text,
  p_basis_evidence        jsonb,
  p_actor_kind            text,
  p_actor_ref             text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id      uuid;
  v_prev    growth_plan%rowtype;
  v_version int := 1;
begin
  select * into v_prev from growth_plan
    where tenant_id = p_tenant_id and status = 'live'
    limit 1;

  if found then
    v_version := v_prev.version + 1;
    update growth_plan
      set status = 'superseded', updated_at = now()
      where id = v_prev.id;
  end if;

  insert into growth_plan (
    tenant_id, objective, north_star_metric,
    constraint_statement, constraint_confidence, basis_evidence, status, version
  ) values (
    p_tenant_id, p_objective, p_target_metric,
    p_constraint_statement, p_constraint_confidence,
    case when jsonb_typeof(p_basis_evidence) = 'array' then p_basis_evidence else null end,
    'live', v_version
  ) returning id into v_id;

  if v_prev.objective is distinct from p_objective then
    perform log_growth_plan_change(
      p_tenant_id, v_id, 'plan', v_id, 'objective',
      v_prev.objective, p_objective, p_actor_kind, p_actor_ref, null
    );
  end if;

  if v_prev.constraint_statement is distinct from p_constraint_statement then
    perform log_growth_plan_change(
      p_tenant_id, v_id, 'plan', v_id, 'constraint_statement',
      v_prev.constraint_statement, p_constraint_statement,
      p_actor_kind, p_actor_ref, null
    );
  end if;

  return v_id;
end $$;

revoke all on function set_growth_plan(uuid, text, text, text, text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function set_growth_plan(uuid, text, text, text, text, jsonb, text, text)
  to service_role;

alter table tenant_fact
  add constraint tenant_fact_company_goals_retired
  check (key <> 'company_goals') not valid;

commit;
