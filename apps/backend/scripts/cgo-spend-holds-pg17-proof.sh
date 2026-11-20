#!/usr/bin/env bash
set -euo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
PORT="${PORT:-55437}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../../../supabase/migrations"
DIR="$(mktemp -d -t cgo-spend-holds-pg17)"

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
U2=88888888-8888-8888-8888-888888888888

psql_q <<SQL
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as \$\$ select null::uuid \$\$;
create function auth.jwt() returns jsonb language sql stable as \$\$ select '{}'::jsonb \$\$;
create function public.app_active_tenant() returns uuid language sql stable as \$\$ select null::uuid \$\$;
create table public.tenants (id uuid primary key);
create table public.tenant_users (tenant_id uuid references public.tenants(id) on delete cascade, user_id uuid, role text);
create table public.agent_runs (id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade, payload jsonb not null default '{}');
alter table public.agent_runs add constraint agent_runs_id_tenant_uq unique (id, tenant_id);
create table public.decisions (id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade,
  agent_run_id uuid references public.agent_runs(id) on delete cascade, decision_class text);
create table public.channel_actions (id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade,
  run_id uuid not null references public.agent_runs(id) on delete cascade, unique (tenant_id, id));
create table public.creator_offers (id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade, unique (tenant_id, id));
create table public.creator_orders (id uuid primary key, tenant_id uuid not null references public.tenants(id) on delete cascade, unique (tenant_id, id));
create table public.autopilot_goals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  objective text not null, target_metric text not null, target_value numeric not null,
  baseline_value numeric, current_value numeric, due_date date,
  status text not null default 'active', priority int not null default 50,
  source text not null default 'founder',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  cgo_status_line text, cgo_status_at timestamptz, cgo_undo jsonb, count_rule jsonb);
create table public.staff_users (user_id uuid primary key, revoked_at timestamptz);
create function public._tenant_tier(p uuid) returns text language sql stable as \$\$ select 'pro'::text \$\$;
insert into public.tenants values ('$T'), ('$T2');
insert into public.tenant_users values ('$T', '$U', 'owner'), ('$T2', '$U2', 'owner');
SQL
for m in 20260928210000_ad_budget_core 20260928230000_ad_budget_setup_ledger \
         20260928230100_ad_budget_reconcile 20260928233000_ad_budget_end_pauses \
         20260929010000_ad_budget_monthly 20260929210000_ad_budget_events \
         20260930010000_ad_ledger 20260930020000_ad_ledger_removed_objects \
         20260930030000_ad_budget_brake 20261005090000_creator_hire_budget \
         20261005140000_autopilot_tracking_links; do
  psql_q -f "$MIG/$m.sql" >/dev/null
done

psql_q -c "insert into ad_budgets (tenant_id, monthly_usd, started_on, month_start) values ('$T', 31000, '2026-09-01', '2026-10-01')"
psql_q -c "insert into ad_budgets (tenant_id, monthly_usd, started_on, month_start) values ('$T2', 31000, '2026-09-01', '2026-10-01')"
OLD_MARGIN="$(psql_q -c "select margin from ad_budgets where tenant_id='$T'")"

psql_q -f "$MIG/20261012110000_cgo_spend_pace_holds.sql" >/dev/null
psql_q -f "$MIG/20261012140000_cgo_spend_holds_cbo_and_freshness.sql" >/dev/null
psql_q -f "$MIG/20261013110000_cgo_cbo_holds_ignore_stale_children.sql" >/dev/null
psql_q -f "$MIG/20261016180000_cgo_holds_removed_objects_and_cbo_budget.sql" >/dev/null
psql_q -f "$MIG/20261017100000_cgo_unknown_ad_holds.sql" >/dev/null
psql_q -f "$MIG/20261021120000_cgo_inflight_ad_holds.sql" >/dev/null
psql_q -f "$MIG/20261022140000_ad_budget_raise_holds_increase.sql" >/dev/null
psql_q <<'SQL'
create or replace function public._ad_budget_today() returns date
language sql stable set search_path = public, pg_temp as $$ select current_setting('proof.today')::date $$;
SQL
psql_q -c "alter database postgres set proof.today = '2026-10-10'"   # 22 days left in October

FAILED=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1 ($2)"; else echo "FAIL  $1: expected [$3], got [$2]"; FAILED=1; fi; }
held() { psql_q -c "select (ad_budget_month_view('$1')->>'held_usd')::numeric"; }
reserve() { # tenant key platform op object delta paused
  psql_q -c "select reserve_ad_spend(p_tenant_id => '$1', p_idem_key => '$2', p_platform => '$3', p_op => '$4', p_object_id => $5, p_daily_delta_usd => $6, p_paused => $7)->>'status'"
}
commit_hold() { psql_q -c "select settle_ad_spend('$1', '$2', 'committed', '$3')->>'status'" >/dev/null; }
age_object() { # tenant object hours
  psql_q -c "update ad_budget_reservations set created_at = now() - interval '$3 hours', updated_at = now() - interval '$3 hours' where tenant_id = '$1' and object_id = '$2'"
}
fresh_read() { psql_q -c "update ad_budgets set actual_read_at = now() - interval '$2' where tenant_id = '$1' and status = 'active'"; }
ledger() { # tenant platform object status budget as_of_ago
  psql_q -c "insert into ad_campaigns (tenant_id, platform, account_id, object_id, level, budget_kind, budget_usd, status, currency, source, as_of)
             values ('$1', '$2', 'acct', '$3', 'ad_set', 'daily', $5, '$4', 'USD', 'api', now() - interval '$6')
             on conflict (tenant_id, platform, account_id, object_id) do update
               set status = excluded.status, budget_usd = excluded.budget_usd, as_of = excluded.as_of"
}
spend() { # tenant platform object date amount
  psql_q -c "insert into ad_spend_daily (tenant_id, platform, account_id, object_id, spend_date, amount_usd, source)
             values ('$1', '$2', 'acct', '$3', '$4', $5, 'api')"
}

