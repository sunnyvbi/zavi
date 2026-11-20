#!/usr/bin/env bash
set -euo pipefail
PGBIN="${PGBIN:-/opt/homebrew/bin}"
PGDATA="$(mktemp -d)/pg"; PORT="${PORT:-54329}"; SOCK="$(mktemp -d)"
MIG="$(cd "$(dirname "$0")/../../.." && pwd)/supabase/migrations/20260906210000_paid_keeps_daily_credit_grant.sql"
[ -f "$MIG" ] || { echo "migration not found: $MIG"; exit 1; }
cleanup(){ "$PGBIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-p $PORT -k $SOCK" -l "$PGDATA/log" start >/dev/null
sleep 2
P=("$PGBIN/psql" -h "$SOCK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)

"${P[@]}" >/dev/null <<'SQL'
create extension if not exists pgcrypto;
create role anon; create role authenticated; create role service_role;
create table tenants (id uuid primary key default gen_random_uuid(), credits_unlimited boolean not null default false);
create table tenant_subscriptions (tenant_id uuid primary key references tenants(id), plan text not null default 'free', monthly_credits int, grandfathered boolean not null default false);
create table system_config (id int primary key, blob jsonb);
insert into system_config values (1, '{"free_daily_credits": 5000}'::jsonb);
create table tenant_credit_balances (tenant_id uuid primary key references tenants(id),
  period_start date not null, period_end date not null,
  included_allowance int not null default 0, included_used int not null default 0,
  purchased_balance int not null default 0, reserved int not null default 0,
  updated_at timestamptz not null default now());
create table tenant_credit_ledger (id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id), run_id uuid,
  kind text not null check (kind in ('reserve','settle','refund','topup')), amount int not null,
  source text not null default 'included' check (source in ('included','purchased','mixed','stripe')),
  agent_slug text, cost_usd numeric(12,6), period_start date not null, attempt int not null default 0,
  created_at timestamptz not null default now());
create unique index on tenant_credit_ledger (run_id, attempt) where kind = 'reserve';
create unique index on tenant_credit_ledger (run_id, attempt) where kind in ('settle','refund');
create function _free_daily_credits() returns int language sql stable as $$ select coalesce(nullif((select blob->>'free_daily_credits' from system_config where id=1),'')::int, 2000); $$;
create function _is_free_daily_tenant(p uuid) returns boolean language sql stable as $$ select coalesce((select not s.grandfathered and s.monthly_credits is null and s.plan='free' from tenant_subscriptions s where s.tenant_id=p), true); $$;
create function _credit_allowance_for_tenant(p uuid) returns int language sql stable as $$ select case when s.grandfathered then 250000 when s.monthly_credits is not null then s.monthly_credits when s.plan='solo' then 20000 when s.plan='team' then 80000 when s.plan='full' then 300000 when s.plan='enterprise' then 20000000 else _free_daily_credits() end from (select 1) one left join tenant_subscriptions s on s.tenant_id=p; $$;
create function _credits_unlimited(p uuid) returns boolean language sql stable as $$ select coalesce((select credits_unlimited from tenants where id=p), false); $$;
SQL

"${P[@]}" -f "$MIG" >/dev/null
echo "migration applied"

"${P[@]}" <<'SQL'
\set F '11111111-1111-1111-1111-111111111111'
\set P '22222222-2222-2222-2222-222222222222'
insert into tenants (id) values (:'F'),(:'P');
insert into tenant_subscriptions (tenant_id, plan, monthly_credits) values (:'P','free',20000);
select _credit_balance_touch(:'F'::uuid); select _credit_balance_touch(:'P'::uuid);

select case when
  (select (included_allowance-included_used)+greatest(daily_allowance-daily_used,0)+purchased_balance-reserved from tenant_credit_balances where tenant_id=:'P')
  >
  (select (included_allowance-included_used)+greatest(daily_allowance-daily_used,0)+purchased_balance-reserved from tenant_credit_balances where tenant_id=:'F')
  then 'PASS: paid > free' else 'FAIL: paid <= free' end as t1;

select case when (select daily_allowance from tenant_credit_balances where tenant_id=:'F')=0
  then 'PASS: free unchanged' else 'FAIL: free got a second pool' end as t2;

select reserve_run_credits(:'P'::uuid,'aaaaaaaa-0000-0000-0000-000000000001'::uuid,'x',400,0);
select finalize_run_credits('aaaaaaaa-0000-0000-0000-000000000001'::uuid,1.00,'success');
select case when (select daily_used from tenant_credit_balances where tenant_id=:'P')=400
             and (select included_used from tenant_credit_balances where tenant_id=:'P')=0
  then 'PASS: daily spent first' else 'FAIL: wrong debit order' end as t3;

update tenant_credit_balances set daily_period_end=current_date where tenant_id=:'P';
select _credit_balance_touch(:'P'::uuid);
select case when (select daily_used from tenant_credit_balances where tenant_id=:'P')=0
  then 'PASS: daily reset on roll' else 'FAIL: daily did not reset' end as t4;

do $$ begin
  begin
    perform reserve_run_credits('11111111-1111-1111-1111-111111111111'::uuid,'bbbbbbbb-0000-0000-0000-000000000009'::uuid,'x',99999,0);
    raise exception 'FAIL: guardrail did not fire';
  exception when sqlstate 'P0001' then raise notice 'PASS: insufficient_credits still fires';
  end;
end $$;
SQL
