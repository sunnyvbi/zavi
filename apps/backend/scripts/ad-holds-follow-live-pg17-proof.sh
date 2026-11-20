#!/usr/bin/env bash
set -euo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
PORT="${PORT:-55441}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../../../supabase/migrations"
DIR="$(mktemp -d -t ad-holds-follow-live-pg17)"

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
create table public.tenant_channels (tenant_id uuid references public.tenants(id), channel_slug text, autorun boolean default false,
  autorun_set_by text, primary key (tenant_id, channel_slug));
create table public.decision_classes (slug text primary key, description text, default_autonomy text, dispatch_handler text, never_auto boolean,
  click_allowlistable boolean, severity text);
insert into public.tenants values ('$T'), ('$T2');
insert into public.tenant_users values ('$T', '$U', 'owner'), ('$T2', '$U2', 'owner');
SQL
for m in 20260928210000_ad_budget_core 20260928230000_ad_budget_setup_ledger \
         20260928230100_ad_budget_reconcile 20260928233000_ad_budget_end_pauses \
         20260929010000_ad_budget_monthly 20260929210000_ad_budget_events \
         20260930010000_ad_ledger 20260930020000_ad_ledger_removed_objects \
         20260930030000_ad_budget_brake 20260930193700_ad_object_changes \
         20261005090000_creator_hire_budget 20261005140000_autopilot_tracking_links \
         20261012110000_cgo_spend_pace_holds 20261012140000_cgo_spend_holds_cbo_and_freshness \
         20261013110000_cgo_cbo_holds_ignore_stale_children 20261016180000_cgo_holds_removed_objects_and_cbo_budget \
         20261017100000_cgo_unknown_ad_holds 20261021120000_cgo_inflight_ad_holds \
         20261022140000_ad_budget_raise_holds_increase 20260909200000_set_channel_autorun \
         20261023125328_chatgpt_growth_autopilot 20261025120000_reddit_ads_execution \
         20261025130000_x_ads_management_and_budget 20261025140000_ad_ledger_all_platforms \
         20261026100000_tiktok_ads_held_writes 20261031190000_ad_holds_follow_live \
         20261031200000_ad_holds_sync_read_fence 20261101172000_ad_holds_sync_lineage; do
  psql_q -f "$MIG/$m.sql" >/dev/null
done
psql_q <<'SQL'
create or replace function public._ad_budget_today() returns date
language sql stable set search_path = public, pg_temp as $$ select current_setting('proof.today')::date $$;
SQL
psql_q -c "alter database postgres set proof.today = '2026-10-12'"   # 20 days left in October