echo "== C3: margin =="
check "an active budget made at the old default" "$OLD_MARGIN" "1.25"
check "is set to 1.0" "$(psql_q -c "select margin from ad_budgets where tenant_id='$T'")" "1.00"
check "a new budget defaults to 1.0" "$(psql_q -c "select column_default from information_schema.columns where table_name='ad_budgets' and column_name='margin'")" "1.0"
check "the month view shows margin" "$(psql_q -c "select ad_budget_month_view('$T')->>'margin'")" "1.00"

echo "== test 5: a \$300/day PAUSED create holds one day =="
check "paused create held" "$(reserve $T c1:create meta create null 300 true)" "held"
commit_hold $T c1:create adset-P
check "held is one day (300), not 300 x 22" "$(held $T)" "300.00"
check "a full (not paused) create of the same size holds the month" "$(reserve $T2 x1:create meta create null 300 false)" "held"
commit_hold $T2 x1:create adset-X
check "T2 holds 300 x 22" "$(held $T2)" "6600.00"
check "the default (no p_paused) is a full hold" "$(psql_q -c "select reserve_ad_spend(p_tenant_id => '$T2', p_idem_key => 'x2:create', p_platform => 'meta', p_op => 'create', p_object_id => null, p_daily_delta_usd => 10)->>'amount_usd'")" "220.00"
psql_q -c "select settle_ad_spend('$T2', 'x2:create', 'released')" >/dev/null
check "p_paused on a raise is ignored (raises are never paused)" "$(reserve $T r0:raise meta raise "'adset-R'" 10 true)" "held"
check "  and it holds the month" "$(psql_q -c "select paused::text || ':' || amount_usd from ad_budget_reservations where idem_key='r0:raise'")" "false:220.00"
psql_q -c "select settle_ad_spend('$T', 'r0:raise', 'released')" >/dev/null

echo "== switching it on takes the full hold =="
check "resume of the paused create" "$(reserve $T c1:resume meta resume "'adset-P'" 300 false)" "held"
commit_hold $T c1:resume adset-P
check "the resume's amount is the rest of the month (300 x 21)" "$(psql_q -c "select amount_usd from ad_budget_reservations where idem_key='c1:resume'")" "6300.00"
check "held is now 300 x 22" "$(held $T)" "6600.00"
check "the create's hold is no longer paused" "$(psql_q -c "select paused from ad_budget_reservations where idem_key='c1:create'")" "f"
check "a retry of the resume holds nothing more" "$(reserve $T c1:resume meta resume "'adset-P'" 300 false)" "already_held"
check "  held unchanged" "$(held $T)" "6600.00"

echo "== a resume past the cap is refused and the hold stays one day =="
psql_q -c "update ad_budgets set monthly_usd = 6800 where tenant_id = '$T2'"
check "small paused create" "$(reserve $T2 c2:create meta create null 100 true)" "held"
commit_hold $T2 c2:create adset-Q
check "  but switching it on (100 x 21 more, cap 6800, held 6700) does not fit" "$(reserve $T2 c2:resume meta resume "'adset-Q'" 100 false)" "refused"
check "  its hold stays paused" "$(psql_q -c "select paused from ad_budget_reservations where idem_key='c2:create'")" "t"
psql_q -c "update ad_budgets set monthly_usd = 31000 where tenant_id = '$T2'"

echo "== test 5: released after 48h with no delivery =="
check "a second paused create" "$(reserve $T c3:create meta create null 300 true)" "held"
commit_hold $T c3:create adset-I
fresh_read $T '10 minutes'
ledger $T meta adset-I PAUSED 300 '10 minutes'
check "younger than 48h: kept" "$(psql_q -c "select release_idle_ad_holds('$T')->>'released'")" "0"
age_object $T adset-I 49
spend $T meta adset-I 2026-10-09 4.50
check "spent yesterday: kept" "$(psql_q -c "select release_idle_ad_holds('$T')->>'released'")" "0"
psql_q -c "delete from ad_spend_daily where object_id = 'adset-I'"
ledger $T meta adset-I ACTIVE 300 '10 minutes'
check "the ledger says it is on: kept" "$(psql_q -c "select release_idle_ad_holds('$T')->>'released'")" "0"
ledger $T meta adset-I PAUSED 300 '8 hours'
check "a stale ledger row: kept" "$(psql_q -c "select release_idle_ad_holds('$T')->>'released'")" "0"
ledger $T meta adset-I PAUSED 300 '4 hours'
check "D5: a ledger row 4 hours old (over the 3h window): kept" "$(psql_q -c "select release_idle_ad_holds('$T')->>'released'")" "0"
ledger $T meta adset-I PAUSED 300 '10 minutes'
fresh_read $T '4 hours'
check "D5: a fresh ledger row but the whole read is 4 hours old: nothing released" "$(psql_q -c "select release_idle_ad_holds('$T')->>'status' || ':' || (release_idle_ad_holds('$T')->>'released')")" "stale:0"
fresh_read $T '10 minutes'
check "another tenant's sweep touches nothing of T" "$(psql_q -c "select release_idle_ad_holds('$T2')->>'released'")" "0"
check "paused, 49h old, no delivery: released" "$(psql_q -c "select release_idle_ad_holds('$T')->>'released'")" "1"
check "  as idle_paused, today kept" "$(psql_q -c "select status || ':' || reason || ':' || released_on from ad_budget_reservations where idem_key='c3:create'")" "released:idle_paused:2026-10-10"
psql_q -c "alter database postgres set proof.today = '2026-10-11'"
check "tomorrow it holds nothing (only adset-P's 300 x 21 is left)" "$(held $T)" "6300.00"
psql_q -c "alter database postgres set proof.today = '2026-10-10'"
check "a paused create whose object a whole read did not list" "$(reserve $T c4:create meta create null 50 true)" "held"
commit_hold $T c4:create adset-GONE
age_object $T adset-GONE 50
fresh_read $T '5 hours'
check "  is kept while the read is not fresh" "$(psql_q -c "select release_idle_ad_holds('$T')->>'released'")" "0"
fresh_read $T '10 minutes'
check "  and released once it is" "$(psql_q -c "select release_idle_ad_holds('$T')->>'released'")" "1"

