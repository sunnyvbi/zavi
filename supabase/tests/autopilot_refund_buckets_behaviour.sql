begin;
insert into tenants (id, slug, display_name, kind)
values ('00000000-0000-0000-0000-0000000000a9', 'ap-refund-gen', 'ap-refund-gen', 'test');
insert into agent_runs (id, tenant_id, agent_slug, agent_definition_hash, trigger, status, payload)
values ('00000000-0000-0000-0000-00000000a9a9', '00000000-0000-0000-0000-0000000000a9', 'cgo', 'h', 'a2a', 'running', '{}'::jsonb);
do $$ declare g0 bigint; g1 bigint; g2 bigint; r record; begin
  perform _credit_balance_touch('00000000-0000-0000-0000-0000000000a9');
  select included_gen into g0 from tenant_credit_balances where tenant_id = '00000000-0000-0000-0000-0000000000a9';
  perform _credit_balance_touch('00000000-0000-0000-0000-0000000000a9');
  select included_gen into g1 from tenant_credit_balances where tenant_id = '00000000-0000-0000-0000-0000000000a9';
  if g1 <> g0 then raise exception '(0a) a touch with no reset changed the generation: % -> %', g0, g1; end if;
  update tenant_credit_balances set included_used = 7, period_end = current_date
   where tenant_id = '00000000-0000-0000-0000-0000000000a9';
  perform _credit_balance_touch('00000000-0000-0000-0000-0000000000a9');
  select included_gen into g2 from tenant_credit_balances where tenant_id = '00000000-0000-0000-0000-0000000000a9';
  if g2 <> g0 + 1 then raise exception '(0b) a reset did not start a new generation: % -> %', g0, g2; end if;
  perform reserve_run_credits('00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-00000000a9a9', 'cgo', 1, 0);
  perform finalize_run_credits('00000000-0000-0000-0000-00000000a9a9', 0.0025, 'success');
  select l.included_gen, l.daily_gen, b.included_gen as b_ig, b.daily_gen as b_dg into r
    from tenant_credit_ledger l join tenant_credit_balances b on b.tenant_id = l.tenant_id
   where l.run_id = '00000000-0000-0000-0000-00000000a9a9' and l.kind = 'settle';
  if r.included_gen is distinct from r.b_ig or r.daily_gen is distinct from r.b_dg then
    raise exception '(0c) settle generations % / % vs wallet % / %', r.included_gen, r.daily_gen, r.b_ig, r.b_dg;
  end if;
end $$;