FAILED=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1 ($2)"; else echo "FAIL  $1: expected [$3], got [$2]"; FAILED=1; fi; }
view() { psql_q -c "select (ad_budget_month_view('$1')->>'$2')::numeric"; }
budget_id() { psql_q -c "select id from ad_budgets where tenant_id = '$1' and status = 'active'"; }
hold() {
  if [ "$4" = raise ]; then
    psql_q -c "insert into decisions (id, tenant_id) values (md5('$2')::uuid, '$1') on conflict do nothing"
  fi
  psql_q -c "insert into ad_budget_reservations (budget_id, tenant_id, idem_key, platform, object_id, op, daily_delta_usd, amount_usd, status, paused, pause_due, decision_id, created_at, updated_at)
             values ((select id from ad_budgets where tenant_id = '$1' and status = 'active'), '$1', '$2', '$3', '$5', '$4', $6, $6 * 20, '${9:-committed}', ${7:-false}, ${8:-false},
                     case when '$4' = 'raise' then md5('$2')::uuid end, now() - interval '${10:-100 hours}', now() - interval '${10:-100 hours}')"
}
ledger() {
  psql_q -c "insert into ad_campaigns (tenant_id, platform, account_id, object_id, level, campaign_id, budget_kind, budget_usd, campaign_budget_usd, status, currency, source, as_of)
             values ('$1', '$2', 'acct', '$3', '${8:-ad_set}', ${9:-null}, '$5', $6, ${10:-null}, '$4', 'USD', 'api', now() - interval '$7')
             on conflict (tenant_id, platform, account_id, object_id) do update
               set status = excluded.status, budget_kind = excluded.budget_kind, budget_usd = excluded.budget_usd,
                   campaign_budget_usd = excluded.campaign_budget_usd, as_of = excluded.as_of"
}
zavi() {
  if [ -n "${7:-}" ]; then
    psql_q -c "insert into ad_object_changes (tenant_id, platform, object_id, level, source, action_table, action_id, change_kind, before_daily_usd, after_daily_usd, occurred_at)
               values ('$1', '$2', '$3', 'ad_set', 'zavi', 'decisions', md5('$7')::uuid, '$4', $5, $6, now() - interval '100 hours')"
  else
    psql_q -c "insert into ad_object_changes (tenant_id, platform, object_id, level, source, action_table, action_id, change_kind, before_daily_usd, after_daily_usd, occurred_at)
               values ('$1', '$2', '$3', 'ad_set', 'zavi', 'channel_actions', gen_random_uuid(), '$4', $5, $6, now() - interval '100 hours')"
  fi
}
held_on() { psql_q -c "select coalesce(sum(daily_delta_usd), 0) from ad_budget_reservations where tenant_id = '$1' and object_id = '$2' and status = 'committed'"; }
BASE="$(psql_q -c "select now()::text")"
R1="'$BASE'::timestamptz - interval '66 minutes'"
R2="'$BASE'::timestamptz - interval '6 minutes'"
sync_at() { psql_q -c "select sync_ad_holds_to_live('$1', array[$2]::text[], $3)::text"; }
sync() {
  if [ -n "${3:-}" ]; then sync_at "$1" "$2" "$3"; return; fi
  sync_at "$1" "$2" "$R1" >/dev/null
  sync_at "$1" "$2" "$R2"
}
next_hour() {
  psql_q -c "update ad_budget_reservations set created_at = created_at - interval '1 hour', updated_at = updated_at - interval '1 hour' where tenant_id = '$1' and object_id = '$2'"
  psql_q -c "update ad_hold_live_reads set cur_read_at = cur_read_at - interval '1 hour', prev_read_at = prev_read_at - interval '1 hour' where tenant_id = '$1' and object_id = '$2'"
}
reserve_raise() { # tenant key object delta
  psql_q -c "select reserve_ad_spend(p_tenant_id => '$1', p_idem_key => '$2', p_platform => 'meta', p_op => 'raise', p_object_id => '$3', p_daily_delta_usd => $4)->>'status'"
}

echo "== Upcar, 2026-10-12: the \$120 -> \$149 raise =="
psql_q -c "insert into ad_budgets (tenant_id, monthly_usd, started_on, month_start, spent_usd, margin, actual_read_at) values ('$T', 22320.20, '2026-09-28', '2026-10-01', 7976.49, 1.0, now())"
psql_q -c "insert into ad_budgets (tenant_id, monthly_usd, started_on, month_start, spent_usd, margin, actual_read_at) values ('$T2', 22320.20, '2026-09-28', '2026-10-01', 0, 1.0, now())"
hold $T rl:create meta create rl 189.44; hold $T rl:resume meta resume rl 0; hold $T rl:raise meta raise rl 189.44
zavi $T meta rl status null 189.44; zavi $T meta rl budget 189.44 378.88 rl:raise
ledger $T meta rl ACTIVE daily 80 '5 minutes'
hold $T host:create meta create host 136.12; hold $T host:resume meta resume host 0
zavi $T meta host status null 136.12
ledger $T meta host PAUSED daily 60 '5 minutes'
hold $T rent:raise1 meta raise rent 60; hold $T rent:raise2 meta raise rent 20
zavi $T meta rent budget 30 60 rent:raise1; zavi $T meta rent budget 60 80 rent:raise2
ledger $T meta rent ACTIVE daily 120 '5 minutes'
hold $T reg:raise1 meta raise reg 40; hold $T reg:raise2 meta raise reg 40
zavi $T meta reg budget 20 40 reg:raise1; zavi $T meta reg budget 40 80 reg:raise2
ledger $T meta reg ACTIVE daily 100 '5 minutes'
hold $T shrink:google:g1:2026-10-11 google rebase g1 33.22
ledger $T google g1 ENABLED daily 50 '5 minutes' campaign