echo "== rebasing a paused-only object keeps it one day =="
check "paused create" "$(reserve $T c5:create meta create null 200 true)" "held"
commit_hold $T c5:create adset-RB
before="$(held $T)"
check "a cut to 150" "$(psql_q -c "select rebase_ad_spend_for_object('$T','meta','adset-RB',150,'c5:rebase')->>'status'")" "rebased"
check "  holds 50 less (one day), never more" "$(psql_q -c "select ($before - (ad_budget_month_view('$T')->>'held_usd')::numeric)")" "50.00"
check "  and the new row is paused" "$(psql_q -c "select paused from ad_budget_reservations where idem_key='c5:rebase'")" "t"

echo "== C3: under-delivery shrinks the hold to 1.2x trailing actual =="
check "a live \$100/day ad set" "$(reserve $T s1:create meta create null 100 false)" "held"
commit_hold $T s1:create adset-S
ledger $T meta adset-S ACTIVE 100 '10 minutes'
for d in 2026-10-07 2026-10-08 2026-10-09; do spend $T meta adset-S $d 20; done
check "younger than 72h: not shrunk" "$(psql_q -c "select shrink_underdelivering_ad_holds('$T')->>'shrunk'")" "0"
age_object $T adset-S 80
fresh_read $T '5 hours'
check "test 9: stale spend data shrinks nothing" "$(psql_q -c "select shrink_underdelivering_ad_holds('$T')->>'status'")" "stale"
fresh_read $T '10 minutes'
before="$(held $T)"
check "fresh: shrunk" "$(psql_q -c "select shrink_underdelivering_ad_holds('$T')->>'shrunk'")" "1"
check "  to 24/day (1.2 x 20)" "$(psql_q -c "select daily_delta_usd from ad_budget_reservations where object_id='adset-S' and status='committed'")" "24.00"
check "  held drops by (100 - 24) x 22" "$(psql_q -c "select ($before - (ad_budget_month_view('$T')->>'held_usd')::numeric)")" "1672.00"
check "  once per object per day" "$(psql_q -c "select shrink_underdelivering_ad_holds('$T')->>'shrunk'")" "0"
check "a well-delivering ad set" "$(reserve $T s2:create meta create null 100 false)" "held"
commit_hold $T s2:create adset-W
ledger $T meta adset-W ACTIVE 100 '10 minutes'
for d in 2026-10-07 2026-10-08 2026-10-09; do spend $T meta adset-W $d 80; done
age_object $T adset-W 80
check "  (80% of its budget) is not shrunk" "$(psql_q -c "select shrink_underdelivering_ad_holds('$T')->>'shrunk'")" "0"
check "  and keeps its 100/day" "$(psql_q -c "select daily_delta_usd from ad_budget_reservations where object_id='adset-W' and status='committed'")" "100.00"

echo "== a Meta campaign-level hold (CBO duplicate): the ledger reports its ad sets, never the campaign =="
check "duplicate campaign: create hold, full month" "$(reserve $T d1:create meta create null 100 false)" "held"
commit_hold $T d1:create camp-D
check "  its live (resume) hold nets to nothing more" "$(reserve $T d1:resume meta resume "'camp-D'" 100 false)" "held"
commit_hold $T d1:resume camp-D
check "  the campaign holds 100/day" "$(psql_q -c "select sum(daily_delta_usd) from ad_budget_reservations where object_id='camp-D' and status='committed'")" "100.00"
psql_q -c "insert into ad_campaigns (tenant_id, platform, account_id, object_id, level, campaign_id, budget_kind, budget_usd, status, currency, source, as_of)
           values ('$T', 'meta', 'acct', 'camp-D-set1', 'ad_set', 'camp-D', 'campaign_level', null, 'ACTIVE', 'USD', 'api', now() - interval '10 minutes')"
