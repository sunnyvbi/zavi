
begin;

insert into tenants (id, slug, display_name, kind) values
  ('00000000-0000-0000-0000-0000000a0001', 'toolcharge-a', 'toolcharge-a', 'test'),
  ('00000000-0000-0000-0000-0000000b0001', 'toolcharge-b', 'toolcharge-b', 'test');
insert into tenant_subscriptions (tenant_id, plan, status, monthly_credits) values
  ('00000000-0000-0000-0000-0000000a0001', 'team', 'active', 20),
  ('00000000-0000-0000-0000-0000000b0001', 'team', 'active', 20);
update system_config
   set blob = coalesce(blob, '{}'::jsonb) || '{"free_daily_credits": 10}'::jsonb
 where id = 1;

select _credit_balance_touch('00000000-0000-0000-0000-0000000a0001');
select _credit_balance_touch('00000000-0000-0000-0000-0000000b0001');
update tenant_credit_balances
   set purchased_balance = 1000, included_used = 0, daily_used = 0, reserved = 0
 where tenant_id = '00000000-0000-0000-0000-0000000a0001';
update tenant_credit_balances
   set purchased_balance = 20, included_used = 0, daily_used = 0, reserved = 0
 where tenant_id = '00000000-0000-0000-0000-0000000b0001';

insert into agent_runs (id, tenant_id, agent_slug, agent_definition_hash, trigger, status) values
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000a0001', 'cgo', 'x', 'manual', 'running'),
  ('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-0000000b0001', 'cgo', 'x', 'manual', 'running'),
  ('00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000b0001', 'cgo', 'x', 'manual', 'running'),
  ('00000000-0000-0000-0000-00000000c004', '00000000-0000-0000-0000-0000000a0001', 'cgo', 'x', 'manual', 'running');

insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, period_start, attempt)
select r.tenant_id, r.id, 'reserve', 100, b.period_start, 0
  from agent_runs r join tenant_credit_balances b on b.tenant_id = r.tenant_id
 where r.id::text like '00000000-0000-0000-0000-00000000c00%';
update tenant_credit_balances set reserved = 200
 where tenant_id in ('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-0000000b0001');

do $$
declare
  A  constant uuid := '00000000-0000-0000-0000-0000000a0001';
  B  constant uuid := '00000000-0000-0000-0000-0000000b0001';
  R1 constant uuid := '00000000-0000-0000-0000-00000000c001';
  R2 constant uuid := '00000000-0000-0000-0000-00000000c002';
  R3 constant uuid := '00000000-0000-0000-0000-00000000c003';
  R4 constant uuid := '00000000-0000-0000-0000-00000000c004';
  v_txt  text;
  v_j    jsonb;
  v_cost numeric;
  v_bal  tenant_credit_balances%rowtype;
  v_ok   boolean;