check "room before" "$(view $T left_usd)" "179.31"
check "the \$29 raise (\$580 for 20 days) is refused, as in prod" "$(reserve_raise $T card:raise rent 29)" "refused"
check "the sync after the read" "$(sync $T "'meta','google'")" '{"status": "done", "lowered": 1, "released": 2, "released_daily_usd": 136.12}'
check "  Regular Leads copy holds its live \$80, not \$378.88" "$(held_on $T rl)" "80.00"
check "  Host copy holds nothing" "$(held_on $T host)" "0"
check "  and is released as live_stopped, today kept" "$(psql_q -c "select distinct status || ':' || reason || ':' || released_on from ad_budget_reservations where object_id = 'host'")" "released:live_stopped:2026-10-12"
check "  Rent a car keeps Zavi's \$80 (live 120 - base 30 = 90 is above it)" "$(held_on $T rent)" "80.00"
check "  Regular Leads keeps \$80 (live 100 - base 20 = 80)" "$(held_on $T reg)" "80.00"
check "  the shrink-set Google hold under its \$50 budget is kept" "$(held_on $T g1)" "33.22"
check "room after: 22,320.20 - 7,976.49 - (273.22 x 20 + 136.12 today)" "$(view $T left_usd)" "8743.19"
check "Try again (the same key) is now held" "$(reserve_raise $T card:raise rent 29)" "held"
check "a second sync changes nothing" "$(sync $T "'meta','google'")" '{"status": "done", "lowered": 0, "released": 0, "released_daily_usd": 0.00}'
check "the new raise is in flight: the sync leaves its object alone" "$(held_on $T rent)" "80.00"
psql_q -c "select settle_ad_spend('$T', 'card:raise', 'committed', 'rent')" >/dev/null
check "  committed after the read: still judged next hour, not on a row older than it" "$(sync $T "'meta'")" '{"status": "done", "lowered": 0, "released": 0, "released_daily_usd": 0.00}'
check "  Rent a car holds 80 + 29" "$(held_on $T rent)" "109.00"

echo "== an outside cut lowers only what Zavi added =="
hold $T o1:raise meta raise o1 20; zavi $T meta o1 budget 40 60 o1:raise; ledger $T meta o1 ACTIVE daily 45 '5 minutes'
hold $T o2:raise meta raise o2 20; ledger $T meta o2 ACTIVE daily 15 '5 minutes'
hold $T o3:create meta create o3 50; ledger $T meta o3 ACTIVE daily 70 '5 minutes'
hold $T o4:raise meta raise o4 10; zavi $T meta o4 budget 50 60 o4:raise; ledger $T meta o4 ACTIVE daily 30 '5 minutes'
hold $T o5:raise meta raise o5 10; hold $T o5:resume meta resume o5 40; zavi $T meta o5 budget 40 50 o5:raise; zavi $T meta o5 status 50 50
ledger $T meta o5 ACTIVE daily 45 '5 minutes'
sync $T "'meta'" >/dev/null
check "base 40, raised to 60, cut to 45: holds 5" "$(held_on $T o1)" "5.00"
check "no Zavi record: capped at the live 15" "$(held_on $T o2)" "15.00"
check "a live budget above the hold: unchanged" "$(held_on $T o3)" "50.00"
check "a cut below the base: 0" "$(held_on $T o4)" "0.00"
check "a resumed object holds up to its whole live budget (45)" "$(held_on $T o5)" "45.00"

echo "== a Meta campaign budget, and Google =="
hold $T c1:create meta create c1 100
ledger $T meta c1-a ACTIVE campaign_level null '5 minutes' ad_set "'c1'" 60
ledger $T meta c1-b PAUSED campaign_level null '5 minutes' ad_set "'c1'" 60
hold $T c2:create meta create c2 100
ledger $T meta c2-a ADSET_PAUSED campaign_level null '5 minutes' ad_set "'c2'" 60
ledger $T meta c2-b CAMPAIGN_PAUSED campaign_level null '5 minutes' ad_set "'c2'" 60
hold $T g2:create google create g2 90; ledger $T google g2 ENABLED daily 40 '5 minutes' campaign
hold $T g3:create google create g3 90; ledger $T google g3 REMOVED daily 40 '50 hours' campaign
hold $T g4:create google create g4 90; ledger $T google g4 ENABLED shared null '5 minutes' campaign
sync $T "'meta'" >/dev/null
check "Google is not judged when only Meta read whole" "$(held_on $T g2)" "90.00"
check "a campaign with one ad set on: capped at the campaign's \$60" "$(held_on $T c1)" "60.00"
check "a campaign whose ad sets are all paused: released" "$(held_on $T c2)" "0"
sync $T "'google'" >/dev/null
check "a Google campaign cut to \$40" "$(held_on $T g2)" "40.00"
check "a removed Google campaign, its removed row 50 hours old" "$(held_on $T g3)" "0"
check "a shared Google budget (no amount of its own): unchanged" "$(held_on $T g4)" "90.00"