for d in 2026-10-07 2026-10-08 2026-10-09; do spend $T meta camp-D-set1 $d 10; done
age_object $T camp-D 80
fresh_read $T '10 minutes'
before="$(held $T)"
check "  its ad set is on: not released as idle" "$(psql_q -c "select release_idle_ad_holds('$T')->>'released'")" "0"
check "  F4: shrunk from its ad sets' spend (10/day of 100)" "$(psql_q -c "select shrink_underdelivering_ad_holds('$T')->>'shrunk'")" "1"
check "  to 12/day (1.2 x 10)" "$(psql_q -c "select sum(daily_delta_usd) from ad_budget_reservations where object_id='camp-D' and status='committed'")" "12.00"
check "  held drops by (100 - 12) x 22" "$(psql_q -c "select ($before - (ad_budget_month_view('$T')->>'held_usd')::numeric)")" "1936.00"

echo "== a CBO campaign with two ad sets: their spend adds up =="
check "a \$100/day CBO campaign" "$(reserve $T d2:create meta create null 100 false)" "held"
commit_hold $T d2:create camp-E
for k in 1 2; do
  psql_q -c "insert into ad_campaigns (tenant_id, platform, account_id, object_id, level, campaign_id, budget_kind, budget_usd, status, currency, source, as_of)
             values ('$T', 'meta', 'acct', 'camp-E-set$k', 'ad_set', 'camp-E', 'campaign_level', null, 'ACTIVE', 'USD', 'api', now() - interval '10 minutes')"
  for d in 2026-10-07 2026-10-08 2026-10-09; do spend $T meta camp-E-set$k $d 40; done
done
age_object $T camp-E 80
check "  80/day of 100 across two ad sets: not shrunk" "$(psql_q -c "select shrink_underdelivering_ad_holds('$T')->>'shrunk'")" "0"
check "  keeps its 100/day" "$(psql_q -c "select sum(daily_delta_usd) from ad_budget_reservations where object_id='camp-E' and status='committed'")" "100.00"
psql_q -c "update ad_campaigns set as_of = now() - interval '5 hours' where object_id like 'camp-E-set%'"
psql_q -c "delete from ad_spend_daily where object_id like 'camp-E-set%'"
check "  every ad set row stale: no shrink even with no spend" "$(psql_q -c "select shrink_underdelivering_ad_holds('$T')->>'shrunk'")" "0"

echo "== review F1: an archived ad set's stale row never blocks its campaign's upkeep =="
check "a \$100/day CBO campaign" "$(reserve $T d4:create meta create null 100 false)" "held"
commit_hold $T d4:create camp-G
psql_q -c "insert into ad_campaigns (tenant_id, platform, account_id, object_id, level, campaign_id, budget_kind, budget_usd, status, currency, source, as_of) values
           ('$T', 'meta', 'acct', 'camp-G-A', 'ad_set', 'camp-G', 'campaign_level', null, 'ACTIVE', 'USD', 'api', now() - interval '10 minutes'),
           ('$T', 'meta', 'acct', 'camp-G-B', 'ad_set', 'camp-G', 'campaign_level', null, 'ARCHIVED', 'USD', 'api', now() - interval '6 days')"
for d in 2026-10-07 2026-10-08 2026-10-09; do spend $T meta camp-G-A $d 10; done
age_object $T camp-G 80
check "  fresh child A spends 10/day of 100: shrunk" "$(psql_q -c "select shrink_underdelivering_ad_holds('$T')->>'shrunk'")" "1"
check "  to 12/day" "$(psql_q -c "select sum(daily_delta_usd) from ad_budget_reservations where object_id='camp-G' and status='committed'")" "12.00"
check "a \$40/day CBO campaign, now paused" "$(reserve $T d5:create meta create null 40 false)" "held"
commit_hold $T d5:create camp-H
psql_q -c "insert into ad_campaigns (tenant_id, platform, account_id, object_id, level, campaign_id, budget_kind, budget_usd, status, currency, source, as_of) values
           ('$T', 'meta', 'acct', 'camp-H-A', 'ad_set', 'camp-H', 'campaign_level', null, 'CAMPAIGN_PAUSED', 'USD', 'api', now() - interval '10 minutes'),
           ('$T', 'meta', 'acct', 'camp-H-B', 'ad_set', 'camp-H', 'campaign_level', null, 'ARCHIVED', 'USD', 'api', now() - interval '6 days')"
age_object $T camp-H 49
psql_q -c "select release_idle_ad_holds('$T')" >/dev/null
check "  fresh child A paused, archived B stale, no spend, 49h: released" "$(psql_q -c "select status || ':' || reason from ad_budget_reservations where idem_key='d5:create'")" "released:idle_paused"

echo "== F4 + D5: an idle CBO campaign hold is released from its ad sets' rows =="
check "a \$60/day CBO campaign" "$(reserve $T d3:create meta create null 60 false)" "held"
commit_hold $T d3:create camp-F
psql_q -c "insert into ad_campaigns (tenant_id, platform, account_id, object_id, level, campaign_id, budget_kind, budget_usd, status, currency, source, as_of)
           values ('$T', 'meta', 'acct', 'camp-F-set1', 'ad_set', 'camp-F', 'campaign_level', null, 'CAMPAIGN_PAUSED', 'USD', 'api', now() - interval '10 minutes')"
age_object $T camp-F 49
spend $T meta camp-F-set1 2026-10-09 3
check "  its ad set spent yesterday: kept" "$(psql_q -c "select release_idle_ad_holds('$T')->>'released'")" "0"
psql_q -c "delete from ad_spend_daily where object_id = 'camp-F-set1'"
psql_q -c "update ad_campaigns set as_of = now() - interval '4 hours' where object_id = 'camp-F-set1'"
check "  its ad set row is 4 hours old: kept" "$(psql_q -c "select release_idle_ad_holds('$T')->>'released'")" "0"
psql_q -c "update ad_campaigns set as_of = now() - interval '10 minutes' where object_id = 'camp-F-set1'"
check "  paused, fresh, no delivery, 49h: released" "$(psql_q -c "select release_idle_ad_holds('$T')->>'released'")" "1"
check "  as idle_paused" "$(psql_q -c "select status || ':' || reason from ad_budget_reservations where idem_key='d3:create'")" "released:idle_paused"

