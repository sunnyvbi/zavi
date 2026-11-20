#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-after}"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
PORT="${PORT:-55432}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../../../supabase/migrations"
DIR="$(mktemp -d -t ad-budget-pg17)"

cleanup() {
  "$PGBIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DIR/data" -U postgres -A trust >/dev/null
"$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR" -l "$DIR/log" -w start >/dev/null

psql_q() { "$PGBIN/psql" -h "$DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }

psql_q <<'SQL'
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create function public.app_active_tenant() returns uuid language sql stable as $$ select null::uuid $$;
create table public.tenants (id uuid primary key);
create table public.tenant_users (tenant_id uuid, user_id uuid, role text);
create function public._tenant_tier(p uuid) returns text language sql stable as $$ select 'pro'::text $$;
insert into public.tenants values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
insert into public.tenant_users values
  ('11111111-1111-1111-1111-111111111111', '99999999-9999-9999-9999-999999999999', 'owner');
SQL
for m in 20260928210000_ad_budget_core 20260928230000_ad_budget_setup_ledger \
         20260928230100_ad_budget_reconcile 20260928233000_ad_budget_end_pauses; do
  psql_q -f "$MIG/$m.sql" >/dev/null
done

T=11111111-1111-1111-1111-111111111111
T2=22222222-2222-2222-2222-222222222222
U=99999999-9999-9999-9999-999999999999
FAILED=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1 ($2)"; else echo "FAIL  $1: expected [$3], got [$2]"; FAILED=1; fi; }
finish() { echo; if [ "$FAILED" = 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; exit 1; fi; }

if [ "$MODE" = "before" ]; then
  echo "== BEFORE (old end-date SQL): the full amount is usable =="
  psql_q <<SQL
insert into ad_budgets (id, tenant_id, total_usd, ends_on, committed_usd, actual_usd)
  values ('aaaaaaaa-0000-0000-0000-000000000001', '$T', 3000, current_date, 3000, 2320);
insert into ad_budget_reservations (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status)
  values ('aaaaaaaa-0000-0000-0000-000000000001', '$T', 'a:create', 'meta', 'adset-A', 'create', 80, 3000, 'committed');
SQL
  check "last-day raise that uses the rest of the month is held" \
    "$(psql_q -c "select reserve_ad_spend('$T','b:raise','meta','raise','adset-B',464)->>'status'")" "held"
  finish
fi

psql_q -f "$MIG/20260929010000_ad_budget_monthly.sql" >/dev/null
psql_q -f "$MIG/20260929210000_ad_budget_events.sql" >/dev/null
psql_q -f "$MIG/20260930010000_ad_ledger.sql" >/dev/null
psql_q -f "$MIG/20260930020000_ad_ledger_removed_objects.sql" >/dev/null
psql_q -f "$MIG/20260930030000_ad_budget_brake.sql" >/dev/null
psql_q <<'SQL'
create table public.agent_runs (id uuid primary key, tenant_id uuid not null);
create table public.creator_orders (id uuid primary key, tenant_id uuid not null);
create table public.decisions (id uuid primary key, tenant_id uuid not null);
create table public.channel_actions (id uuid primary key, tenant_id uuid not null, unique (tenant_id, id));
create table public.creator_offers (id uuid primary key, tenant_id uuid not null);
create table public.autopilot_goals (id uuid primary key, tenant_id uuid not null);
SQL
psql_q -f "$MIG/20261005090000_creator_hire_budget.sql" >/dev/null
psql_q -f "$MIG/20261005140000_autopilot_tracking_links.sql" >/dev/null
psql_q <<'SQL'
create or replace function public._ad_budget_today() returns date
language sql stable set search_path = public, pg_temp as $$ select current_setting('proof.today')::date $$;
SQL
today() { psql_q -c "alter database postgres set proof.today = '$1'"; }
reserve() { psql_q -c "select reserve_ad_spend('$1','$2','$3','$4',$5,$6) - 'month_cap_usd'"; }
status_of() { psql_q -c "select reserve_ad_spend('$1','$2','$3','$4',$5,$6)->>'status'"; }
view() { psql_q -c "select ad_budget_month_view('$T')->>'$1'"; }
live_count() { psql_q -c "select count(*) from ad_budget_reservations where tenant_id='$T' and idem_key='$1' and status in ('reserved','committed')"; }
fresh_budget() { # $1 monthly, $2 started_on
  psql_q -c "update ad_budgets set status='stopped' where tenant_id='$T' and status='active'"
  psql_q -c "delete from ad_budget_reservations where tenant_id='$T'"
  psql_q -c "insert into ad_budgets (tenant_id, monthly_usd, started_on, month_start) values ('$T', $1, '$2', date_trunc('month', '$2'::date)::date)"
}

echo "== no budget =="
today 2026-09-30
check "T13 tenant with no budget" "$(reserve $T k0 meta create null 50)" '{"reason": null, "status": "no_budget", "amount_usd": 0}'

echo "== the worked example: spend counted once, the full month usable =="
fresh_budget 3000 2026-09-01
psql_q -c "update ad_budgets set spent_usd = 2320 where tenant_id='$T' and status='active'"
psql_q -c "insert into ad_budget_reservations (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status)
           select id, '$T', 'a:create', 'meta', 'adset-A', 'create', 80, 3000, 'committed' from ad_budgets where tenant_id='$T' and status='active'"
check "held for the rest of the month is ONE day of the \$80 ad set (80 x 1 x 1.25)" "$(view held_usd)" "100.00"
check "left this month = 3000 - 2320 - 100" "$(view left_usd)" "580.00"
check "a raise one cent over what is left is refused" "$(status_of $T c:raise meta raise "'adset-B'" 464.01)" "refused"
check "the old model froze here; a \$464/day raise that uses the full \$3,000 is held" "$(reserve $T b:raise meta raise "'adset-B'" 464)" '{"reason": null, "status": "held", "amount_usd": 580.00}'
check "nothing left" "$(view left_usd)" "0.00"

echo "== proration of the first month =="
check "set up on Sep 20 (11 of 30 days): 3000 x 11/30" "$(psql_q -c "select _ad_budget_month_cap(3000, '2026-09-20', '2026-09-20')")" "1100.00"
check "same budget in October: the full amount" "$(psql_q -c "select _ad_budget_month_cap(3000, '2026-09-20', '2026-10-01')")" "3000.00"
check "rounded DOWN to the cent (1000 x 1/31)" "$(psql_q -c "select _ad_budget_month_cap(1000, '2026-10-31', '2026-10-31')")" "32.25"
check "February 2028 (29 days), started the 1st" "$(psql_q -c "select _ad_budget_month_cap(2900, '2028-02-01', '2028-02-10')")" "2900.00"
today 2026-09-20
psql_q -c "update ad_budgets set status='stopped' where tenant_id='$T' and status='active'"
psql_q -c "delete from ad_budget_reservations where tenant_id='$T'"
check "create_ad_budget on Sep 20 answers the prorated cap" "$(psql_q -c "select create_ad_budget('$T','$U',3000,null)->>'month_cap_usd'")" "1100.00"
check "the check uses days left (80 x 11 x 1.25 = 1100) and fits exactly" "$(reserve $T p1:create meta create null 80)" '{"reason": null, "status": "held", "amount_usd": 1100.00}'
check "one cent a day more does not fit" "$(status_of $T p2:create meta create null 0.01)" "refused"

echo "== holds shrink as days pass (no double count) =="
psql_q -c "select settle_ad_spend('$T','p1:create','committed','adset-P')" >/dev/null
today 2026-09-25
psql_q -c "update ad_budgets set spent_usd = 400 where tenant_id='$T' and status='active'"
check "Sep 25: held = 80 x 6 x 1.25" "$(view held_usd)" "600.00"
check "Sep 25: left = 1100 - 400 - 600" "$(view left_usd)" "100.00"
check "a \$13/day raise to \$93 (13 x 6 x 1.25 = 97.50) now fits" "$(reserve $T p3:raise meta raise "'adset-P'" 93)" '{"reason": null, "status": "held", "amount_usd": 97.50}'

echo "== T3: two concurrent reserves that together pass the month =="
today 2026-09-30
fresh_budget 100 2026-09-01
( psql_q -c "begin; select reserve_ad_spend('$T','a:create','meta','create',null,50) - 'month_cap_usd'; select pg_sleep(2); commit;" > "$DIR/a.out" ) &
PA=$!
sleep 0.5
( psql_q -c "select reserve_ad_spend('$T','b:create','meta','create',null,50) - 'month_cap_usd'" > "$DIR/b.out" ) &
PB=$!
wait $PA $PB
A="$(grep status "$DIR/a.out")"; B="$(cat "$DIR/b.out")"
echo "  session A: $A"
echo "  session B: $B"
check "T3 exactly one held" "$(printf '%s\n%s\n' "$A" "$B" | grep -c '"held"' || true)" "1"
check "T3 the other refused over_month" "$(printf '%s\n%s\n' "$A" "$B" | grep -c '"over_month"' || true)" "1"
check "T3 held is one hold" "$(view held_usd)" "62.50"

echo "== T3 burst: 8 parallel reserves on a \$200 month =="
fresh_budget 200 2026-09-01
for i in 1 2 3 4 5 6 7 8; do
  ( psql_q -c "select reserve_ad_spend('$T','burst$i:create','meta','create',null,50)" > "$DIR/burst$i.out" ) &
done
wait
check "T3 burst: floor(200 / 62.50) = 3 held" "$(cat "$DIR"/burst*.out | grep -c '"held"' || true)" "3"
check "T3 burst: held never passes the cap" "$(view held_usd)" "187.50"

echo "== T10: restart mid-action =="
fresh_budget 1000 2026-09-01
reserve $T r1:create meta create null 50 >/dev/null
check "T10 retry after a crash past reserve" "$(reserve $T r1:create meta create null 50)" '{"reason": null, "status": "already_held", "amount_usd": 62.50}'
check "T10 one live row for the key" "$(live_count r1:create)" "1"
( psql_q -c "begin; select reserve_ad_spend('$T','r2:create','meta','create',null,50); select pg_sleep(30); commit;" >/dev/null 2>&1 || true ) &
PK=$!
sleep 1
psql_q -c "select pg_terminate_backend(pid) from pg_stat_activity where query like '%r2:create%' and pid <> pg_backend_pid()" >/dev/null
wait $PK || true
check "T10 killed txn left no hold" "$(view held_usd)" "62.50"
check "T10 retry after the kill holds" "$(reserve $T r2:create meta create null 50)" '{"reason": null, "status": "held", "amount_usd": 62.50}'
check "T10 held once for r2" "$(live_count r2:create)" "1"
check "T10 held is two holds, not three" "$(view held_usd)" "125.00"

echo "== T4 settle, T7 resume, T14 pause, F2b zero delta =="
check "T4 a definite rejection releases, nothing kept" "$(psql_q -c "select settle_ad_spend('$T','r2:create','released')")" '{"status": "released"}'
check "T4 held back to one hold" "$(view held_usd)" "62.50"
check "T4 commit stamps the created object" "$(psql_q -c "select settle_ad_spend('$T','r1:create','committed','adset-1')")" '{"status": "committed"}'
check "T7 resume of the created ad set holds nothing more" "$(reserve $T r3:resume meta resume "'adset-1'" 50)" '{"reason": null, "status": "held", "amount_usd": 0.00}'
today 2026-09-21
check "T14 before the pause: 50 x 10 x 1.25" "$(view held_usd)" "625.00"
check "T14 pause gives back the 9 days after today" "$(psql_q -c "select release_ad_spend_for_object('$T','meta','adset-1')")" '{"status": "released", "released_usd": 562.50}'
check "T14 today stays held (50 x 1.25)" "$(view held_usd)" "62.50"
psql_q -c "update ad_budgets set spent_usd = 1000 where tenant_id='$T' and status='active'"
reserve $T z1:resume meta resume "'adset-z'" 0 >/dev/null
psql_q -c "select settle_ad_spend('$T','z1:resume','committed')" >/dev/null
check "F2b a positive raise is refused when the month is full" "$(status_of $T z2:raise meta raise "'adset-z'" 1)" "refused"
check "F2b a zero-delta hold is never refused" "$(reserve $T z3:resume meta resume "'adset-z'" 0)" '{"reason": null, "status": "held", "amount_usd": 0.00}'

echo "== daily limit =="
fresh_budget 100000 2026-09-01
psql_q -c "update ad_budgets set daily_limit_usd = 100 where tenant_id='$T' and status='active'"
reserve $T d0:create meta create null 50 >/dev/null
check "daily limit refuses 60 more a day" "$(reserve $T d1:raise meta raise "'adset-1'" 60)" '{"reason": "over_daily_limit", "status": "refused", "amount_usd": 750.00}'
check "daily limit allows 50 more a day" "$(status_of $T d2:raise meta raise "'adset-1'" 50)" "held"

echo "== editing the monthly amount mid-month =="
today 2026-09-20
fresh_budget 3000 2026-09-20
reserve $T e1:create meta create null 40 >/dev/null   # 40 x 11 x 1.25 = 550
psql_q -c "update ad_budgets set spent_usd = 100 where tenant_id='$T' and status='active'"
BID=$(psql_q -c "select id from ad_budgets where tenant_id='$T' and status='active'")
check "a started-this-month budget edited to \$1,800 caps this month at 1800 x 11/30" "$(psql_q -c "select update_ad_budget('$T','$U','$BID',1800,null)")" '{"status": "updated", "month_cap_usd": 660.00}'
check "below spent + held (100 + 550) is refused with the numbers" "$(psql_q -c "select update_ad_budget('$T','$U','$BID',1000,null)")" '{"status": "below_used", "used_usd": 650.00, "month_cap_usd": 366.66}'
today 2026-10-05
psql_q -c "update ad_budgets set month_start='2026-10-01', spent_usd = 0 where id='$BID'"
check "in a later month the new amount is the full cap" "$(psql_q -c "select update_ad_budget('$T','$U','$BID',2000,null)->>'month_cap_usd'")" "2000.00"

echo "== F1: a raise holds the full new rate on an object the budget did not hold =="
today 2026-09-21
fresh_budget 100000 2026-09-01
check "raise of a pre-existing \$100/day ad set to \$101 holds 101 x 10 x 1.25" "$(reserve $T x1:raise meta raise "'adset-X'" 101)" '{"reason": null, "status": "held", "amount_usd": 1262.50}'
psql_q -c "select settle_ad_spend('$T','x1:raise','committed')" >/dev/null
check "a second raise to \$120 holds only the \$19 difference (19 x 10 x 1.25)" "$(reserve $T x2:raise meta raise "'adset-X'" 120)" '{"reason": null, "status": "held", "amount_usd": 237.50}'
check "held for the object is the full \$120/day" "$(view held_usd)" "1500.00"
psql_q -c "select settle_ad_spend('$T','x2:raise','committed')" >/dev/null
check "a raise back to a rate already held nets to zero and is never refused" "$(reserve $T x3:raise meta raise "'adset-X'" 110)" '{"reason": null, "status": "held", "amount_usd": 0.00}'
psql_q -c "select settle_ad_spend('$T','x3:raise','committed')" >/dev/null

echo "== F1b: a raise never nets against another raise still in flight on the object =="
check "raise A to \$10 holds 10 x 10 x 1.25 (in flight)" "$(reserve $T ya:raise meta raise "'adset-Y'" 10)" '{"reason": null, "status": "held", "amount_usd": 125.00}'
check "raise B to \$130 on the same ad set is refused object_busy" "$(reserve $T yb:raise meta raise "'adset-Y'" 130)" '{"reason": "object_busy", "status": "refused", "amount_usd": 0}'
check "a resume on it is refused too" "$(psql_q -c "select reserve_ad_spend('$T','yc:resume','meta','resume','adset-Y',130)->>'reason'")" "object_busy"
check "a retry of A still answers already_held" "$(reserve $T ya:raise meta raise "'adset-Y'" 10)" '{"reason": null, "status": "already_held", "amount_usd": 125.00}'
check "another ad set is not blocked" "$(psql_q -c "select reserve_ad_spend('$T','yd:raise','meta','raise','adset-W',5)->>'status'")" "held"
psql_q -c "select settle_ad_spend('$T','ya:raise','committed')" >/dev/null
check "after A commits, B nets against it: (130 - 10) x 10 x 1.25" "$(reserve $T yb:raise meta raise "'adset-Y'" 130)" '{"reason": null, "status": "held", "amount_usd": 1500.00}'
check "the ad set is held at its full \$130/day" "$(psql_q -c "select sum(daily_delta_usd) from ad_budget_reservations where tenant_id='$T' and object_id='adset-Y' and status in ('reserved','committed')")" "130.00"
psql_q -c "select settle_ad_spend('$T','yb:raise','committed'); select settle_ad_spend('$T','yd:raise','committed')" >/dev/null
psql_q -c "select release_ad_spend_for_object('$T','meta','adset-Y'); select release_ad_spend_for_object('$T','meta','adset-W')" >/dev/null

echo "== F3: a daily limit below what the running ads hold a day is refused =="
BID=$(psql_q -c "select id from ad_budgets where tenant_id='$T' and status='active'")
check "limit \$100 under \$120/day live: refused with both numbers" "$(psql_q -c "select update_ad_budget('$T','$U','$BID',100000,100)")" '{"status": "daily_below_live", "live_daily_usd": 120.00, "daily_limit_usd": 100.00}'
check "limit \$120 is accepted" "$(psql_q -c "select update_ad_budget('$T','$U','$BID',100000,120)->>'status'")" "updated"

echo "== F4: the rollover pauses nothing, even when the live ads do not fit the month (20260930010000) =="
today 2026-10-01
psql_q -c "update ad_budgets set monthly_usd = 1000, daily_limit_usd = null where id='$BID'"
R=$(psql_q -c "select start_ad_budget_month('$T','$BID')")
check "it rolls into October" "$(psql_q -c "select (\$\$$R\$\$::jsonb)->>'rolled'")" "true"
check "nothing is due for pausing and no note is due" "$(psql_q -c "select jsonb_array_length((\$\$$R\$\$::jsonb)->'pause') || ':' || ((\$\$$R\$\$::jsonb)->>'note_due')")" "0:false"
check "no pause mark on the budget" "$(psql_q -c "select count(*) from ad_budget_reservations where budget_id='$BID' and pause_due")" "0"

echo "== rollover on the 1st: all fit =="
today 2026-09-15
fresh_budget 5000 2026-09-01
BID=$(psql_q -c "select id from ad_budgets where tenant_id='$T' and status='active'")
for o in 10:s 20:m 30:l; do rate=${o%%:*}; name=${o##*:}
  reserve $T "$name:create" meta create null "$rate" >/dev/null
  psql_q -c "select settle_ad_spend('$T','$name:create','committed','adset-$name')" >/dev/null
done
psql_q -c "update ad_budgets set spent_usd = 4000, alarm_90_sent_at = now() where id='$BID'"
today 2026-10-01
R=$(psql_q -c "select start_ad_budget_month('$T','$BID') - 'month_cap_usd' - 'monthly_usd'")
check "rolls into October, nothing to pause" "$R" '{"pause": [], "rolled": true, "status": "active", "note_due": false, "month_start": "2026-10-01", "paused_before": []}'
check "October starts at spent 0" "$(psql_q -c "select spent_usd from ad_budgets where id='$BID'")" "0.00"
check "the 90% alarm is re-armed" "$(psql_q -c "select alarm_90_sent_at is null from ad_budgets where id='$BID'")" "t"
check "a second call the same month does nothing" "$(psql_q -c "select start_ad_budget_month('$T','$BID')->>'rolled'")" "false"

echo "== rollover on the 1st: the founder lowered the amount, nothing is paused =="
today 2026-10-20
psql_q -c "update ad_budgets set monthly_usd = 1500 where id='$BID'"
today 2026-11-01
R=$(psql_q -c "select start_ad_budget_month('$T','$BID') - 'month_cap_usd' - 'monthly_usd'")
check "rolls into November, nothing to pause, no note" "$R" '{"pause": [], "rolled": true, "status": "active", "note_due": false, "month_start": "2026-11-01", "paused_before": []}'
check "no pause mark" "$(psql_q -c "select count(*) from ad_budget_reservations where budget_id='$BID' and pause_due")" "0"
check "every live ad stays held (60/day x 30 x 1.25)" "$(view held_usd)" "2250.00"
check "and new spend is refused while they do not fit (adset-s raised \$10 to \$11)" "$(status_of $T n1:raise meta raise "'adset-s'" 11)" "refused"
today 2026-12-01
psql_q -c "update ad_budgets set monthly_usd = 500 where id='$BID'"
check "December rolls, still nothing to pause" "$(psql_q -c "select jsonb_array_length(start_ad_budget_month('$T','$BID')->'pause')")" "0"

echo "== record the month's spend; alarm once per month =="
check "a reading for last month is ignored" "$(psql_q -c "select record_ad_budget_actual('$T','$BID',999,'2026-11-01')->>'spent_usd'")" "0.00"
check "this month's reading is stored, rounded up" "$(psql_q -c "select record_ad_budget_actual('$T','$BID',400.001,'2026-12-01')->>'spent_usd'")" "400.01"
check "90% of 500 claims the alarm" "$(psql_q -c "select record_ad_budget_actual('$T','$BID',450,'2026-12-01')->>'alarm'")" "true"
check "and only once this month" "$(psql_q -c "select record_ad_budget_actual('$T','$BID',470,'2026-12-01')->>'alarm'")" "false"
check "a lower reading never lowers spent" "$(psql_q -c "select record_ad_budget_actual('$T','$BID',10,'2026-12-01')->>'spent_usd'")" "470.00"

echo "== the history: every set up, change and stop, written in the same transaction =="
today 2026-09-20
psql_q -c "update ad_budgets set status='stopped' where tenant_id='$T' and status='active'"
psql_q -c "delete from ad_budget_reservations where tenant_id='$T'"
NB=$(psql_q -c "select create_ad_budget('$T','$U',3000,null)->>'budget_id'")
ev() { psql_q -c "select coalesce(string_agg(kind || ':' || monthly_usd || ':' || coalesce(daily_limit_usd::text, '-'), ',' order by occurred_at, created_at), '') from ad_budget_events where budget_id='$NB'"; }
check "set up writes one 'setup' event with the amount" "$(ev)" "setup:3000.00:-"
check "edit to \$2,400 with a \$100 daily limit" "$(psql_q -c "select update_ad_budget('$T','$U','$NB',2400,100)->>'status'")" "updated"
check "the edit is an event with the new values; the set up still says 3000" "$(ev)" "setup:3000.00:-,edit:2400.00:100.00"
psql_q -c "alter table ad_budget_events add constraint proof_no_edit check (kind <> 'edit') not valid"
check "an edit whose event fails raises" "$(psql_q -c "select update_ad_budget('$T','$U','$NB',2000,100)" 2>&1 | grep -c proof_no_edit || true)" "1"
check "and the budget keeps its amount (rolled back together)" "$(psql_q -c "select monthly_usd from ad_budgets where id='$NB'")" "2400.00"
psql_q -c "alter table ad_budget_events drop constraint proof_no_edit"
psql_q -c "begin; select update_ad_budget('$T','$U','$NB',1800,100); rollback;" >/dev/null
check "a rolled-back edit leaves no event" "$(ev)" "setup:3000.00:-,edit:2400.00:100.00"
check "an edit that changes nothing is accepted" "$(psql_q -c "select update_ad_budget('$T','$U','$NB',2400,100)->>'status'")" "updated"
check "and writes no event" "$(ev)" "setup:3000.00:-,edit:2400.00:100.00"
psql_q -c "update ad_budgets set spent_usd = 500 where id='$NB'"
check "an edit below what is spent is refused" "$(psql_q -c "select update_ad_budget('$T','$U','$NB',100,null)->>'status'")" "below_used"
check "and writes no event" "$(ev)" "setup:3000.00:-,edit:2400.00:100.00"
psql_q -c "select update_ad_budget('$T2','$U','$NB',5000,null)" >/dev/null 2>&1 || true
check "another tenant cannot edit it: the amount and the history are unchanged" "$(psql_q -c "select monthly_usd from ad_budgets where id='$NB'"; ev)" "2400.00
setup:3000.00:-,edit:2400.00:100.00"
check "an edit of only the daily limit is an event" "$(psql_q -c "select update_ad_budget('$T','$U','$NB',2400,null)->>'status'"; ev)" "updated
setup:3000.00:-,edit:2400.00:100.00,edit:2400.00:-"
check "stop" "$(psql_q -c "select stop_ad_budget('$T','$U','$NB')->>'status'")" "stopped"
check "stop again" "$(psql_q -c "select stop_ad_budget('$T','$U','$NB')->>'status'")" "already_stopped"
check "create -> edit -> stop: every amount, in order, one stop" "$(ev)" "setup:3000.00:-,edit:2400.00:100.00,edit:2400.00:-,stop:2400.00:-"
check "every event names the actor and the tenant" "$(psql_q -c "select count(*) from ad_budget_events where budget_id='$NB' and actor='$U' and tenant_id='$T' and not backfilled")" "4"

echo "== two edits that race: the ledger order is the commit order =="
NB2=$(psql_q -c "select create_ad_budget('$T','$U',3000,null)->>'budget_id'")
ev2() { psql_q -c "select string_agg(kind || ':' || monthly_usd, ',' order by occurred_at, created_at) from ad_budget_events where budget_id='$NB2'"; }
( psql_q -c "begin; select now(); select pg_sleep(1); select update_ad_budget('$T','$U','$NB2',2000,null); commit;" >/dev/null ) &
sleep 0.3
( psql_q -c "begin; select update_ad_budget('$T','$U','$NB2',2100,null); select pg_sleep(2); commit;" >/dev/null ) &
wait
check "the budget ends at B's amount (B committed last)" "$(psql_q -c "select monthly_usd from ad_budgets where id='$NB2'")" "2000.00"
check "and the ledger's newest edit is B's, not A's" "$(ev2)" "setup:3000.00,edit:2100.00,edit:2000.00"
check "a stop is stamped with the same time as stopped_at" "$(psql_q -c "select stop_ad_budget('$T','$U','$NB2')->>'status'"; psql_q -c "select (select occurred_at from ad_budget_events where budget_id='$NB2' and kind='stop') = (select stopped_at from ad_budgets where id='$NB2')")" "stopped
t"

echo "== the backfill: one honest set up per budget with no history, a stop where a person stopped it =="
OLD1=$(psql_q -c "insert into ad_budgets (tenant_id, monthly_usd, started_on, month_start, status, stopped_at, stopped_by, created_by, created_at)
                  values ('$T', 1500, '2026-08-01', '2026-08-01', 'stopped', '2026-08-15T10:00:00Z', '$U', '$U', '2026-08-01T09:00:00Z') returning id" | head -1)
OLD2=$(psql_q -c "insert into ad_budgets (tenant_id, monthly_usd, started_on, month_start, status, stopped_at, created_at)
                  values ('$T', 700, '2026-07-01', '2026-07-01', 'stopped', '2026-09-29T00:00:00Z', '2026-07-01T09:00:00Z') returning id" | head -1)
sed -n '/── 3. Backfill/,/^commit;/p' "$MIG/20260929210000_ad_budget_events.sql" | grep -v '^commit;' | psql_q >/dev/null
bf() { psql_q -c "select coalesce(string_agg(kind || ':' || monthly_usd || ':' || backfilled || ':' || to_char(occurred_at at time zone 'utc', 'YYYY-MM-DD'), ',' order by occurred_at), '') from ad_budget_events where budget_id='$1'"; }
check "a stopped budget a person stopped: set up + stop, both marked backfilled" "$(bf $OLD1)" "setup:1500.00:true:2026-08-01,stop:1500.00:true:2026-08-15"
check "an ended-then-stopped budget (no stopped_by): set up only, its stop time is not known" "$(bf $OLD2)" "setup:700.00:true:2026-07-01"
check "a budget that already has a history is not backfilled again" "$(psql_q -c "select count(*) from ad_budget_events where budget_id='$NB'")" "4"
sed -n '/── 3. Backfill/,/^commit;/p' "$MIG/20260929210000_ad_budget_events.sql" | grep -v '^commit;' | psql_q >/dev/null
check "running the backfill twice adds nothing" "$(psql_q -c "select count(*) from ad_budget_events where budget_id in ('$OLD1','$OLD2')")" "3"

echo "== the history table's grants: append-only =="
check "authenticated may only read events" "$(psql_q -c "select has_table_privilege('authenticated','ad_budget_events','select')::text || has_table_privilege('authenticated','ad_budget_events','insert')::text || has_table_privilege('authenticated','ad_budget_events','update')::text")" "truefalsefalse"
check "service_role may read and insert, never update or delete" "$(psql_q -c "select has_table_privilege('service_role','ad_budget_events','insert')::text || has_table_privilege('service_role','ad_budget_events','update')::text || has_table_privilege('service_role','ad_budget_events','delete')::text")" "truefalsefalse"
check "anon has nothing" "$(psql_q -c "select has_table_privilege('anon','ad_budget_events','select')::text")" "false"
check "RLS is on" "$(psql_q -c "select relrowsecurity from pg_class where relname='ad_budget_events'")" "t"

echo "== the ledger: one platform's account read, in one transaction (20260930010000) =="
today 2026-12-02
LC='[{"object_id":"as1","level":"ad_set","campaign_id":"c1","name":"One","budget_kind":"daily","budget_usd":25,"status":"ACTIVE","currency":"usd"},
     {"object_id":"as2","level":"ad_set","campaign_id":"c2","name":"Two","budget_kind":"campaign_level","budget_usd":null,"status":"PAUSED","currency":"USD"}]'
LS='[{"object_id":"as1","spend_date":"2026-12-01","amount_usd":10.5,"provisional":false},
     {"object_id":"as2","spend_date":"2026-12-02","amount_usd":3,"provisional":true}]'
ledger() { psql_q -c "select record_ad_ledger_read('$1','meta','act_1',\$\$$2\$\$::jsonb,\$\$$3\$\$::jsonb)"; }
spend_sum() { psql_q -c "select coalesce(sum(amount_usd),0) || ':' || count(*) from ad_spend_daily where tenant_id='$1'"; }
check "a read writes its campaigns and spend" "$(ledger $T "$LC" "$LS")" '{"status": "recorded", "campaigns": 2, "spend_rows": 2}'
check "the state is stored, currency upper-cased" "$(psql_q -c "select string_agg(object_id || ':' || budget_kind || ':' || coalesce(budget_usd::text,'-') || ':' || currency || ':' || source, ',' order by object_id) from ad_campaigns where tenant_id='$T'")" "as1:daily:25.00:USD:api,as2:campaign_level:-:USD:api"
check "spend summed" "$(spend_sum $T)" "13.50:2"
check "the next read overwrites the day and the state, no new rows" \
  "$(ledger $T '[{"object_id":"as1","level":"ad_set","budget_kind":"none","status":"PAUSED"}]' '[{"object_id":"as1","spend_date":"2026-12-01","amount_usd":12,"provisional":false}]' >/dev/null; spend_sum $T; psql_q -c "select budget_kind || ':' || status from ad_campaigns where tenant_id='$T' and object_id='as1'")" "15.00:2
none:PAUSED"
check "an object the complete read no longer returns is marked removed" \
  "$(psql_q -c "select string_agg(object_id || ':' || status, ',' order by object_id) from ad_campaigns where tenant_id='$T'")" "as1:PAUSED,as2:removed"
check "a doubled row in one read is folded, not an error" \
  "$(ledger $T '[]' '[{"object_id":"as3","spend_date":"2026-12-02","amount_usd":1},{"object_id":"as3","spend_date":"2026-12-02","amount_usd":2}]' >/dev/null; spend_sum $T)" "18.00:3"
for bad in '[{"object_id":"as1","spend_date":"2026-12-01","amount_usd":-1}]' '[{"object_id":"as1","spend_date":"12/01/2026","amount_usd":1}]' \
           '[{"object_id":"as1","spend_date":"2019-12-01","amount_usd":1}]' '[{"spend_date":"2026-12-01","amount_usd":1}]'; do
  check "a malformed spend row is refused: $bad" "$(ledger $T "$LC" "$bad" 2>&1 | grep -c 'record_ad_ledger_read:' || true)" "1"
done
check "an unknown platform is refused" "$(psql_q -c "select record_ad_ledger_read('$T','bing','x','[]','[]')" 2>&1 | grep -c 'invalid platform' || true)" "1"
check "an unknown budget kind is refused by the table" "$(ledger $T '[{"object_id":"z","level":"ad_set","budget_kind":"weekly"}]' '[]' 2>&1 | grep -c 'ad_campaigns_budget_kind_check' || true)" "1"
check "a refused read wrote nothing" "$(spend_sum $T):$(psql_q -c "select count(*) from ad_campaigns where tenant_id='$T'")" "18.00:3:2"
check "another tenant's read lands under that tenant only" "$(ledger $T2 '[]' '[{"object_id":"as1","spend_date":"2026-12-01","amount_usd":99}]' >/dev/null; spend_sum $T; spend_sum $T2)" "18.00:3
99.00:1"
for t in ad_campaigns ad_spend_daily ad_budget_plan; do
  check "$t: RLS on; authenticated and service_role read only; anon nothing" \
    "$(psql_q -c "select relrowsecurity::text || has_table_privilege('authenticated','$t','select')::text || has_table_privilege('authenticated','$t','insert')::text || has_table_privilege('service_role','$t','select')::text || has_table_privilege('service_role','$t','insert')::text || has_table_privilege('service_role','$t','update')::text || has_table_privilege('anon','$t','select')::text from pg_class where relname='$t'")" \
    "truetruefalsetruefalsefalsefalse"
done
check "the plan starts empty" "$(psql_q -c "select count(*) from ad_budget_plan")" "0"

echo "== the cut rebase: a cut lowers the object's hold (20260930030000) =="
today 2026-09-21
fresh_budget 100000 2026-09-01
live_daily() { psql_q -c "select coalesce(sum(daily_delta_usd),0) from ad_budget_reservations where tenant_id='$T' and object_id='$1' and status in ('reserved','committed')"; }
rebase() { psql_q -c "select rebase_ad_spend_for_object('$1','$2','$3',$4,'$5')"; }
reserve $T rb1:raise meta raise "'adset-R'" 100 >/dev/null
psql_q -c "select settle_ad_spend('$T','rb1:raise','committed')" >/dev/null
check "held at \$100/day: 100 x 10 x 1.25" "$(view held_usd)" "1250.00"
check "a cut to \$80 rebases the hold" "$(rebase $T meta adset-R 80 c1:rebase)" '{"status": "rebased", "daily_usd": 80.00, "released_daily_usd": 100.00}'
check "the ad set is held at \$80/day" "$(live_daily adset-R)" "80.00"
check "a cut never raises what is held: 80 x 10 x 1.25 (the old rate is not also counted today)" "$(view held_usd)" "1000.00"
check "a retry of the same cut does not rebase twice" "$(rebase $T meta adset-R 80 c1:rebase)" '{"status": "already_rebased"}'
check "one rebase row, committed" "$(psql_q -c "select count(*) || ':' || min(status) || ':' || min(op) from ad_budget_reservations where tenant_id='$T' and idem_key='c1:rebase'")" "1:committed:rebase"
check "a raise to \$90 then holds only the +\$10: 10 x 10 x 1.25" "$(reserve $T rb2:raise meta raise "'adset-R'" 90)" '{"reason": null, "status": "held", "amount_usd": 125.00}'
check "a cut while that raise is in flight is refused object_busy" "$(rebase $T meta adset-R 50 c2:rebase)" '{"status": "object_busy"}'
check "and changes nothing" "$(live_daily adset-R)" "90.00"
psql_q -c "select settle_ad_spend('$T','rb2:raise','committed')" >/dev/null
check "a new rate not below what is held is refused not_lower (never adds money to held)" "$(rebase $T meta adset-R 95 c3:rebase)" '{"status": "not_lower", "daily_usd": 90.00}'
check "and writes no row" "$(psql_q -c "select count(*) from ad_budget_reservations where tenant_id='$T' and idem_key='c3:rebase'")" "0"
check "an ad set the budget does not hold: no_hold" "$(rebase $T meta adset-none 5 c4:rebase)" '{"status": "no_hold"}'
check "rounded UP to the cent" "$(rebase $T meta adset-R 60.001 c5:rebase)" '{"status": "rebased", "daily_usd": 60.01, "released_daily_usd": 90.00}'
check "another tenant cannot rebase this tenant's ad set" "$(rebase $T2 meta adset-R 1 x:rebase; live_daily adset-R)" '{"status": "no_budget"}
60.01'
check "a Google campaign rebases on its own platform only" "$(rebase $T google adset-R 1 c6:rebase)" '{"status": "no_hold"}'
psql_q -c "select release_ad_spend_for_object('$T','meta','adset-R')" >/dev/null
check "after a pause released it, a retry of the cut still does nothing" "$(rebase $T meta adset-R 60.01 c5:rebase; live_daily adset-R)" '{"status": "already_rebased"}
0'
check "an unknown platform raises" "$(rebase $T bing adset-R 1 c7:rebase 2>&1 | grep -c 'invalid platform' || true)" "1"
check "a negative amount raises" "$(rebase $T meta adset-R -1 c8:rebase 2>&1 | grep -c 'invalid daily amount' || true)" "1"
check "the ledger names the rebase row's op" "$(psql_q -c "select count(*) from ad_budget_reservations where op='rebase' and tenant_id='$T'")" "2"

echo "== the brake's daily claim (20260930030000) =="
BID=$(psql_q -c "select id from ad_budgets where tenant_id='$T' and status='active'")
check "the first claim of the day is granted, for today" "$(psql_q -c "select claim_ad_budget_brake('$T','$BID')")" '{"day": "2026-09-21", "claimed": true}'
check "the second is not" "$(psql_q -c "select claim_ad_budget_brake('$T','$BID')->>'claimed'")" "false"
check "another tenant cannot claim or release it" "$(psql_q -c "select claim_ad_budget_brake('$T2','$BID')->>'claimed'"; psql_q -c "select release_ad_budget_brake('$T2','$BID')->>'status'")" "false
not_found"
check "a released claim can be taken again the same day" "$(psql_q -c "select release_ad_budget_brake('$T','$BID')->>'status'"; psql_q -c "select claim_ad_budget_brake('$T','$BID')->>'claimed'")" "released
true"
today 2026-09-22
check "the next day is a new claim" "$(psql_q -c "select claim_ad_budget_brake('$T','$BID')->>'claimed'")" "true"
psql_q -c "update ad_budgets set status='stopped' where id='$BID'"
today 2026-09-23
check "a stopped budget is never claimed" "$(psql_q -c "select claim_ad_budget_brake('$T','$BID')->>'claimed'")" "false"
check "no active budget: the rebase is no_budget" "$(rebase $T meta adset-R 1 c9:rebase)" '{"status": "no_budget"}'

echo "== tenant isolation and ACLs =="
check "another tenant sees no budget" "$(reserve $T2 x:raise meta raise "'adset-1'" 1)" '{"reason": null, "status": "no_budget", "amount_usd": 0}'
check "another tenant cannot settle this tenant's key" "$(psql_q -c "select settle_ad_spend('$T2','d2:raise','released')")" '{"status": "not_found"}'
check "another tenant cannot roll this budget" "$(psql_q -c "select start_ad_budget_month('$T2','$BID')")" '{"status": "not_found"}'
check "another tenant cannot record on it" "$(psql_q -c "select record_ad_budget_actual('$T2','$BID',1,'2026-12-01')->>'status'")" "not_found"
check "another tenant's view is empty" "$(psql_q -c "select ad_budget_month_view('$T2') is null")" "t"
for fn in "reserve_ad_spend(uuid,text,text,text,text,numeric,uuid,uuid)" "start_ad_budget_month(uuid,uuid)" "record_ad_budget_actual(uuid,uuid,numeric,date)" \
          "ad_budget_month_view(uuid)" "create_ad_budget(uuid,uuid,numeric,numeric)" "update_ad_budget(uuid,uuid,uuid,numeric,numeric)" \
          "_ad_budget_held_usd(uuid,date,numeric,uuid)" "claim_ad_budget_month_note(uuid,uuid)" "stop_ad_budget(uuid,uuid,uuid)" \
          "record_ad_ledger_read(uuid,text,text,jsonb,jsonb)" "rebase_ad_spend_for_object(uuid,text,text,numeric,text)" \
          "claim_ad_budget_brake(uuid,uuid)" "release_ad_budget_brake(uuid,uuid)"; do
  check "$fn: not for authenticated, granted to service_role" \
    "$(psql_q -c "select has_function_privilege('authenticated','$fn','execute')::text || has_function_privilege('service_role','$fn','execute')::text")" "falsetrue"
done
check "the end-date machinery is gone" "$(psql_q -c "select count(*) from pg_proc where proname in ('ended_ad_budget_holds','claim_ad_budget_end_note','release_ad_budget_end_note')")" "0"
check "no ends_on / committed_usd column left" "$(psql_q -c "select count(*) from information_schema.columns where table_name='ad_budgets' and column_name in ('ends_on','committed_usd','closed_at','end_note_sent_at')")" "0"

finish