create or replace function _credit_balance_touch(p_tenant_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into tenant_credit_balances (tenant_id, period_start, period_end)
  values (p_tenant_id, date_trunc('month', current_date)::date, (date_trunc('month', current_date) + interval '1 month')::date)
  on conflict (tenant_id) do nothing;
  perform 1 from tenant_credit_balances where tenant_id = p_tenant_id for update;
end $$;

insert into tenants (id, slug, display_name, kind) values
  ('00000000-0000-0000-0000-0000000000a1', 'ap-refund-a', 'ap-refund-a', 'test'),
  ('00000000-0000-0000-0000-0000000000b1', 'ap-refund-b', 'ap-refund-b', 'test'),
  ('00000000-0000-0000-0000-0000000000c1', 'ap-refund-c', 'ap-refund-c', 'test'),
  ('00000000-0000-0000-0000-0000000000d1', 'ap-refund-d', 'ap-refund-d', 'test');
select _credit_balance_touch(t) from unnest(array[
  '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1']::uuid[]) t;
update tenant_credit_balances
   set period_start = current_date, period_end = current_date + 30,
       included_used = 300, daily_allowance = 1000, daily_used = 0, daily_period_end = current_date + 1,
       purchased_balance = 0, reserved = 0
 where tenant_id = '00000000-0000-0000-0000-0000000000d1';
update tenant_credit_balances
   set period_start = current_date - 5, period_end = current_date + 25,
       included_used = 1000, daily_allowance = 1000, daily_used = 500,
       daily_period_end = current_date + 1, purchased_balance = 0, reserved = 0
 where tenant_id = '00000000-0000-0000-0000-0000000000a1';
update tenant_credit_balances
   set period_start = current_date, period_end = current_date + 1,
       included_used = 555, daily_allowance = 0, daily_used = 0, daily_period_end = null,
       purchased_balance = 0, reserved = 0
 where tenant_id = '00000000-0000-0000-0000-0000000000b1';

create temp table t_runs (name text primary key, id uuid, tenant uuid);
insert into t_runs values
  ('daily',     gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1'),
  ('monthly',   gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1'),
  ('purchased', gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1'),
  ('midnight',  gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1'),
  ('retried',   gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1'),
  ('untracked', gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1'),
  ('overstated',gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1'),
  ('legacy',    gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1'),
  ('pending',   gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1'),
  ('draft',     gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1'),
  ('free',      gen_random_uuid(), '00000000-0000-0000-0000-0000000000b1'),
  ('nodebit',   gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1'),
  ('sameday',   gen_random_uuid(), '00000000-0000-0000-0000-0000000000d1'),
  ('other',     gen_random_uuid(), '00000000-0000-0000-0000-0000000000c1');
insert into agent_runs (id, tenant_id, agent_slug, agent_definition_hash, trigger, status, payload)
select id, tenant, 'cgo', 'h', 'a2a', 'success', '{}'::jsonb from t_runs;

insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, source, period_start, attempt, created_at)
select r.tenant, r.id, 'reserve', 100, 'included', date_trunc('month', current_date)::date, a.att,
       case when r.name = 'midnight' then now() - interval '1 day' else now() end
  from t_runs r
  cross join lateral (select unnest(case when r.name = 'retried' then array[0, 1] else array[0] end) att) a;

insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, source, period_start, attempt,
                                  debited, debited_daily, debited_included, debited_purchased)
select r.tenant, r.id, 'settle', v.deb, 'included', v.ps, v.att,
       case when r.name = 'nodebit' then null else v.deb end, v.dd, v.di, v.dp
  from t_runs r
  join (values
    ('daily',      0, 300, 300,    0,    0, current_date - 5),
    ('monthly',    0, 200,   0,  200,    0, current_date - 5),
    ('purchased',  0, 150,   0,    0,  150, current_date - 5),
    ('midnight',   0, 100, 100,    0,    0, current_date - 5),
    ('retried',    0,  50,  50,    0,    0, current_date - 5),
    ('retried',    1,  70,   0,    0,   70, current_date - 5),
    ('untracked',  0,  90, null, null, null, current_date - 5),
    ('overstated', 0,  10,  20,   20,    0, current_date - 5),
    ('legacy',     0,  60,  60,    0,    0, current_date - 5),
    ('draft',      0,  40,   0,   40,    0, current_date - 5),
    ('free',       0, 555,   0,  555,    0, current_date),
    ('nodebit',    0,  30,  30,    0,    0, current_date - 5),
    ('sameday',    0, 100,   0,  100,    0, current_date),
    ('other',      0,  80,   0,   80,    0, current_date - 5)
  ) v(name, att, deb, dd, di, dp, ps) on v.name = r.name;

insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, source, period_start, grant_key)
select tenant, null, 'grant', 60, 'purchased', current_date, 'autopilot-guarantee:' || id::text
  from t_runs where name = 'legacy';
insert into setup_draft_admissions (run_id, tenant_id, attempt)
select id, tenant, 1 from t_runs where name = 'draft';

create or replace function pg_temp.expect(p_tenant uuid, p_daily int, p_incl int, p_purch int, p_label text) returns void
language plpgsql as $$
declare v_d int; v_i int; v_p int;
begin
  select daily_used, included_used, purchased_balance into v_d, v_i, v_p
    from tenant_credit_balances where tenant_id = p_tenant;
  if v_d is distinct from p_daily or v_i is distinct from p_incl or v_p is distinct from p_purch then
    raise exception '%: expected daily_used=% included_used=% purchased=%, got % % %',
      p_label, p_daily, p_incl, p_purch, v_d, v_i, v_p;
  end if;
end $$;
create or replace function pg_temp.claim(p_name text) returns jsonb language sql as $$
  select refund_autopilot_run((select tenant from t_runs where name = p_name), (select id from t_runs where name = p_name));
$$;

do $$ declare o jsonb; begin
  o := pg_temp.claim('daily');
  if o->>'status' <> 'refunded' or (o->>'daily')::int <> 300 or (o->>'purchased')::int <> 0 then raise exception '(1) got %', o; end if;
  perform pg_temp.expect('00000000-0000-0000-0000-0000000000a1', 200, 1000, 0, '(1)');
end $$;

do $$ declare o jsonb; begin
  o := pg_temp.claim('daily');
  if o->>'status' <> 'already_refunded' or (o->>'credits')::int <> 0 then raise exception '(2) got %', o; end if;
  perform pg_temp.expect('00000000-0000-0000-0000-0000000000a1', 200, 1000, 0, '(2)');
end $$;

do $$ declare o jsonb; begin
  o := pg_temp.claim('monthly');
  if o->>'status' <> 'refunded' or (o->>'included')::int <> 200 then raise exception '(3) got %', o; end if;
  perform pg_temp.expect('00000000-0000-0000-0000-0000000000a1', 200, 800, 0, '(3)');
end $$;

do $$ declare o jsonb; begin
  o := pg_temp.claim('purchased');
  if o->>'status' <> 'refunded' or (o->>'purchased')::int <> 150 then raise exception '(4) got %', o; end if;
  perform pg_temp.expect('00000000-0000-0000-0000-0000000000a1', 200, 800, 150, '(4)');
end $$;

do $$ declare o jsonb; begin
  o := pg_temp.claim('midnight');
  if o->>'status' <> 'expired' or (o->>'credits')::int <> 0 or (o->>'forfeited')::int <> 100 then raise exception '(5) got %', o; end if;
  perform pg_temp.expect('00000000-0000-0000-0000-0000000000a1', 200, 800, 150, '(5)');
end $$;

do $$ declare o jsonb; begin
  o := pg_temp.claim('retried');
  if o->>'status' <> 'refunded' or (o->>'credits')::int <> 120 or (o->>'daily')::int <> 50 or (o->>'purchased')::int <> 70 then
    raise exception '(6) got %', o;
  end if;
  perform pg_temp.expect('00000000-0000-0000-0000-0000000000a1', 150, 800, 220, '(6)');
end $$;

do $$ declare o jsonb; begin
  o := pg_temp.claim('untracked');
  if o->>'status' <> 'untracked' or (o->>'credits')::int <> 0 or (o->>'untracked')::int <> 90 then raise exception '(7) got %', o; end if;
  perform pg_temp.expect('00000000-0000-0000-0000-0000000000a1', 150, 800, 220, '(7)');
end $$;

do $$ declare o jsonb; begin
  o := pg_temp.claim('overstated');
  if o->>'status' <> 'untracked' or (o->>'credits')::int <> 0 then raise exception '(8) got %', o; end if;
  perform pg_temp.expect('00000000-0000-0000-0000-0000000000a1', 150, 800, 220, '(8)');
end $$;

do $$ declare o jsonb; begin
  o := pg_temp.claim('legacy');
  if o->>'status' <> 'already_refunded' then raise exception '(9) got %', o; end if;
  perform pg_temp.expect('00000000-0000-0000-0000-0000000000a1', 150, 800, 220, '(9)');
end $$;

do $$ declare o jsonb; begin
  o := pg_temp.claim('pending');
  if o->>'status' <> 'pending' then raise exception '(10) got %', o; end if;
end $$;

do $$ declare o jsonb; begin
  o := refund_setup_draft_settle('00000000-0000-0000-0000-0000000000a1', (select id from t_runs where name = 'draft'), 0);
  if o->>'status' <> 'refunded' or (o->>'included')::int <> 40 then raise exception '(11a) got %', o; end if;
  o := pg_temp.claim('draft');
  if o->>'status' <> 'already_refunded' then raise exception '(11b) got %', o; end if;
  perform pg_temp.expect('00000000-0000-0000-0000-0000000000a1', 150, 760, 220, '(11)');
end $$;

do $$ declare o jsonb; begin
  o := pg_temp.claim('free');
  if o->>'status' <> 'refunded' or (o->>'included')::int <> 555 or (o->>'purchased')::int <> 0 then raise exception '(12) got %', o; end if;
  perform pg_temp.expect('00000000-0000-0000-0000-0000000000b1', 0, 0, 0, '(12)');
end $$;

do $$ declare o jsonb; begin
  o := pg_temp.claim('sameday');
  if o->>'status' <> 'expired' or (o->>'forfeited')::int <> 100 then raise exception '(16) got %', o; end if;
  perform pg_temp.expect('00000000-0000-0000-0000-0000000000d1', 0, 300, 0, '(16)');
end $$;

do $$ declare o jsonb; begin
  o := pg_temp.claim('nodebit');
  if o->>'status' <> 'untracked' or (o->>'credits')::int <> 0 then raise exception '(17) got %', o; end if;
  perform pg_temp.expect('00000000-0000-0000-0000-0000000000a1', 150, 760, 220, '(17)');
end $$;

do $$ declare o jsonb; begin
  o := pg_temp.claim('untracked');
  if o->>'status' <> 'already_claimed' then raise exception '(18a) got %', o; end if;
  o := pg_temp.claim('midnight');
  if o->>'status' <> 'already_claimed' then raise exception '(18b) got %', o; end if;
  o := pg_temp.claim('monthly');
  if o->>'status' <> 'already_refunded' then raise exception '(18c) got %', o; end if;
  o := pg_temp.claim('retried');
  if o->>'status' <> 'already_refunded' then raise exception '(18d) got %', o; end if;
end $$;

insert into tenants (id, slug, display_name, kind) values
  ('00000000-0000-0000-0000-0000000000e1', 'ap-refund-e', 'ap-refund-e', 'test'),
  ('00000000-0000-0000-0000-0000000000f1', 'ap-refund-f', 'ap-refund-f', 'test'),
  ('00000000-0000-0000-0000-0000000000a2', 'ap-refund-g', 'ap-refund-g', 'test'),
  ('00000000-0000-0000-0000-0000000000a3', 'ap-refund-h', 'ap-refund-h', 'test');
select _credit_balance_touch(t) from unnest(array[
  '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1',
  '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3']::uuid[]) t;
update tenant_credit_balances
   set period_start = current_date, period_end = current_date + 30, included_used = 400,
       daily_allowance = 1000, daily_used = 200, daily_period_end = current_date + 1,
       purchased_balance = 0, reserved = 0, included_gen = 7, daily_gen = 7
 where tenant_id in ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a2',
                     '00000000-0000-0000-0000-0000000000a3');
update tenant_credit_balances
   set period_start = current_date, period_end = current_date + 1, included_used = 50,
       daily_allowance = 0, daily_used = 0, daily_period_end = null,
       purchased_balance = 0, reserved = 0, included_gen = 8, daily_gen = 8
 where tenant_id = '00000000-0000-0000-0000-0000000000f1';
update tenant_credit_balances set included_gen = 5, daily_gen = 5
 where tenant_id = '00000000-0000-0000-0000-0000000000a1';

create temp table t_new (name text primary key, id uuid, tenant uuid, res_at timestamptz,
                         set_ps date, ig bigint, dg bigint, dd int, di int, dp int);
insert into t_new values
  ('billday',   gen_random_uuid(), '00000000-0000-0000-0000-0000000000e1', now(), current_date, 7, 7, 100, 200, 0),
  ('downgrade', gen_random_uuid(), '00000000-0000-0000-0000-0000000000f1', now(), current_date, 7, 7, 100, 200, 0),
  ('upgrade',   gen_random_uuid(), '00000000-0000-0000-0000-0000000000a2', now(), current_date, 6, 6, 0, 150, 0),
  ('roundtrip', gen_random_uuid(), '00000000-0000-0000-0000-0000000000a3', now(), current_date, 5, 5, 50, 80, 0),
  ('midnight2', gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', now() - interval '1 day', current_date - 5, 5, 4, 40, 60, 0),
  ('rolled',    gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', now() - interval '1 day', current_date - 40, 5, 5, 10, 20, 0);
insert into agent_runs (id, tenant_id, agent_slug, agent_definition_hash, trigger, status, payload)
select id, tenant, 'cgo', 'h', 'a2a', 'success', '{}'::jsonb from t_new;
insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, source, period_start, attempt, created_at)
select tenant, id, 'reserve', 100, 'included', set_ps, 0, res_at from t_new;
insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, source, period_start, attempt,
                                  debited, debited_daily, debited_included, debited_purchased, included_gen, daily_gen)
select tenant, id, 'settle', dd + di + dp, 'included', set_ps, 0, dd + di + dp, dd, di, dp, ig, dg from t_new;
create or replace function pg_temp.claim_new(p_name text) returns jsonb language sql as $$
  select refund_autopilot_run((select tenant from t_new where name = p_name), (select id from t_new where name = p_name));
$$;

do $$ declare o jsonb; begin
  o := pg_temp.claim_new('billday');
  if o->>'status' <> 'refunded' or (o->>'included')::int <> 200 or (o->>'daily')::int <> 100
     or (o->>'forfeited')::int <> 0 then raise exception '(19) got %', o; end if;
  perform pg_temp.expect('00000000-0000-0000-0000-0000000000e1', 100, 200, 0, '(19)');
end $$;

do $$ declare o jsonb; begin
  o := pg_temp.claim_new('downgrade');
  if o->>'status' <> 'expired' or (o->>'credits')::int <> 0 or (o->>'forfeited')::int <> 300 then raise exception '(20) got %', o; end if;
  perform pg_temp.expect('00000000-0000-0000-0000-0000000000f1', 0, 50, 0, '(20)');
end $$;

do $$ declare o jsonb; begin
  o := pg_temp.claim_new('upgrade');
  if o->>'status' <> 'expired' or (o->>'forfeited')::int <> 150 then raise exception '(21) got %', o; end if;
  perform pg_temp.expect('00000000-0000-0000-0000-0000000000a2', 200, 400, 0, '(21)');
end $$;

do $$ declare o jsonb; begin
  o := pg_temp.claim_new('roundtrip');
  if o->>'status' <> 'expired' or (o->>'forfeited')::int <> 130 then raise exception '(22) got %', o; end if;
  perform pg_temp.expect('00000000-0000-0000-0000-0000000000a3', 200, 400, 0, '(22)');
end $$;

do $$ declare o jsonb; begin
  o := pg_temp.claim_new('midnight2');
  if o->>'status' <> 'refunded' or (o->>'included')::int <> 60 or (o->>'daily')::int <> 0
     or (o->>'forfeited')::int <> 40 then raise exception '(23) got %', o; end if;
  perform pg_temp.expect('00000000-0000-0000-0000-0000000000a1', 150, 700, 220, '(23)');
end $$;

do $$ declare o jsonb; begin
  o := pg_temp.claim_new('rolled');
  if o->>'status' <> 'refunded' or (o->>'credits')::int <> 30 or (o->>'forfeited')::int <> 0 then raise exception '(24) got %', o; end if;
  perform pg_temp.expect('00000000-0000-0000-0000-0000000000a1', 140, 680, 220, '(24)');
end $$;

do $$ declare o jsonb; begin
  o := refund_autopilot_run('00000000-0000-0000-0000-0000000000a1', (select id from t_runs where name = 'other'));
  if o->>'status' <> 'no_run' then raise exception '(13) got %', o; end if;
end $$;

do $$ begin
  if (select count(*) from admin_action_log where staff_email = 'system:autopilot-guarantee'
        and tenant_id = '00000000-0000-0000-0000-0000000000a1' and action = 'credit_refund') <> 10 then
    raise exception '(14) wrong log count';
  end if;
  if exists (select 1 from tenant_credit_ledger l join t_runs r on 'autopilot-guarantee:' || r.id::text = l.grant_key
              where r.name <> 'legacy') then
    raise exception '(14) a purchased grant was minted';
  end if;
end $$;

set local role authenticated;
do $$ begin
  perform refund_autopilot_run('00000000-0000-0000-0000-0000000000a1', gen_random_uuid());
  raise exception '(15) authenticated could call it';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform _refund_settle_to_source_buckets('00000000-0000-0000-0000-0000000000a1', gen_random_uuid(), 0, 'setup_draft');
  raise exception '(15) authenticated could call the helper';
exception when insufficient_privilege then null;
end $$;
reset role;

do $$ begin raise notice 'autopilot_refund_buckets_behaviour: all expectations held'; end $$;
rollback;