echo "== a launch notes its new object on its open hold =="
check "an open create hold" "$(reserve $T n1:create meta create null 25 false)" "held"
check "another tenant cannot note it" "$(psql_q -c "select note_ad_spend_object('$T2', 'n1:create', 'copy-N')->>'status'")" "not_found"
check "  noted" "$(psql_q -c "select note_ad_spend_object('$T', 'n1:create', 'copy-N')->>'status'")" "noted"
check "  the hold names the object, still reserved, same amount" "$(psql_q -c "select object_id || ':' || status || ':' || amount_usd from ad_budget_reservations where idem_key='n1:create'")" "copy-N:reserved:550.00"
check "  never re-pointed" "$(psql_q -c "select note_ad_spend_object('$T', 'n1:create', 'copy-OTHER')->>'status'")" "unchanged"
commit_hold $T n1:create copy-N
check "  commit keeps it" "$(psql_q -c "select object_id || ':' || status from ad_budget_reservations where idem_key='n1:create'")" "copy-N:committed"
check "  a settled hold is never noted" "$(psql_q -c "select note_ad_spend_object('$T', 'n1:create', 'copy-Z')->>'status'")" "unchanged"

echo "== A: a removed object's hold comes back, whatever the age of its 'removed' row =="
hold_state() { psql_q -c "select string_agg(distinct status, ',') from ad_budget_reservations where tenant_id = '$1' and object_id = '$2'"; }
removed_row() { # tenant object campaign marked_ago
  psql_q -c "insert into ad_campaigns (tenant_id, platform, account_id, object_id, level, campaign_id, budget_kind, budget_usd, status, currency, source, as_of)
             values ('$1', 'meta', 'acct', '$2', 'ad_set', $3, 'daily', 50, 'removed', 'USD', 'api', now() - interval '$4')
             on conflict (tenant_id, platform, account_id, object_id) do update set status = 'removed', as_of = excluded.as_of, campaign_id = excluded.campaign_id"
}
fresh_read $T2 '10 minutes'
check "a live \$50/day ad set" "$(reserve $T2 a1:create meta create null 50 false)" "held"
commit_hold $T2 a1:create adset-DEL
removed_row $T2 adset-DEL null '2 days'
age_object $T2 adset-DEL 49
spend $T2 meta adset-DEL 2026-10-09 7
psql_q -c "select release_idle_ad_holds('$T2')" >/dev/null
check "  deleted, but spent yesterday: kept" "$(hold_state $T2 adset-DEL)" "committed"
psql_q -c "delete from ad_spend_daily where object_id = 'adset-DEL'"
age_object $T2 adset-DEL 30
psql_q -c "select release_idle_ad_holds('$T2')" >/dev/null
check "  deleted 2 days ago, hold 30h old: kept (the 48h rule stands)" "$(hold_state $T2 adset-DEL)" "committed"
age_object $T2 adset-DEL 49
fresh_read $T2 '5 hours'
psql_q -c "select release_idle_ad_holds('$T2')" >/dev/null
check "  no fresh whole read: kept" "$(hold_state $T2 adset-DEL)" "committed"
fresh_read $T2 '10 minutes'
psql_q -c "select release_idle_ad_holds('$T2')" >/dev/null
check "  removed row 2 days old, 49h, no spend: released (was stuck: the row is never refreshed)" "$(psql_q -c "select status || ':' || reason from ad_budget_reservations where idem_key='a1:create'")" "released:idle_paused"
check "a live ad set whose stale row says ACTIVE" "$(reserve $T2 a2:create meta create null 50 false)" "held"
commit_hold $T2 a2:create adset-STALE
ledger $T2 meta adset-STALE ACTIVE 50 '2 days'
age_object $T2 adset-STALE 49
psql_q -c "select release_idle_ad_holds('$T2')" >/dev/null
check "  is still kept (only 'removed' is trusted when stale)" "$(hold_state $T2 adset-STALE)" "committed"

echo "== A: a CBO campaign whose ad sets were all removed =="
check "a live \$80/day CBO campaign" "$(reserve $T2 a3:create meta create null 80 false)" "held"
commit_hold $T2 a3:create camp-DEL
removed_row $T2 camp-DEL-s1 "'camp-DEL'" '3 days'
removed_row $T2 camp-DEL-s2 "'camp-DEL'" '3 days'
psql_q -c "insert into ad_campaigns (tenant_id, platform, account_id, object_id, level, campaign_id, budget_kind, budget_usd, status, currency, source, as_of)
           values ('$T2', 'meta', 'acct', 'camp-DEL-s3', 'ad_set', 'camp-DEL', 'campaign_level', null, 'ACTIVE', 'USD', 'api', now() - interval '10 minutes')"
