
begin;

create or replace function consume_class_budget_or_reject(
  p_tenant_id      uuid,
  p_decision_class text,
  p_estimate_usd   numeric
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_max_daily      numeric;
  v_max_per_action numeric;
  v_spent_24h      numeric := 0;
begin
  if p_tenant_id is null or p_decision_class is null
     or p_estimate_usd is null or p_estimate_usd < 0 then
    raise exception 'consume_class_budget_or_reject: null/invalid argument'
      using errcode = '22023';
  end if;

  select max_daily_usd, max_per_action_usd
    into v_max_daily, v_max_per_action
  from tenant_decision_class_overrides
  where tenant_id = p_tenant_id and decision_class = p_decision_class;

  if v_max_per_action is not null and p_estimate_usd > v_max_per_action then
    return 'over_cap';
  end if;

  if v_max_daily is not null then
    select coalesce(sum(l.spend_delta), 0)
      into v_spent_24h
    from autopilot_action_ledger l
    join decisions d on d.id = l.decision_id
    where l.tenant_id = p_tenant_id
      and d.decision_class = p_decision_class
      and l.created_at >= now() - interval '24 hours';

    if v_spent_24h + p_estimate_usd > v_max_daily then
      return 'over_cap';
    end if;
  end if;

  return 'charged';
end;
$$;

revoke all on function consume_class_budget_or_reject(uuid, text, numeric) from public;
grant execute on function consume_class_budget_or_reject(uuid, text, numeric) to service_role;
grant execute on function consume_class_budget_or_reject(uuid, text, numeric) to authenticated;

commit;
