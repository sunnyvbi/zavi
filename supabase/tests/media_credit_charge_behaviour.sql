
begin;

insert into tenants (id, slug, display_name, kind)
values ('00000000-0000-0000-0000-00000000aaaa', 'media-test', 'media-test', 'test');

insert into tenant_subscriptions (tenant_id, plan, status, monthly_credits)
values ('00000000-0000-0000-0000-00000000aaaa', 'team', 'active', 20);

update system_config
   set blob = jsonb_set(coalesce(blob, '{}'::jsonb),
                        '{credits_enforced_allowlist}',
                        '["00000000-0000-0000-0000-00000000aaaa"]'::jsonb)
             || '{"free_daily_credits": 10}'::jsonb
 where id = 1;

select _credit_balance_touch('00000000-0000-0000-0000-00000000aaaa');
update tenant_credit_balances set purchased_balance = 5, reserved = 0
 where tenant_id = '00000000-0000-0000-0000-00000000aaaa';

select 'fixture' as step, included_allowance, included_used, daily_allowance, daily_used, purchased_balance, reserved
  from tenant_credit_balances where tenant_id = '00000000-0000-0000-0000-00000000aaaa';

do $$ begin
  assert media_credits_affordable('00000000-0000-0000-0000-00000000aaaa', 0.0875) = true,  'afford 35';
  assert media_credits_affordable('00000000-0000-0000-0000-00000000aaaa', 0.09)   = false, 'cannot afford 36';
  assert media_credits_affordable('00000000-0000-0000-0000-00000000aaaa', 0)      = true,  'zero cost is free';
end $$;

do $$ begin
  assert charge_media_credits('00000000-0000-0000-0000-00000000aaaa', 'k1', 0.075, 'image.photo', 'm', null) = 'charged', 'first charge';
  assert charge_media_credits('00000000-0000-0000-0000-00000000aaaa', 'k1', 0.075, 'image.photo', 'm', null) = 'already', 'idempotent';
end $$;
select 'draw-order' as step, daily_used, included_used, purchased_balance
  from tenant_credit_balances where tenant_id = '00000000-0000-0000-0000-00000000aaaa';
select 'ledger' as step, count(*) as media_rows, max(amount) as amount, max(source) as source
  from tenant_credit_ledger
 where tenant_id = '00000000-0000-0000-0000-00000000aaaa' and kind = 'media';

select charge_media_credits('00000000-0000-0000-0000-00000000aaaa', 'k2', 0.25, 'video.broll', 'm', null) as overrun;
select 'overrun' as step, purchased_balance
  from tenant_credit_balances where tenant_id = '00000000-0000-0000-0000-00000000aaaa';

update tenant_credit_balances set purchased_balance = -50
 where tenant_id = '00000000-0000-0000-0000-00000000aaaa';
select charge_media_credits('00000000-0000-0000-0000-00000000aaaa', 'k3', 0.25, 'video.broll', 'm', null) as on_debt;
select 'debt' as step, purchased_balance
  from tenant_credit_balances where tenant_id = '00000000-0000-0000-0000-00000000aaaa';

do $$ begin
  assert charge_media_credits('00000000-0000-0000-0000-00000000aaaa', 'k4', 0, 'image.photo', 'm', null) = 'zero', 'zero cost';
end $$;

insert into tenants (id, slug, display_name, kind)
values ('00000000-0000-0000-0000-00000000bbbb', 'media-test-2', 'media-test-2', 'test');
insert into agent_runs (id, tenant_id, agent_slug, agent_definition_hash, trigger, status)
values ('00000000-0000-0000-0000-00000000cccc', '00000000-0000-0000-0000-00000000bbbb', 'engineer', 'x', 'manual', 'queued');
do $$
declare v_ok boolean := false;
begin
  begin
    perform charge_media_credits('00000000-0000-0000-0000-00000000aaaa', 'k5', 0.06, 'image.photo', 'm',
                                 '00000000-0000-0000-0000-00000000cccc');
  exception when others then
    assert sqlerrm like '%tenant_mismatch%', 'expected tenant_mismatch, got: ' || sqlerrm;
    v_ok := true;
  end;
  assert v_ok, 'cross-tenant run_id must raise';
end $$;

update system_config
   set blob = jsonb_set(blob, '{credits_enforced_allowlist}', '[]'::jsonb)
 where id = 1;
do $$ begin
  assert charge_media_credits('00000000-0000-0000-0000-00000000aaaa', 'k6', 0.06, 'image.photo', 'm', null) = 'not_enforced', 'not enforced';
  assert media_credits_affordable('00000000-0000-0000-0000-00000000aaaa', 999) = true, 'not enforced affords anything';
end $$;

rollback;