age_object $T2 camp-DEL 49
psql_q -c "select release_idle_ad_holds('$T2')" >/dev/null
check "  one ad set still on: kept" "$(hold_state $T2 camp-DEL)" "committed"
psql_q -c "update ad_campaigns set status = 'removed', as_of = now() - interval '3 days' where object_id = 'camp-DEL-s3'"
psql_q -c "select release_idle_ad_holds('$T2')" >/dev/null
check "  every ad set removed days ago, live hold, 49h, no spend: released" "$(psql_q -c "select status || ':' || reason from ad_budget_reservations where idem_key='a3:create'")" "released:idle_paused"

echo "== B: a CBO campaign is judged against its own daily budget =="
ledger_rpc() { # tenant campaign_budget_json
  psql_q -c "select record_ad_ledger_read('$1', 'meta', 'acct2',
     jsonb_build_array(jsonb_build_object('object_id', 'camp-R-s1', 'level', 'ad_set', 'campaign_id', 'camp-R', 'budget_kind', 'campaign_level', 'currency', 'USD', 'status', 'ACTIVE'$2)),
     '[]'::jsonb)->>'status'"
}
check "the ledger read records the campaign's daily budget on its ad set" "$(ledger_rpc $T2 ", 'campaign_budget_usd', 900")" "recorded"
check "  stored" "$(psql_q -c "select campaign_budget_usd from ad_campaigns where object_id = 'camp-R-s1'")" "900.00"
check "  a negative one is refused" "$(psql_q -c "select record_ad_ledger_read('$T2', 'meta', 'acct2', '[{\"object_id\":\"x\",\"level\":\"ad_set\",\"budget_kind\":\"none\",\"currency\":\"USD\",\"campaign_budget_usd\":-1}]'::jsonb, '[]'::jsonb)" 2>&1 | grep -c 'invalid campaign row')" "1"
check "a +\$400/day raise on a founder's \$500 CBO campaign (now \$900)" "$(reserve $T2 b1:raise meta raise "'camp-R'" 400 false)" "held"
commit_hold $T2 b1:raise camp-R
for d in 2026-10-07 2026-10-08 2026-10-09; do psql_q -c "insert into ad_spend_daily (tenant_id, platform, account_id, object_id, spend_date, amount_usd, source) values ('$T2', 'meta', 'acct2', 'camp-R-s1', '$d', 300, 'api')" >/dev/null; done
age_object $T2 camp-R 80
check "  spending 300/day of 900 (under 70%): shrunk (was compared with the 400 hold and kept)" "$(psql_q -c "select shrink_underdelivering_ad_holds('$T2')->>'shrunk'")" "1"
check "  to 360/day (1.2 x 300)" "$(psql_q -c "select sum(daily_delta_usd) from ad_budget_reservations where object_id='camp-R' and status='committed'")" "360.00"
check "a later read with a lifetime budget clears it" "$(ledger_rpc $T2 "")" "recorded"
check "  null" "$(psql_q -c "select coalesce(campaign_budget_usd::text, 'null') from ad_campaigns where object_id = 'camp-R-s1'")" "null"

echo "== GS01: unknown create outcomes =="
hold_of() { psql_q -c "select status || ':' || coalesce(reason, '-') || ':' || coalesce(object_id, '-') || ':' || coalesce(released_on::text, '-') from ad_budget_reservations where tenant_id = '$1' and idem_key = '$2'"; }
seen_of() { psql_q -c "select id || '|' || updated_at from ad_budget_reservations where tenant_id = '$1' and idem_key = '$2'"; }
resolve() { # tenant key outcome object(sql)
  local s; s="$(seen_of $1 $2)"
  psql_q -c "select resolve_unknown_ad_hold('$1', '${s%%|*}', '$3', $4, '${s#*|}')->>'status'"
}
age_key() { psql_q -c "update ad_budget_reservations set updated_at = now() - interval '$3 hours' where tenant_id = '$1' and idem_key = '$2'"; }
REF="'{\"kind\":\"meta_tag\",\"level\":\"adset\",\"campaign_id\":\"c9\",\"tag\":\"zv0123456789\"}'::jsonb"
check "an unknown-outcome create" "$(reserve $T u1:create meta create null 50 true)" "held"
check "  its ref is noted before the send" "$(psql_q -c "select note_ad_spend_ref('$T', 'u1:create', $REF)->>'status'")" "noted"
check "  a retry noting the same ref is fine" "$(psql_q -c "select note_ad_spend_ref('$T', 'u1:create', $REF)->>'status'")" "noted"
check "  a different ref is refused" "$(psql_q -c "select note_ad_spend_ref('$T', 'u1:create', '{\"kind\":\"google_campaign_name\",\"name\":\"x\"}'::jsonb)->>'status'")" "not_open"
check "  a bad ref kind is refused" "$(psql_q -c "select note_ad_spend_ref('$T', 'u1:create', '{\"kind\":\"x\"}'::jsonb)" 2>&1 | grep -c 'invalid ref')" "1"
check "  another tenant cannot note it" "$(psql_q -c "select note_ad_spend_ref('$T2', 'u1:create', $REF)->>'status'")" "not_found"
check "  young: the resolver leaves it" "$(resolve $T u1:create absent null)" "stale"
age_key $T u1:create 3
check "  another tenant cannot resolve it" "$(s="$(seen_of $T u1:create)"; psql_q -c "select resolve_unknown_ad_hold('$T2', '${s%%|*}', 'absent', null, '${s#*|}')->>'status'")" "not_found"
check "  changed since the read: left alone" "$(s="$(seen_of $T u1:create)"; psql_q -c "select resolve_unknown_ad_hold('$T', '${s%%|*}', 'absent', null, now() - interval '9 hours')->>'status'")" "stale"
check "  3h old, absent on the platform: released" "$(resolve $T u1:create absent null)" "released"
check "  holds nothing, today included" "$(hold_of $T u1:create)" "released:absent_on_platform:-:-"
check "  a late commit reopens it with the id" "$(psql_q -c "select settle_ad_spend('$T', 'u1:create', 'committed', 'adset-LATE')->>'status'")" "committed"
check "  committed on the object" "$(hold_of $T u1:create)" "committed:-:adset-LATE:-"

