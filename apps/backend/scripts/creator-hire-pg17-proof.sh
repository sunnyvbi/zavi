#!/usr/bin/env bash
set -euo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
PORT="${PORT:-55433}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../../../supabase/migrations"
DIR="$(mktemp -d -t creator-hire-pg17)"

cleanup() {
  "$PGBIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DIR/data" -U postgres -A trust >/dev/null
"$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR" -l "$DIR/log" -w start >/dev/null

psql_q() { "$PGBIN/psql" -h "$DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }

T=11111111-1111-1111-1111-111111111111
T2=22222222-2222-2222-2222-222222222222
U=99999999-9999-9999-9999-999999999999
O1=a0000000-0000-0000-0000-000000000001
O2=a0000000-0000-0000-0000-000000000002
O3=a0000000-0000-0000-0000-000000000003
O4=a0000000-0000-0000-0000-000000000004
OX=b0000000-0000-0000-0000-000000000001   # an order of T2
R1=c0000000-0000-0000-0000-000000000001   # a run of T
RX=c0000000-0000-0000-0000-000000000002   # a run of T2

psql_q <<SQL
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as \$\$ select null::uuid \$\$;
create function auth.jwt() returns jsonb language sql stable as \$\$ select '{}'::jsonb \$\$;
create function public.app_active_tenant() returns uuid language sql stable as \$\$ select null::uuid \$\$;
create table public.tenants (id uuid primary key);
create table public.tenant_users (tenant_id uuid, user_id uuid, role text);
create table public.agent_runs (id uuid primary key, tenant_id uuid not null);
create table public.creator_orders (id uuid primary key, tenant_id uuid not null);
create table public.decisions (id uuid primary key, tenant_id uuid not null);
create table public.channel_actions (id uuid primary key, tenant_id uuid not null, unique (tenant_id, id));
create table public.creator_offers (id uuid primary key, tenant_id uuid not null);
create table public.autopilot_goals (id uuid primary key, tenant_id uuid not null);
create function public._tenant_tier(p uuid) returns text language sql stable as \$\$ select 'pro'::text \$\$;
insert into public.tenants values ('$T'), ('$T2');
insert into public.tenant_users values ('$T', '$U', 'owner');
insert into public.agent_runs values ('$R1', '$T'), ('$RX', '$T2');
insert into public.creator_orders values ('$O1', '$T'), ('$O2', '$T'), ('$O3', '$T'), ('$O4', '$T'), ('$OX', '$T2');
SQL
for m in 20260928210000_ad_budget_core 20260928230000_ad_budget_setup_ledger \
         20260928230100_ad_budget_reconcile 20260928233000_ad_budget_end_pauses \
         20260929010000_ad_budget_monthly 20260929210000_ad_budget_events \
         20260930010000_ad_ledger 20260930020000_ad_ledger_removed_objects \
         20260930030000_ad_budget_brake 20261005090000_creator_hire_budget \
         20261005140000_autopilot_tracking_links; do
  psql_q -f "$MIG/$m.sql" >/dev/null
done
psql_q <<'SQL'
create or replace function public._ad_budget_today() returns date
language sql stable set search_path = public, pg_temp as $$ select current_setting('proof.today')::date $$;
SQL

FAILED=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1 ($2)"; else echo "FAIL  $1: expected [$3], got [$2]"; FAILED=1; fi; }
today() { psql_q -c "alter database postgres set proof.today = '$1'"; }
view() { psql_q -c "select ad_budget_month_view('$T')->>'$1'"; }
caps() { psql_q -c "select record_cgo_creator_caps('$T',$1,$2,'test caps','$R1')->>'id'"; }
hire() { psql_q -c "select reserve_creator_hire('$1','$2','$3',$4,'$5')"; }
hire_status() { psql_q -c "select reserve_creator_hire('$1','$2','$3',$4,'$5')->>'status'"; }
settle() { psql_q -c "select settle_creator_hire('$1','$2','$3')"; }
fresh_budget() { # $1 monthly, $2 started_on
  psql_q -c "delete from creator_hire_spend"
  psql_q -c "update ad_budgets set status='stopped' where tenant_id='$T' and status='active'"
  psql_q -c "delete from ad_budget_reservations where tenant_id='$T'"
  psql_q -c "insert into ad_budgets (tenant_id, monthly_usd, started_on, month_start) values ('$T', $1, '$2', date_trunc('month', '$2'::date)::date)"
}

today 2026-10-10

echo "== no budget, no caps =="
C1=$(caps 300 500)
check "no active budget: no_budget, nothing written" "$(hire_status $T k0 $O1 100 $C1):$(psql_q -c "select count(*) from creator_hire_spend")" "no_budget:0"
fresh_budget 1000 2026-10-01
check "test 4: an unknown caps id is no_caps" "$(hire_status $T k0 $O1 100 00000000-0000-0000-0000-000000000000)" "no_caps"
check "T2 with no budget: no_budget" "$(hire_status $T2 k0 $OX 100 $C1)" "no_budget"
psql_q -c "insert into ad_budgets (tenant_id, monthly_usd, started_on, month_start) values ('$T2', 1000, '2026-10-01', '2026-10-01')"
check "T2 cannot use T's caps version" "$(hire_status $T2 k0 $OX 100 $C1)" "no_caps"
check "nothing written by a refusal" "$(psql_q -c "select count(*) from creator_hire_spend")" "0"

echo "== caps (test 2) =="
check "test 2: over the per-hire cap (300.01 > 300)" "$(hire_status $T k1 $O1 300.01 $C1)" "over_hire_cap"
check "within caps and budget: reserved, left = 1000 - 300" "$(hire $T k1 $O1 300 $C1)" '{"status": "reserved", "left_usd": 700.00, "amount_usd": 300.00}'
check "test 2: 300 used this week + 200.01 > 500 per week" "$(hire_status $T k2 $O2 200.01 $C1)" "over_week_cap"
check "200 fits the week exactly" "$(hire_status $T k2 $O2 200 $C1)" "reserved"
check "the week is now full" "$(hire_status $T k3 $O3 0.01 $C1)" "over_week_cap"
today 2026-10-16
check "6 days later the Oct 10 hires still count (7-day window, today included)" "$(hire_status $T k3 $O3 1 $C1)" "over_week_cap"
today 2026-10-17
check "7 days later they drop out of the week" "$(hire_status $T k3 $O3 1 $C1)" "reserved"
psql_q -c "select settle_creator_hire('$T','k3','released')" >/dev/null

echo "== a later cap version never applies to an in-flight hire (test 5) =="
C2=$(caps 50 5000)
check "the new version is stored, run-stamped" "$(psql_q -c "select per_hire_usd || ':' || per_week_usd || ':' || (run_id = '$R1') from cgo_creator_caps where id='$C2'")" "50.00:5000.00:true"
check "a hire pinned to the old version is checked against the old caps" "$(hire_status $T k4 $O4 60 $C1)" "reserved"
psql_q -c "select settle_creator_hire('$T','k4','released')" >/dev/null
check "the same amount under the new version is over its per-hire cap" "$(hire_status $T k4 $O4 60 $C2)" "over_hire_cap"
check "a caps row naming another tenant's run is refused" "$(psql_q -c "select record_cgo_creator_caps('$T',1,1,'x','$RX')" 2>&1 | grep -c 'run not found for tenant' || true)" "1"
check "caps must be positive" "$(psql_q -c "select record_cgo_creator_caps('$T',0,1,'x',null)" 2>&1 | grep -c 'invalid cap' || true)" "1"

echo "== one left number: ads + creators (test 3) =="
fresh_budget 1000 2026-10-01
C3=$(caps 1000 1000)
psql_q -c "update ad_budgets set spent_usd = 400 where tenant_id='$T' and status='active'"
psql_q -c "select reserve_ad_spend('$T','ad1:create','meta','create',null,10)" >/dev/null
check "ads left before any hire = 1000 - 400 - 187.50" "$(view left_usd)" "412.50"
check "test 3: a hire one cent over what the ads left is refused" "$(hire_status $T h1 $O1 412.51 $C3)" "over_budget"
check "a hire that uses exactly what is left is reserved" "$(hire $T h1 $O1 412.50 $C3)" '{"status": "reserved", "left_usd": 0.00, "amount_usd": 412.50}'
check "the view shows the creator hold and nothing left" "$(view creator_held_usd):$(view creator_spent_usd):$(view held_usd):$(view spent_usd):$(view left_usd)" "412.50:0.00:187.50:400.00:0.00"
check "an ad raise now sees the creator hold (one left number)" "$(psql_q -c "select reserve_ad_spend('$T','ad2:create','meta','create',null,0.01)->>'reason'")" "over_month"

echo "== idempotency and settle (test 7, ledger half) =="
check "a retry of the key answers already_held, one row" "$(hire $T h1 $O1 412.50 $C3):$(psql_q -c "select count(*) from creator_hire_spend where idem_key='h1'")" '{"state": "held", "status": "already_held", "amount_usd": 412.50}:1'
check "a key reused for another order raises" "$(hire $T h1 $O2 1 $C3 2>&1 | grep -c 'another order' || true)" "1"
check "a second key for the same live order raises" "$(hire $T h1b $O1 1 $C3 2>&1 | grep -c 'already has a live reservation' || true)" "1"
check "another tenant cannot settle it" "$(settle $T2 h1 spent)" '{"status": "not_found"}'
check "settle to spent" "$(settle $T h1 spent)" '{"status": "spent", "changed": true}'
check "settle to spent again is a no-op" "$(settle $T h1 spent)" '{"status": "spent", "changed": false}'
check "spent never goes back to released" "$(settle $T h1 released)" '{"status": "spent", "changed": false}'
check "a retry after spend still answers already_held, state spent" "$(hire $T h1 $O1 412.50 $C3 | python3 -c 'import sys,json;print(json.load(sys.stdin)["state"])')" "spent"
check "the view counts it as creator spent" "$(view creator_held_usd):$(view creator_spent_usd):$(view left_usd)" "0.00:412.50:0.00"

echo "== refund (test 8, ledger half) =="
check "another tenant cannot refund it" "$(psql_q -c "select refund_creator_hire('$T2','$O1',100)")" '{"status": "not_found"}'
check "a partial refund" "$(psql_q -c "select refund_creator_hire('$T','$O1',100)")" '{"status": "partially_refunded", "refunded_usd": 100.00}'
check "the same refund delivered again changes nothing" "$(psql_q -c "select refund_creator_hire('$T','$O1',100)")" '{"status": "partially_refunded", "refunded_usd": 100.00}'
check "left gives the refunded part back" "$(view creator_spent_usd):$(view left_usd)" "312.50:100.00"
check "a full refund (cumulative), capped at the hire" "$(psql_q -c "select refund_creator_hire('$T','$O1',9999)")" '{"status": "refunded", "refunded_usd": 412.50}'
check "left is back to the ads' own number" "$(view creator_spent_usd):$(view left_usd)" "0.00:412.50"
check "a held (never charged) hire cannot be refunded" "$(hire_status $T h2 $O2 10 $C3):$(psql_q -c "select refund_creator_hire('$T','$O2',10)")" 'reserved:{"status": "not_found"}'
check "release gives a held hire back" "$(settle $T h2 released):$(view creator_held_usd)" '{"status": "released", "changed": true}:0.00'
check "released is idempotent" "$(settle $T h2 released)" '{"status": "released", "changed": false}'
check "a released key can be reserved again (a fresh attempt), one row" "$(hire_status $T h2 $O2 10 $C3):$(psql_q -c "select count(*) from creator_hire_spend where idem_key='h2'")" "reserved:1"

echo "== the month =="
fresh_budget 1000 2026-10-01
C4=$(caps 5000 5000)
today 2026-10-31
hire $T m1 $O1 600 $C4 >/dev/null
check "Oct 31: 600 held" "$(view creator_held_usd):$(view left_usd)" "600.00:400.00"
today 2026-11-01
psql_q -c "select start_ad_budget_month('$T', id) from ad_budgets where tenant_id='$T' and status='active'" >/dev/null
check "Nov 1: October's hire does not count against November" "$(view creator_held_usd):$(view left_usd)" "0.00:1000.00"
check "but it still counts in the 7-day week" "$(psql_q -c "select reserve_creator_hire('$T','m2','$O2',4400.01,'$C4')->>'status'")" "over_week_cap"

echo "== test 16: two concurrent reserves that together pass the budget =="
fresh_budget 1000 2026-10-01
today 2026-10-20
C5=$(caps 1000 5000)
( psql_q -c "begin; select reserve_creator_hire('$T','ca','$O1',600,'$C5')->>'status'; select pg_sleep(2); commit;" > "$DIR/a.out" ) &
PA=$!
sleep 0.5
( psql_q -c "select reserve_creator_hire('$T','cb','$O2',600,'$C5')->>'status'" > "$DIR/b.out" ) &
PB=$!
wait $PA $PB
A="$(grep -E 'reserved|over_' "$DIR/a.out" || true)"; B="$(cat "$DIR/b.out")"
echo "  session A: $A"
echo "  session B: $B"
check "test 16 budget: exactly one reserved" "$(printf '%s\n%s\n' "$A" "$B" | grep -c '^reserved$' || true)" "1"
check "test 16 budget: the other over_budget" "$(printf '%s\n%s\n' "$A" "$B" | grep -c '^over_budget$' || true)" "1"

echo "== test 16: two concurrent reserves that together pass the week cap =="
fresh_budget 100000 2026-10-01
C6=$(caps 1000 1000)
( psql_q -c "begin; select reserve_creator_hire('$T','wa','$O1',600,'$C6')->>'status'; select pg_sleep(2); commit;" > "$DIR/a.out" ) &
PA=$!
sleep 0.5
( psql_q -c "select reserve_creator_hire('$T','wb','$O2',600,'$C6')->>'status'" > "$DIR/b.out" ) &
PB=$!
wait $PA $PB
A="$(grep -E 'reserved|over_' "$DIR/a.out" || true)"; B="$(cat "$DIR/b.out")"
check "test 16 week: exactly one reserved" "$(printf '%s\n%s\n' "$A" "$B" | grep -c '^reserved$' || true)" "1"
check "test 16 week: the other over_week_cap" "$(printf '%s\n%s\n' "$A" "$B" | grep -c '^over_week_cap$' || true)" "1"

echo "== test 16: an ad reserve and a hire racing for the same left =="
fresh_budget 1000 2026-10-01
today 2026-10-31
C7=$(caps 1000 5000)
( psql_q -c "begin; select reserve_creator_hire('$T','ra','$O1',600,'$C7')->>'status'; select pg_sleep(2); commit;" > "$DIR/a.out" ) &
PA=$!
sleep 0.5
( psql_q -c "select reserve_ad_spend('$T','rb:create','meta','create',null,400)->>'status'" > "$DIR/b.out" ) &
PB=$!
wait $PA $PB
check "the hire reserved, the ad hold waited for the lock and was refused" "$(grep -E 'reserved|over_' "$DIR/a.out"):$(cat "$DIR/b.out")" "reserved:refused"

echo "== the founder's budget edits see creator hires =="
fresh_budget 1000 2026-10-01
today 2026-10-20
C8=$(caps 1000 5000)
BID=$(psql_q -c "select id from ad_budgets where tenant_id='$T' and status='active'")
hire $T e1 $O1 600 $C8 >/dev/null
check "lowering the month below a held creator hire is below_used" "$(psql_q -c "select update_ad_budget('$T','$U','$BID',599,null)->>'status'")" "below_used"
check "and names the creator hire as used" "$(psql_q -c "select update_ad_budget('$T','$U','$BID',599,null)->>'used_usd'")" "600.00"
check "lowering to exactly what is used is allowed" "$(psql_q -c "select update_ad_budget('$T','$U','$BID',600,null)->>'status'")" "updated"
psql_q -c "select stop_ad_budget('$T','$U','$BID')" >/dev/null
check "stopped with a held creator hire: a new budget is outstanding_holds" "$(psql_q -c "select create_ad_budget('$T','$U',1000,null)->>'status'")" "outstanding_holds"
settle $T e1 released >/dev/null
check "once the hire is released, a new budget can be set up" "$(psql_q -c "select create_ad_budget('$T','$U',1000,null)->>'status'")" "created"
psql_q -c "update ad_budgets set status='stopped' where tenant_id='$T' and status='active'"
fresh_budget 1000 2026-10-01
C9=$(caps 1000 5000)
BID=$(psql_q -c "select id from ad_budgets where tenant_id='$T' and status='active'")
hire $T e2 $O2 100 $C9 >/dev/null
settle $T e2 spent >/dev/null
psql_q -c "select stop_ad_budget('$T','$U','$BID')" >/dev/null
check "a charged (spent) hire on a stopped budget does not block a new one" "$(psql_q -c "select create_ad_budget('$T','$U',1000,null)->>'status'")" "created"

echo "== cross-tenant and bad arguments =="
check "an order of another tenant raises" "$(hire $T x1 $OX 1 $C7 2>&1 | grep -c 'order not found for tenant' || true)" "1"
check "a zero amount raises" "$(hire $T x2 $O3 0 $C7 2>&1 | grep -c 'invalid amount' || true)" "1"
check "an unknown outcome raises" "$(settle $T ra refunded 2>&1 | grep -c 'invalid outcome' || true)" "1"
check "T2's view does not see T's hires" "$(psql_q -c "select ad_budget_month_view('$T2')->>'creator_held_usd'")" "0.00"

echo "== RLS and ACLs =="
for t in cgo_creator_caps creator_hire_spend; do
  check "$t: RLS on; authenticated read only; service_role read only; anon nothing" \
    "$(psql_q -c "select relrowsecurity::text || has_table_privilege('authenticated','$t','select')::text || has_table_privilege('authenticated','$t','insert')::text || has_table_privilege('service_role','$t','select')::text || has_table_privilege('service_role','$t','insert')::text || has_table_privilege('service_role','$t','update')::text || has_table_privilege('anon','$t','select')::text from pg_class where relname='$t'")" \
    "truetruefalsetruefalsefalsefalse"
done
for fn in "reserve_creator_hire(uuid,text,uuid,numeric,uuid,uuid,uuid)" "settle_creator_hire(uuid,text,text)" \
          "refund_creator_hire(uuid,uuid,numeric)" "record_cgo_creator_caps(uuid,numeric,numeric,text,uuid)" \
          "_creator_hire_used_usd(uuid,date)" "reserve_ad_spend(uuid,text,text,text,text,numeric,uuid,uuid)" "ad_budget_month_view(uuid)" \
          "create_ad_budget(uuid,uuid,numeric,numeric)" "update_ad_budget(uuid,uuid,uuid,numeric,numeric)"; do
  check "$fn: not for anon/authenticated/public, granted to service_role" \
    "$(psql_q -c "select has_function_privilege('anon','$fn','execute')::text || has_function_privilege('authenticated','$fn','execute')::text || has_function_privilege('service_role','$fn','execute')::text")" "falsefalsetrue"
done

echo; if [ "$FAILED" = 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; exit 1; fi