echo "== the next hour: a lowered hold stays at what the object can spend (post-merge review of #4161) =="
H2="'$BASE'::timestamptz - interval '5 minutes 30 seconds'"   # the next hour's read (R2 is then an hour back)
hold $T n1:create meta create n1 100; hold $T n1:raise meta raise n1 100
zavi $T meta n1 status null 100; zavi $T meta n1 budget 100 200 n1:raise
ledger $T meta n1 ACTIVE daily 80 '5 minutes'
hold $T n2:shrink meta rebase n2 50; psql_q -c "update ad_budget_reservations set idem_key = 'shrink:meta:n2:2026-10-11' where idem_key = 'n2:shrink'"
zavi $T meta n2 budget 40 60
ledger $T meta n2 ACTIVE daily 30 '5 minutes'
hold $T n3:create meta create n3 100; hold $T n3:raise meta raise n3 100; zavi $T meta n3 budget 100 200 n3:raise
ledger $T meta n3 ACTIVE daily 80 '5 minutes'
hold $T n5:raise1 meta raise n5 20; hold $T n5:raise2 meta raise n5 20; zavi $T meta n5 budget 60 80 n5:raise2
ledger $T meta n5 ACTIVE daily 80 '5 minutes'
hold $T n6:create meta create n6 40 false false released; zavi $T meta n6 status 40 40
hold $T n6:raise meta raise n6 20; zavi $T meta n6 budget 40 60 n6:raise
ledger $T meta n6 ACTIVE daily 45 '5 minutes'
hold $T n7:raise1 meta raise n7 20; zavi $T meta n7 budget 40 60 n7:raise1
ledger $T meta n7 ACTIVE daily 45 '5 minutes'
hold $T n8:create meta create n8 100 false false committed '10 hours'
ledger $T meta n8-a REMOVED campaign_level null '50 hours' ad_set "'n8'" 100
ledger $T meta n8-b ACTIVE campaign_level null '5 minutes' ad_set "'n8'" 60
hold $T n9:raise meta raise n9 20; zavi $T meta n9 budget 40 60 n9:raise
psql_q -c "select rebase_ad_spend_for_object('$T', 'meta', 'n9', 50, 'n9:cut', 10)" >/dev/null
psql_q -c "update ad_budget_reservations set created_at = created_at - interval '50 hours', updated_at = updated_at - interval '50 hours' where object_id = 'n9'"
ledger $T meta n9 ACTIVE daily 45 '5 minutes'
sync $T "'meta'" >/dev/null
check "F1 hour 1: made + raised, cut to 80: holds 80" "$(held_on $T n1)" "80.00"
check "F1 hour 1: shrink-set, cut to 30: holds 30" "$(held_on $T n2)" "30.00"
check "F1 hour 1: no status record, raised, cut to 80: holds 80" "$(held_on $T n3)" "80.00"
check "D3: a raise whose record was lost counts from 0: keeps 40" "$(held_on $T n5)" "40.00"
check "F3: an old Zavi pause does not pin the base: holds 5" "$(held_on $T n6)" "5.00"
check "F4 morning: holds 5" "$(held_on $T n7)" "5.00"
check "D4: the stale removed ad set's 100 is ignored: holds 60" "$(held_on $T n8)" "60.00"
check "a Zavi cut keeps the base: holds 5" "$(held_on $T n9)" "5.00"
for o in n1 n2 n3 n5 n6 n7 n8 n9; do next_hour $T $o; done
psql_q -c "update ad_budget_reservations set created_at = created_at - interval '1 hour', updated_at = updated_at - interval '1 hour' where object_id = 'n8'" >/dev/null
for o in n1 n2 n3 n5 n6 n9; do psql_q -c "update ad_campaigns set as_of = now() - interval '5 minutes' where tenant_id = '$T' and object_id = '$o'"; done
psql_q -c "update ad_campaigns set as_of = now() - interval '5 minutes' where tenant_id = '$T' and object_id = 'n8-b'"
hold $T n7:raise2 meta raise n7 15 false false committed '30 minutes'; zavi $T meta n7 budget 45 60 n7:raise2
ledger $T meta n7 ACTIVE daily 45 '5 minutes'
check "hour 2: the sync on a new read" "$(sync $T "'meta'" "$H2")" '{"status": "done", "lowered": 1, "released": 0, "released_daily_usd": 0.00}'
check "F1 hour 2: made + raised (a status record) still holds 80" "$(held_on $T n1)" "80.00"
check "F1 hour 2: shrink-set still holds 30 (was 0)" "$(held_on $T n2)" "30.00"
check "F1 hour 2: no status record still holds 80 (was 0)" "$(held_on $T n3)" "80.00"
check "D3 hour 2: still 40" "$(held_on $T n5)" "40.00"
check "F3 hour 2: still 5" "$(held_on $T n6)" "5.00"
check "F4: the same-day second cut to 45 lowers again: 5" "$(held_on $T n7)" "5.00"
check "D4 hour 2: still 60" "$(held_on $T n8)" "60.00"
check "Zavi cut hour 2: still 5" "$(held_on $T n9)" "5.00"
check "a retry of the same read changes nothing" "$(sync $T "'meta'" "$H2")" '{"status": "done", "lowered": 0, "released": 0, "released_daily_usd": 0.00}'
hold $T n4:raise meta raise n4 50 false false committed '3 minutes'; zavi $T meta n4 budget 50 100 n4:raise
ledger $T meta n4 ACTIVE daily 50 '1 minute'
sync $T "'meta'" >/dev/null
check "F2: a raise committed during the read keeps its 50" "$(held_on $T n4)" "50.00"