check "a second unknown create" "$(reserve $T u2:create meta create null 40 true)" "held"
age_key $T u2:create 3
check "  found on the platform: committed on that id" "$(resolve $T u2:create found "'adset-F'")" "resolved"
check "  state" "$(hold_of $T u2:create)" "committed:-:adset-F:-"
check "  once it names an object the resolver never touches it again" "$(resolve $T u2:create absent null)" "stale"

check "a third, absent, then the slow attempt notes its copy" "$(reserve $T u3:create meta create null 30 true)" "held"
age_key $T u3:create 3
resolve $T u3:create absent null >/dev/null
check "  note_ad_spend_object reopens it as in flight" "$(psql_q -c "select note_ad_spend_object('$T', 'u3:create', 'adset-N')->>'status'")" "noted"
check "  state" "$(hold_of $T u3:create)" "reserved:-:adset-N:-"
check "  a plain rejected release is never reopened by a commit" "$(reserve $T u4:create meta create null 20 true)" "held"
psql_q -c "select settle_ad_spend('$T', 'u4:create', 'released')" >/dev/null
check "  stays released" "$(psql_q -c "select settle_ad_spend('$T', 'u4:create', 'committed', 'x')->>'status'")" "released"

echo "== in flight: a raise or resume left reserved on its object =="
inflight() { # tenant key outcome
  local s; s="$(seen_of $1 $2)"
  psql_q -c "select resolve_inflight_ad_hold('$1', '${s%%|*}', '$3', '${s#*|}')->>'status'"
}
check "a raise on a known campaign is held" "$(reserve $T f1:raise google raise "'camp-F'" 45 false)" "held"
check "  a second raise on it is refused while the first is in flight" "$(reserve $T f2:raise google raise "'camp-F'" 10 false)" "refused"
check "  young: left alone" "$(inflight $T f1:raise not_landed)" "stale"
age_key $T f1:raise 3
check "  another tenant cannot touch it" "$(s="$(seen_of $T f1:raise)"; psql_q -c "select resolve_inflight_ad_hold('$T2', '${s%%|*}', 'not_landed', '${s#*|}')->>'status'")" "not_found"
check "  changed since the read: left alone" "$(s="$(seen_of $T f1:raise)"; psql_q -c "select resolve_inflight_ad_hold('$T', '${s%%|*}', 'not_landed', now() - interval '9 hours')->>'status'")" "stale"
check "  the change never took: released, nothing held" "$(inflight $T f1:raise not_landed)" "released"
check "  state" "$(hold_of $T f1:raise)" "released:not_landed:camp-F:-"
check "  the next raise on the campaign is no longer busy" "$(reserve $T f2:raise google raise "'camp-F'" 10 false)" "held"
psql_q -c "select settle_ad_spend('$T', 'f2:raise', 'released')" >/dev/null
check "  the slow attempt lands after all: reopened" "$(psql_q -c "select settle_ad_spend('$T', 'f1:raise', 'committed')->>'status'")" "committed"
check "  state" "$(hold_of $T f1:raise)" "committed:-:camp-F:-"
check "a resume that landed" "$(reserve $T f3:resume meta resume "'adset-G'" 20 false)" "held"
age_key $T f3:resume 3
check "  committed" "$(inflight $T f3:resume landed)" "committed"
check "  a committed hold is never judged again" "$(inflight $T f3:resume not_landed)" "stale"
check "a create with no object is not this resolver's" "$(reserve $T f4:create meta create null 10 true)" "held"
age_key $T f4:create 3
check "  stale" "$(inflight $T f4:create not_landed)" "stale"

