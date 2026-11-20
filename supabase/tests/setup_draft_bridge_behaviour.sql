begin;
insert into tenants (id, slug, display_name, kind)
values ('00000000-0000-0000-0000-00000000cccc', 'bridge-test', 'bridge-test', 'test');
insert into tenant_subscriptions (tenant_id, plan, status, monthly_credits)
values ('00000000-0000-0000-0000-00000000cccc', 'team', 'active', 0);
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c2', 'member@bridge.test');
insert into tenant_users (tenant_id, user_id, role)
values ('00000000-0000-0000-0000-00000000cccc', '00000000-0000-0000-0000-0000000000c2', 'member');
update system_config
   set blob = jsonb_set(coalesce(blob, '{}'::jsonb), '{credits_enforced_allowlist}',
                        '["00000000-0000-0000-0000-00000000cccc"]'::jsonb)
             || '{"free_daily_credits": 0}'::jsonb
 where id = 1;
select _credit_balance_touch('00000000-0000-0000-0000-00000000cccc');
update tenant_credit_balances set purchased_balance = 50, reserved = 0
 where tenant_id = '00000000-0000-0000-0000-00000000cccc';

create temp table t_ids (name text primary key, id uuid);

create or replace function pg_temp.expect_balance(p_purchased int, p_reserved int, p_label text) returns void
language plpgsql as $$
declare v_p int; v_r int;
begin
  select purchased_balance, reserved into v_p, v_r
    from tenant_credit_balances where tenant_id = '00000000-0000-0000-0000-00000000cccc';
  if v_p is distinct from p_purchased or v_r is distinct from p_reserved then
    raise exception '%: expected purchased=% reserved=%, got purchased=% reserved=%', p_label, p_purchased, p_reserved, v_p, v_r;
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c2"}', true);
do $$
declare k text;
begin
  foreach k in array array[
    'cgo:draft:00000000-0000-0000-0000-00000000cccc:setup',
    'cgo:draft:00000000-0000-0000-0000-00000000cccc:setup:2',
    'cgo:draft:00000000-0000-0000-0000-00000000cccc:setup:paid:4'] loop
    begin
      perform enqueue_agent_run('00000000-0000-0000-0000-00000000cccc', 'cgo', 'h', 'a2a', '{}'::jsonb, k);
      raise exception 'member squatted %', k;
    exception when others then
      if sqlerrm <> 'reserved dedupe key' then raise; end if;
    end;
  end loop;
end $$;
reset role;
select set_config('request.jwt.claims', '{}', true);
do $$ begin
  if auth.uid() is not null then raise exception 'claims not cleared: auth.uid() = %', auth.uid(); end if;
end $$;

do $$ begin
  perform enqueue_agent_run('00000000-0000-0000-0000-00000000cccc', 'cgo', 'h', 'a2a', '{}'::jsonb, 'cgo:draft:x:2026-09-24');
  raise exception 'non-setup run was admitted';
exception when others then
  if sqlerrm <> 'insufficient_credits' then raise; end if;
end $$;

do $$ begin
  perform enqueue_setup_draft('00000000-0000-0000-0000-00000000cccc', 'h', '{"stage":"draft_strategy","origin":"setup_draft"}'::jsonb, 4);
  raise exception 'attempt 4 was admitted';
exception when others then
  if sqlerrm not like 'enqueue_setup_draft: tenant and attempt 1-3 required%' then raise; end if;
end $$;
do $$ begin
  perform enqueue_setup_draft('00000000-0000-0000-0000-00000000cccc', 'h', '{"stage":"anything","origin":"setup_draft"}'::jsonb, 1);
  raise exception 'foreign payload was bridged';
exception when others then
  if sqlerrm not like 'enqueue_setup_draft: not a setup draft payload%' then raise; end if;
end $$;

create or replace function pg_temp._test_fail_insert() returns trigger language plpgsql as $$
begin raise exception 'forced failure'; end $$;
create trigger _test_fail before insert on agent_runs for each row execute function pg_temp._test_fail_insert();
do $$ begin
  perform enqueue_setup_draft('00000000-0000-0000-0000-00000000cccc', 'h', '{"stage":"draft_strategy","origin":"setup_draft"}'::jsonb, 1);
  raise exception 'forced failure did not fire';
exception when others then
  if sqlerrm <> 'forced failure' then raise; end if;