echo "== review of #4191: a read can be stale, a key can be re-reserved, a campaign row can be legacy =="
hold $T m1:create meta create m1 100; ledger $T meta m1 ACTIVE daily 100 '5 minutes'
sync_at $T "'meta'" "$R1" >/dev/null
ledger $T meta m1 ACTIVE daily 50 '5 minutes'
hold $T m2:create meta create m2 100; ledger $T meta m2 ACTIVE daily 100 '5 minutes'
sync_at $T "'meta'" "$R1" >/dev/null
ledger $T meta m2 PAUSED daily 100 '5 minutes'
sync_at $T "'meta'" "$R2" >/dev/null
check "C-F1: one read at 50 after one at 100 lowers nothing" "$(held_on $T m1)" "100.00"
check "C-F1: one read paused after one on releases nothing" "$(held_on $T m2)" "100.00"
next_hour $T m1; next_hour $T m2
ledger $T meta m1 ACTIVE daily 50 '5 minutes'; ledger $T meta m2 PAUSED daily 100 '5 minutes'
sync_at $T "'meta'" "$H2" >/dev/null
check "C-F1: two reads at 50 lower it to 50" "$(held_on $T m1)" "50.00"
check "C-F1: two reads paused release it" "$(held_on $T m2)" "0"
hold $T c5:create meta create c5 100
ledger $T meta c5 REMOVED daily 100 '5 minutes' campaign
ledger $T meta c5-a ACTIVE campaign_level null '5 minutes' ad_set "'c5'" 60
hold $T c6:create meta create c6 100
ledger $T meta c6-a REMOVED campaign_level null '5 minutes' ad_set "'c6'" 100
ledger $T meta c6-b ACTIVE campaign_level null '5 minutes' ad_set "'c6'" 60
hold $T gx:create meta create gx 100; hold $T gx:raise meta raise gx 100; zavi $T meta gx budget 100 200 gx:raise
ledger $T meta gx ACTIVE daily 80 '5 minutes'
hold $T dp:raise meta raise dp 20; zavi $T meta dp budget 40 60 dp:raise
for i in $(seq 1 34); do
  psql_q -c "select rebase_ad_spend_for_object('$T', 'meta', 'dp', 1, 'dp:cut$i', 0.01)" >/dev/null
  psql_q -c "update ad_budget_reservations set created_at = created_at - interval '1 hour', updated_at = updated_at - interval '1 hour' where object_id = 'dp'" >/dev/null