begin
  assert record_late_tool_charge(A, R1, 'tc_a', null, 0.46) = 'recorded', 'record tc_a';
  assert record_late_tool_charge(A, R1, 'tc_a', null, 0.46) = 'already', 'record tc_a twice is a no-op';
  assert record_late_tool_charge(A, R1, 'tc_b', null, 0.10) = 'recorded', 'record tc_b';
  assert add_run_side_cost(A, R1, 'tc_c', 0.05, 'browser_task') = 'added', 'side cost added';
  assert add_run_side_cost(A, R1, 'tc_c', 0.05, 'browser_task') = 'already', 'side cost re-add is a no-op';
  assert add_run_side_cost(A, R1, 'tc_z', 0, 'browser_task') = 'zero', 'zero side cost writes nothing';
  select coalesce(sum(usd), 0) into v_cost from agent_run_side_costs where run_id = R1;
  assert v_cost = 0.61, 'side costs sum once: 0.46 + 0.10 + 0.05, got ' || v_cost;

  v_ok := false;
  begin perform add_run_side_cost(B, R1, 'x', 0.01, 's'); exception when sqlstate '42501' then v_ok := true; end;
  assert v_ok, 'add_run_side_cost refuses another tenant';
  v_ok := false;
  begin perform record_late_tool_charge(B, R1, 'x', null, 0.01); exception when sqlstate '42501' then v_ok := true; end;
  assert v_ok, 'record_late_tool_charge refuses another tenant';
  v_ok := false;
  begin perform refund_tool_charge(B, R1, 'tc_a', 0.06); exception when sqlstate '42501' then v_ok := true; end;
  assert v_ok, 'refund_tool_charge refuses another tenant';

  v_j := refund_tool_charge(A, R1, 'tc_a', 0.06);
  assert v_j->>'status' = 'pending', 'refund before settle is pending, got ' || v_j::text;

  update agent_runs set status = 'success', finished_at = now(), cost_usd = 0.10
   where id = R1 and status = 'running';
  assert (select cost_usd from agent_runs where id = R1) = 0.71,
    'side costs folded into the terminal write, got ' || (select cost_usd from agent_runs where id = R1);
  assert (select amount = 284 and cost_usd = 0.71 from tenant_credit_ledger where run_id = R1 and kind = 'settle'),
    'finalize trigger billed the folded cost';
  update agent_runs set status = 'success', finished_at = now(), cost_usd = 0.10
   where id = R1 and status = 'running';
  update agent_runs set cost_usd = cost_usd where id = R1;
  assert (select cost_usd from agent_runs where id = R1) = 0.71, 'fold fires once';
  assert (select count(*) from tenant_credit_ledger where run_id = R1 and kind = 'settle') = 1, 'one settle';
  select * into v_bal from tenant_credit_balances where tenant_id = A;
  assert v_bal.purchased_balance = 746 and v_bal.included_used = 20 and v_bal.daily_used = 10,
    'run 1 draw ' || row_to_json(v_bal)::text;
  assert (select debited_daily = 10 and debited_included = 20 and debited_purchased = 254
            from tenant_credit_ledger where run_id = R1 and kind = 'settle'), 'settle records its buckets';

  v_j := refund_tool_charge(A, R1, 'tc_a', 0.06);
  assert v_j->>'status' = 'refunded' and (v_j->>'credits')::int = 160 and (v_j->>'purchased')::int = 160,
    'tc_a refund ' || v_j::text;
  v_j := refund_tool_charge(A, R1, 'tc_a', 0.00);
  assert v_j->>'status' = 'already' and (v_j->>'credits')::int = 160, 'tc_a second call ' || v_j::text;
  v_j := refund_tool_charge(A, R1, 'tc_b', 0.50);
  assert v_j->>'status' = 'nothing_to_refund' and (v_j->>'credits')::int = 0, 'tc_b ' || v_j::text;
  select * into v_bal from tenant_credit_balances where tenant_id = A;
  assert v_bal.purchased_balance = 906 and v_bal.included_used = 20 and v_bal.daily_used = 10,
    'after run 1 refunds ' || row_to_json(v_bal)::text;

  assert add_run_side_cost(A, R1, 'late', 0.10, 's') = 'run_finished', 'side cost after finish';
  assert record_late_tool_charge(A, R1, 'late', null, 0.10) = 'run_finished', 'late charge after finish';
  assert (select coalesce(sum(usd), 0) from agent_run_side_costs where run_id = R1) = 0.61, 'refused cost not recorded';
  assert (select cost_usd from agent_runs where id = R1) = 0.71, 'refused cost not folded';

  perform record_late_tool_charge(B, R2, 'tc_d', null, 0.46);
  assert finalize_run_credits(R2, 0.46, 'success') = 'settled', 'run 2 settles';
  update agent_runs set status = 'success', finished_at = now() where id = R2;
  v_j := refund_tool_charge(B, R2, 'tc_d', 0);
  assert (v_j->>'credits')::int = 50 and (v_j->>'purchased')::int = 20 and (v_j->>'included')::int = 20
         and (v_j->>'daily')::int = 10, 'run 2 refund ' || v_j::text;
  select * into v_bal from tenant_credit_balances where tenant_id = B;
  assert v_bal.purchased_balance = 20 and v_bal.included_used = 0 and v_bal.daily_used = 0,
    'after run 2 ' || row_to_json(v_bal)::text;

  perform record_late_tool_charge(B, R3, 'tc_e', null, 0.46);
  assert finalize_run_credits(R3, 0.46, 'success') = 'settled', 'run 3 settles';
  v_j := refund_tool_charge(B, R3, 'tc_e', 0.40);
  assert v_j->>'status' = 'nothing_to_refund' and (v_j->>'credits')::int = 0, 'run 3 ' || v_j::text;

  perform record_late_tool_charge(A, R4, 'tc_f', null, 0.46);
  assert finalize_run_credits(R4, 0.46, 'dispatch_error') = 'refunded', 'run 4 refunds its hold';
  v_j := refund_tool_charge(A, R4, 'tc_f', 0.01);
  assert v_j->>'status' = 'nothing_to_refund', 'run 4 ' || v_j::text;
  select * into v_bal from tenant_credit_balances where tenant_id = A;
  assert v_bal.purchased_balance = 906, 'run 4 left the wallet alone ' || row_to_json(v_bal)::text;

  assert refund_tool_charge(A, R1, 'nope', 0)->>'status' = 'not_found', 'unknown tool call';

  raise notice 'tool_charge_refund_behaviour: all checks passed';
end $$;

rollback;
