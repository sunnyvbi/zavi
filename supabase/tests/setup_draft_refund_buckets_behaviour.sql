begin;
insert into tenants (id, slug, display_name, kind)
values ('00000000-0000-0000-0000-00000000dddd', 'refund-test', 'refund-test', 'test'),
       ('00000000-0000-0000-0000-00000000eeee', 'refund-other', 'refund-other', 'test');
select _credit_balance_touch('00000000-0000-0000-0000-00000000dddd');
update tenant_credit_balances set included_used = 555, purchased_balance = 0, reserved = 0
 where tenant_id = '00000000-0000-0000-0000-00000000dddd';

create temp table t_runs (name text primary key, id uuid);
insert into t_runs values
  ('today',   gen_random_uuid()), ('mixed',  gen_random_uuid()), ('stale', gen_random_uuid()),
  ('legacy',  gen_random_uuid()), ('untracked', gen_random_uuid()), ('other', gen_random_uuid());

insert into agent_runs (id, tenant_id, agent_slug, agent_definition_hash, trigger, status, cron_dedupe_key, payload)
select id, '00000000-0000-0000-0000-00000000dddd', 'cgo', 'h', 'a2a', 'success',
       'cgo:draft:00000000-0000-0000-0000-00000000dddd:setup' || case name when 'today' then '' when 'mixed' then ':2' when 'stale' then ':3' else ':x-' || name end,
       '{}'::jsonb
  from t_runs where name <> 'other';
insert into agent_runs (id, tenant_id, agent_slug, agent_definition_hash, trigger, status, cron_dedupe_key, payload)
select id, '00000000-0000-0000-0000-00000000eeee', 'cgo', 'h', 'a2a', 'success',
       'cgo:draft:00000000-0000-0000-0000-00000000eeee:setup', '{}'::jsonb
  from t_runs where name = 'other';
alter table setup_draft_admissions drop constraint if exists setup_draft_admissions_tenant_id_attempt_key;
insert into setup_draft_admissions (run_id, tenant_id, attempt)
select id, case when name = 'other' then '00000000-0000-0000-0000-00000000eeee'::uuid else '00000000-0000-0000-0000-00000000dddd'::uuid end, 1
  from t_runs;

insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, source, period_start, attempt,
                                  debited, debited_daily, debited_included, debited_purchased)
select '00000000-0000-0000-0000-00000000dddd', r.id, 'settle', v.amt, 'included', v.ps, 0,
       v.deb, v.dd, v.di, v.dp
  from t_runs r
  join (values
    ('today',     555, current_date,     555,  0, 555,    0),
    ('mixed',     300, current_date,     300,  0, 200,  100),
    ('stale',     400, current_date - 1, 400,  0, 400,    0),
    ('legacy',    100, current_date,     100,  0, 100,    0),
    ('untracked',  90, current_date,      90, null, null, null)
  ) v(name, amt, ps, deb, dd, di, dp) on v.name = r.name;

insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, source, period_start, attempt)
select '00000000-0000-0000-0000-00000000dddd', r.id, 'reserve', 100, 'included', current_date, 0
  from t_runs r where r.name <> 'other';

insert into tenant_credit_ledger (tenant_id, run_id, kind, amount, source, period_start, grant_key)
select '00000000-0000-0000-0000-00000000dddd', null, 'grant', 100, 'purchased', current_date,
       'setup-draft:' || id::text || ':0'
  from t_runs where name = 'legacy';

create or replace function pg_temp.expect(p_used int, p_purchased int, p_label text) returns void
language plpgsql as $$
declare v_u int; v_p int;
begin
  select included_used, purchased_balance into v_u, v_p
    from tenant_credit_balances where tenant_id = '00000000-0000-0000-0000-00000000dddd';
  if v_u is distinct from p_used or v_p is distinct from p_purchased then
    raise exception '%: expected included_used=% purchased=%, got included_used=% purchased=%', p_label, p_used, p_purchased, v_u, v_p;
  end if;
end $$;

do $$
declare o jsonb;
begin
  o := refund_setup_draft_settle('00000000-0000-0000-0000-00000000dddd', (select id from t_runs where name = 'today'), 0);
  if o->>'status' <> 'refunded' or (o->>'included')::int <> 555 or (o->>'purchased')::int <> 0 then
    raise exception '(a) got %', o;
  end if;
  perform pg_temp.expect(0, 0, '(a)');
end $$;

do $$
declare o jsonb;
begin
  o := refund_setup_draft_settle('00000000-0000-0000-0000-00000000dddd', (select id from t_runs where name = 'today'), 0);
  if o->>'status' <> 'already' then raise exception '(b) got %', o; end if;
  perform pg_temp.expect(0, 0, '(b)');
end $$;

update tenant_credit_balances set included_used = 200 where tenant_id = '00000000-0000-0000-0000-00000000dddd';
do $$
declare o jsonb;
begin
  o := refund_setup_draft_settle('00000000-0000-0000-0000-00000000dddd', (select id from t_runs where name = 'mixed'), 0);
  if (o->>'included')::int <> 200 or (o->>'purchased')::int <> 100 then raise exception '(c) got %', o; end if;
  perform pg_temp.expect(0, 100, '(c)');
end $$;

do $$
declare o jsonb;
begin
  o := refund_setup_draft_settle('00000000-0000-0000-0000-00000000dddd', (select id from t_runs where name = 'stale'), 0);
  if (o->>'credits')::int <> 0 or (o->>'forfeited')::int <> 400 then raise exception '(d) got %', o; end if;
  perform pg_temp.expect(0, 100, '(d)');
end $$;

do $$
declare o jsonb;
begin
  o := refund_setup_draft_settle('00000000-0000-0000-0000-00000000dddd', (select id from t_runs where name = 'legacy'), 0);
  if o->>'status' <> 'already' then raise exception '(e) got %', o; end if;
  perform pg_temp.expect(0, 100, '(e)');
end $$;

do $$
declare o jsonb;
begin
  o := refund_setup_draft_settle('00000000-0000-0000-0000-00000000dddd', (select id from t_runs where name = 'untracked'), 0);
  if o->>'status' <> 'untracked' or (o->>'credits')::int <> 0 then raise exception '(f) got %', o; end if;
  perform pg_temp.expect(0, 100, '(f)');
end $$;

do $$
declare o jsonb;
begin
  o := refund_setup_draft_settle('00000000-0000-0000-0000-00000000dddd', (select id from t_runs where name = 'other'), 0);
  if o->>'status' <> 'not_setup_draft' then raise exception '(g) got %', o; end if;
end $$;

set local role authenticated;
do $$
begin
  perform refund_setup_draft_settle('00000000-0000-0000-0000-00000000dddd', (select id from t_runs where name = 'today'), 0);
  raise exception '(h) authenticated could call it';
exception when insufficient_privilege then null;
end $$;
reset role;

do $$ begin raise notice 'setup_draft_refund_buckets_behaviour: all expectations held'; end $$;
rollback;