done
psql_q -c "update ad_budget_reservations set created_at = created_at - interval '50 hours', updated_at = updated_at - interval '50 hours' where object_id = 'dp'" >/dev/null
ledger $T meta dp ACTIVE daily 45 '5 minutes'
sync $T "'meta'" >/dev/null
check "C-F2: a legacy removed campaign row gives way to its live ad sets: holds 60" "$(held_on $T c5)" "60.00"
check "G-F2: a removed ad set's old campaign budget is not the budget: holds 60" "$(held_on $T c6)" "60.00"
check "G-F1 hour 1: holds 80" "$(held_on $T gx)" "80.00"
check "C-F4: 34 rebases deep, the walk stops and counts 0: keeps 19.66" "$(held_on $T dp)" "19.66"
check "G-F1: the replayed create is refused" "$(psql_q -c "select reserve_ad_spend(p_tenant_id => '$T', p_idem_key => 'gx:create', p_platform => 'meta', p_op => 'create', p_object_id => 'gx', p_daily_delta_usd => 99999)->>'status'")" "refused"
check "  and its rebased row is rewritten" "$(psql_q -c "select status || ':' || coalesce(reason, '') from ad_budget_reservations where idem_key = 'gx:create'")" "refused:over_month"
next_hour $T gx
psql_q -c "update ad_campaigns set as_of = now() - interval '5 minutes' where tenant_id = '$T' and object_id = 'gx'"
sync_at $T "'meta'" "$H2" >/dev/null
check "G-F1 hour 2: still 80 while it spends 80 (was 0)" "$(held_on $T gx)" "80.00"
echo "== C-F3 / C-F4 / C-F5 =="
check "C-F3: the read start is the database's clock" "$(psql_q -c "select abs(extract(epoch from ad_budget_read_start('$T') - now())) < 1")" "t"
check "C-F4: the lineage index exists" "$(psql_q -c "select count(*) from pg_indexes where indexname = 'ad_budget_reservations_object_idx'")" "1"
check "C-F4: the sync waits at most 5s for a lock" "$(psql_q -c "select proconfig::text like '%lock_timeout=5s%' from pg_proc where proname = 'sync_ad_holds_to_live' and pronargs = 3")" "t"
hold $T w5:create meta create w5 100
ledger $T meta w5 REMOVED daily 100 '1 second' campaign
ledger $T meta w5-a ACTIVE campaign_level null '5 minutes' ad_set "'w5'" 100
before="$(psql_q -c "select coalesce(sum(daily_delta_usd), 0) from ad_budget_reservations where tenant_id = '$T' and status = 'committed'")"
check "C-F5: the 2-argument form (an old container) does nothing" "$(psql_q -c "select sync_ad_holds_to_live('$T', array['meta','google'])::text")" '{"status": "skipped", "lowered": 0, "released": 0, "released_daily_usd": 0}'
psql_q -c "select sync_ad_holds_to_live('$T', array['meta','google'])" >/dev/null
check "  twice: no read kept for the campaign" "$(psql_q -c "select count(*) from ad_hold_live_reads where object_id = 'w5'")" "0"
check "  every hold as it was" "$(psql_q -c "select coalesce(sum(daily_delta_usd), 0) from ad_budget_reservations where tenant_id = '$T' and status = 'committed'")" "$before"
hold $T gn:create meta create gn 100
ledger $T meta gn PAUSED daily 100 '5 minutes'
sync_at $T "'meta'" "$R1" >/dev/null
hold $T gn:resume meta resume gn 100 false false committed '56 minutes'
sync_at $T "'meta'" "$R2" >/dev/null
check "N3: a stopped read from before Zavi's resume never pairs: nothing released" "$(held_on $T gn)" "200.00"
hold $T rz:resume meta resume rz 100 false false committed '90 minutes'
psql_q -c "select rebase_ad_spend_for_object('$T', 'meta', 'rz', 80, 'rz:cut', 20)" >/dev/null
psql_q -c "update ad_budget_reservations set created_at = '$BASE'::timestamptz - interval '40 minutes', updated_at = '$BASE'::timestamptz - interval '40 minutes' where idem_key = 'rz:cut'"
psql_q -c "update ad_budget_reservations set updated_at = '$BASE'::timestamptz - interval '40 minutes' where idem_key = 'rz:resume'"
ledger $T meta rz PAUSED daily 80 '5 minutes'
sync_at $T "'meta'" "$R1" >/dev/null
sync_at $T "'meta'" "$R2" >/dev/null
check "N3: a stopped read between a folded resume's reserve and its rebase never pairs" "$(held_on $T rz)" "80.00"

