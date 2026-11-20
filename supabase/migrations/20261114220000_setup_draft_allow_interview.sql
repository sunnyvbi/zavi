create or replace function enqueue_setup_draft(
  p_tenant_id  uuid,
  p_agent_hash text,
  p_payload    jsonb,
  p_attempt    int
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key    text;
  v_est    int;
  v_avail  int;
  v_bridge int := 0;
  v_run    uuid;
begin
  if auth.uid() is not null then
    raise exception 'enqueue_setup_draft: service role only' using errcode = '42501';
  end if;
  if p_tenant_id is null or p_attempt is null or p_attempt not between 1 and 3 then
    raise exception 'enqueue_setup_draft: tenant and attempt 1-3 required' using errcode = '22023';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or p_payload->>'stage' is distinct from 'draft_strategy'
     or p_payload->>'origin' is distinct from 'setup_draft'
     or exists (select 1 from jsonb_object_keys(p_payload) k
                 where k not in ('stage', 'origin', 'research', 'past_work', 'interview')) then
    raise exception 'enqueue_setup_draft: not a setup draft payload' using errcode = '22023';
  end if;
  v_key := 'cgo:draft:' || p_tenant_id::text || ':setup'
           || case when p_attempt = 1 then '' else ':' || p_attempt::text end;

  if _credits_enforced(p_tenant_id) then
    v_est := _reserve_estimate_for('cgo');
    perform _credit_balance_touch(p_tenant_id);
    select (included_allowance - included_used)
           + greatest(daily_allowance - daily_used, 0)
           + purchased_balance - reserved
      into v_avail
      from tenant_credit_balances where tenant_id = p_tenant_id;
    v_bridge := greatest(v_est - coalesce(v_avail, 0), 0);
    if v_bridge > 0 then
      update tenant_credit_balances
         set purchased_balance = purchased_balance + v_bridge
       where tenant_id = p_tenant_id;
    end if;
  end if;

  v_run := enqueue_agent_run(p_tenant_id, 'cgo', p_agent_hash, 'a2a', p_payload, v_key);

  if v_run is not null then
    insert into setup_draft_admissions (run_id, tenant_id, attempt, bridged)
    values (v_run, p_tenant_id, p_attempt, v_bridge);
  end if;

  if v_bridge > 0 then
    update tenant_credit_balances
       set purchased_balance = purchased_balance - v_bridge
     where tenant_id = p_tenant_id;
  end if;
  return v_run;
end $$;
revoke all on function enqueue_setup_draft(uuid, text, jsonb, int) from public, anon, authenticated;
grant execute on function enqueue_setup_draft(uuid, text, jsonb, int) to service_role;