end $$;
drop trigger _test_fail on agent_runs;
select pg_temp.expect_balance(50, 0, '(d) after a failed enqueue');
do $$ begin
  if exists (select 1 from setup_draft_admissions where tenant_id = '00000000-0000-0000-0000-00000000cccc') then
    raise exception '(d) an admission survived a failed enqueue';
  end if;
end $$;

insert into t_ids select 'run', enqueue_setup_draft('00000000-0000-0000-0000-00000000cccc', 'h', '{"stage":"draft_strategy","origin":"setup_draft"}'::jsonb, 1);
do $$
declare v_est int := _reserve_estimate_for('cgo');
begin
  perform pg_temp.expect_balance(50, v_est, '(e) after the bridged enqueue');
  if not exists (select 1 from setup_draft_admissions where run_id = (select id from t_ids where name = 'run') and attempt = 1 and bridged = v_est - 50) then
    raise exception '(e) admission missing or wrong bridged amount';
  end if;
  if (select count(*) from setup_draft_resolve_run((select id from t_ids where name = 'run'))) <> 1 then
    raise exception '(e) the resolver does not find the admitted run';
  end if;
end $$;

update tenant_credit_balances set purchased_balance = 10000 where tenant_id = '00000000-0000-0000-0000-00000000cccc';
insert into t_ids select 'fake', enqueue_agent_run('00000000-0000-0000-0000-00000000cccc', 'cgo', 'h', 'a2a', '{}'::jsonb,
                         'cgo:draft:00000000-0000-0000-0000-00000000cccc:setup:2');
do $$ begin
  if (select count(*) from setup_draft_resolve_run((select id from t_ids where name = 'fake'))) <> 0 then
    raise exception '(f) a lookalike (not admitted) resolved as a setup draft';
  end if;
end $$;
update tenant_credit_balances set purchased_balance = 50 where tenant_id = '00000000-0000-0000-0000-00000000cccc';

select finalize_run_credits((select id from t_ids where name = 'run'), 0.5, 'success');
do $$ begin
  if not exists (select 1 from tenant_credit_ledger where run_id = (select id from t_ids where name = 'run') and kind = 'settle' and attempt = 0
                  and amount = 200 and debited = 50) then
    raise exception '(g) expected settle amount=200 debited=50, got %',
      (select row(amount, debited) from tenant_credit_ledger where run_id = (select id from t_ids where name = 'run') and kind = 'settle' and attempt = 0);
  end if;
end $$;

update tenant_credit_balances set purchased_balance = 500, reserved = 0 where tenant_id = '00000000-0000-0000-0000-00000000cccc';
select reserve_run_credits('00000000-0000-0000-0000-00000000cccc', (select id from t_ids where name = 'run'), 'cgo', _reserve_estimate_for('cgo'), 1);
select finalize_run_credits((select id from t_ids where name = 'run'), 0.1, 'success');
do $$ begin
  if not exists (select 1 from tenant_credit_ledger where run_id = (select id from t_ids where name = 'run') and kind = 'settle' and attempt = 1
                  and amount = 40 and debited = 40) then
    raise exception '(h) expected attempt-1 settle amount=40 debited=40';
  end if;
end $$;
select grant_promo_credits('00000000-0000-0000-0000-00000000cccc', debited, 'Welcome setup: the first strategy is on Zavi',
                           'setup-draft:' || run_id || ':' || attempt, 'system:setup-draft')
  from tenant_credit_ledger where run_id = (select id from t_ids where name = 'run') and kind = 'settle';
select grant_promo_credits('00000000-0000-0000-0000-00000000cccc', debited, 'replay',
                           'setup-draft:' || run_id || ':' || attempt, 'system:setup-draft')
  from tenant_credit_ledger where run_id = (select id from t_ids where name = 'run') and kind = 'settle';
do $$ begin
  if (select coalesce(sum(amount), 0) from tenant_credit_ledger
       where kind = 'grant' and grant_key like 'setup-draft:' || (select id from t_ids where name = 'run')::text || ':%') <> 90 then
    raise exception '(h) expected the refund total 50 + 40 = 90 (granted once), got %',
      (select sum(amount) from tenant_credit_ledger where kind = 'grant' and grant_key like 'setup-draft:' || (select id from t_ids where name = 'run')::text || ':%');
  end if;
end $$;
rollback;