echo "== what the sync leaves alone =="
hold $T s1:create meta create s1 100 false false reserved; ledger $T meta s1 PAUSED daily 10 '5 minutes'
hold $T s2:create meta create s2 100 false false committed '1 minute'; ledger $T meta s2 PAUSED daily 10 '5 minutes'
hold $T s3:create meta create s3 100; ledger $T meta s3 PAUSED daily 10 '4 hours'
hold $T s4:create meta create s4 100 true; ledger $T meta s4 PAUSED daily 10 '5 minutes'
hold $T s5:create meta create s5 100 false true; ledger $T meta s5 PAUSED daily 10 '5 minutes'
hold $T s6:create meta create s6 100
hold $T2 x1:create meta create x1 100; ledger $T2 meta x1 PAUSED daily 10 '5 minutes'
hold $T s7:resume meta resume s7 100 false false committed '3 minutes'; ledger $T meta s7 PAUSED daily 10 '1 minute'
hold $T c3:create meta create c3 100 false false committed '10 hours'
ledger $T meta c3-a REMOVED campaign_level null '50 hours' ad_set "'c3'" 60
ledger $T meta c3-b PAUSED campaign_level null '5 minutes' ad_set "'c3'" 60
hold $T s8:resume meta resume s8 100 false false committed '60 minutes'; ledger $T meta s8 PAUSED daily 10 '70 minutes'
sync $T "'meta'" >/dev/null
check "a hold still in flight" "$(psql_q -c "select status from ad_budget_reservations where idem_key = 's1:create'")" "reserved"
check "a hold taken after the read" "$(held_on $T s2)" "100.00"
check "a ledger row this read did not write (4 hours old)" "$(held_on $T s3)" "100.00"
check "a paused create (its one day is the idle release's)" "$(held_on $T s4)" "100.00"
check "a hold the rollover is pausing" "$(held_on $T s5)" "100.00"
check "an object the ledger does not list" "$(held_on $T s6)" "100.00"
check "a row from last hour's read (an account no longer read)" "$(held_on $T s8)" "100.00"
check "a hold taken after the read began, its row written later" "$(held_on $T s7)" "100.00"
check "a campaign budget with an old removed ad set still follows this read" "$(held_on $T c3)" "0"
check "another tenant's rows" "$(held_on $T2 x1)" "100.00"
check "no platforms: nothing" "$(sync $T "")" '{"status": "no_platforms", "lowered": 0, "released": 0}'
psql_q -c "update ad_budgets set status = 'stopped' where tenant_id = '$T2'"
check "no active budget" "$(psql_q -c "select sync_ad_holds_to_live('$T2', array['meta'], $R2)->>'status'")" "no_budget"

echo "== ACL =="
check "authenticated cannot run it" "$(psql_q -c "select has_function_privilege('authenticated', 'public.sync_ad_holds_to_live(uuid, text[], timestamptz)', 'execute')")" "f"
check "anon cannot run it" "$(psql_q -c "select has_function_privilege('anon', 'public.sync_ad_holds_to_live(uuid, text[], timestamptz)', 'execute')")" "f"
check "service_role can" "$(psql_q -c "select has_function_privilege('service_role', 'public.sync_ad_holds_to_live(uuid, text[], timestamptz)', 'execute')")" "t"
for f in "sync_ad_holds_to_live(uuid, text[])" "ad_budget_read_start(uuid)"; do
  check "$f: authenticated cannot run it" "$(psql_q -c "select has_function_privilege('authenticated', 'public.$f', 'execute')")" "f"
  check "$f: anon cannot run it" "$(psql_q -c "select has_function_privilege('anon', 'public.$f', 'execute')")" "f"
  check "$f: service_role can" "$(psql_q -c "select has_function_privilege('service_role', 'public.$f', 'execute')")" "t"
done
check "ad_hold_live_reads: authenticated cannot read it" "$(psql_q -c "select has_table_privilege('authenticated', 'public.ad_hold_live_reads', 'select')")" "f"

echo
if [ "$FAILED" = 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; exit 1; fi