echo "== 20261022140000: a raise holds what it adds =="
T3=33333333-3333-3333-3333-333333333333
psql_q -c "insert into tenants values ('$T3')"
psql_q -c "insert into ad_budgets (tenant_id, monthly_usd, started_on, month_start, spent_usd) values ('$T3', 25000, '2026-09-01', '2026-10-01', 4002.25)"
check "a create Zavi made, held at its whole rate" "$(reserve $T3 u1:create meta create null 932 false)" "held"
commit_hold $T3 u1:create zavi-made
check "  room left" "$(psql_q -c "select (ad_budget_month_view('$T3')->>'left_usd')::numeric")" "493.75"
check "the handler's \$40 -> \$41 raise on an ad set Zavi never held (sent +\$1) is held" "$(reserve $T3 u2:raise meta raise "'host'" 1 false)" "held"
check "  it holds \$1 x 22 days, not \$41 x 22 = \$902" "$(psql_q -c "select daily_delta_usd || ':' || amount_usd from ad_budget_reservations where idem_key='u2:raise'")" "1.00:22.00"
commit_hold $T3 u2:raise host
check "a raise that does not fit is still refused (+\$30 x 22 = \$660 > \$471.75)" "$(reserve $T3 u3:raise meta raise "'host'" 30 false)" "refused"
check "a second raise on the same ad set holds only its own increase (+\$9)" "$(reserve $T3 u4:raise meta raise "'host'" 9 false)" "held"
commit_hold $T3 u4:raise host
check "  the ad set holds +\$10 a day (\$40 -> \$50)" "$(psql_q -c "select sum(daily_delta_usd) from ad_budget_reservations where tenant_id='$T3' and object_id='host' and status='committed'")" "10.00"
check "a landed \$5 cut (\$50 -> \$45) lowers the hold by \$5, not to \$45" "$(psql_q -c "select rebase_ad_spend_for_object('$T3', 'meta', 'host', 45, 'u5:rebase', 5)->>'daily_usd'")" "5.00"
check "  a retry of the cut changes nothing" "$(psql_q -c "select rebase_ad_spend_for_object('$T3', 'meta', 'host', 45, 'u5:rebase', 5)->>'status'")" "already_rebased"
check "a cut bigger than the hold (\$45 -> \$30) floors it at 0" "$(psql_q -c "select rebase_ad_spend_for_object('$T3', 'meta', 'host', 30, 'u6:rebase', 15)->>'daily_usd'")" "0.00"
check "a zero or negative cut is an error" "$(psql_q -c "select rebase_ad_spend_for_object('$T3', 'meta', 'zavi-made', 10, 'u7:rebase', 0)" 2>&1 | grep -c 'invalid cut amount')" "1"
check "without a cut (the shrink's call) the hold drops to the new rate, as before" "$(psql_q -c "select rebase_ad_spend_for_object('$T3', 'meta', 'zavi-made', 900, 'u8:rebase')->>'daily_usd'")" "900.00"
check "a cut on a Zavi-made object equals the new rate (\$900 -> \$850)" "$(psql_q -c "select rebase_ad_spend_for_object('$T3', 'meta', 'zavi-made', 850, 'u9:rebase', 50)->>'daily_usd'")" "850.00"
check "a resume still nets against what the object holds (\$850 held, \$850 sent: zero delta)" "$(psql_q -c "select reserve_ad_spend(p_tenant_id => '$T3', p_idem_key => 'u10:resume', p_platform => 'meta', p_op => 'resume', p_object_id => 'zavi-made', p_daily_delta_usd => 850)->>'amount_usd'")" "0.00"
check "only one rebase function remains" "$(psql_q -c "select count(*) from pg_proc where proname = 'rebase_ad_spend_for_object'")" "1"
commit_hold $T3 u10:resume zavi-made
fresh_read $T3 "1 minute"
ledger $T3 meta zavi-made ACTIVE 850 "1 minute"
age_object $T3 zavi-made 80
check "the shrink lowers an under-delivering object through the five-argument rebase" "$(psql_q -c "select shrink_underdelivering_ad_holds('$T3')->>'shrunk'")" "1"
check "  to trailing spend x 1.2 (nothing spent: 0)" "$(psql_q -c "select sum(daily_delta_usd) from ad_budget_reservations where tenant_id='$T3' and object_id='zavi-made' and status='committed'")" "0.00"
check "a create that under-delivers" "$(reserve $T3 u12:create meta create null 100 false)" "held"
commit_hold $T3 u12:create slow
ledger $T3 meta slow ACTIVE 100 "1 minute"
spend $T3 meta slow 2026-10-07 20; spend $T3 meta slow 2026-10-08 20; spend $T3 meta slow 2026-10-09 20
age_object $T3 slow 80
check "  is shrunk to its spend x 1.2" "$(psql_q -c "select shrink_underdelivering_ad_holds('$T3')->>'shrunk'")" "1"
check "  held \$24" "$(psql_q -c "select sum(daily_delta_usd) from ad_budget_reservations where tenant_id='$T3' and object_id='slow' and status='committed'")" "24.00"
check "a \$40 cut (\$100 -> \$60) keeps the \$24 (it would have left \$0 while it spends \$20)" "$(psql_q -c "select rebase_ad_spend_for_object('$T3', 'meta', 'slow', 60, 'u13:rebase', 40)->>'status'")" "not_lower"
check "a cut below it (\$60 -> \$10) drops it to the new rate" "$(psql_q -c "select rebase_ad_spend_for_object('$T3', 'meta', 'slow', 10, 'u14:rebase', 50)->>'daily_usd'")" "10.00"

echo "== ACLs =="
for f in "record_ad_ledger_read(uuid, text, text, jsonb, jsonb)" "reserve_ad_spend(uuid, text, text, text, text, numeric, uuid, uuid, boolean)" "note_ad_spend_object(uuid, text, text)" "note_ad_spend_ref(uuid, text, jsonb)" "resolve_unknown_ad_hold(uuid, uuid, text, text, timestamptz)" "resolve_inflight_ad_hold(uuid, uuid, text, timestamptz)" "settle_ad_spend(uuid, text, text, text)" "release_idle_ad_holds(uuid)" "shrink_underdelivering_ad_holds(uuid)" "ad_budget_month_view(uuid)" "rebase_ad_spend_for_object(uuid, text, text, numeric, text, numeric)"; do
  check "authenticated cannot run $f" "$(psql_q -c "select has_function_privilege('authenticated', 'public.$f', 'execute')")" "f"
  check "service_role can run $f" "$(psql_q -c "select has_function_privilege('service_role', 'public.$f', 'execute')")" "t"
done
check "the old 8-argument reserve is gone" "$(psql_q -c "select count(*) from pg_proc where proname = 'reserve_ad_spend'")" "1"

echo
if [ "$FAILED" = 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; exit 1; fi
