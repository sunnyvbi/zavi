#!/usr/bin/env bash
set -euo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
PORT="${PORT:-55437}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../../../supabase/migrations"
DIR="$(mktemp -d -t ad-money-book-pg17)"

cleanup() {
  "$PGBIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DIR/data" -U postgres -A trust >/dev/null
"$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR" -l "$DIR/log" -w start >/dev/null

psql_q() { "$PGBIN/psql" -h "$DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }

psql_q <<'SQL'
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create function public.app_active_tenant() returns uuid language sql stable as $$ select null::uuid $$;
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
create function public._tenant_tier(p uuid) returns text language sql stable as $$ select 'pro'::text $$;
create table tenant_channels(tenant_id uuid references tenants,channel_slug text,autorun boolean default false,autorun_set_by text,primary key(tenant_id,channel_slug));
create table decision_classes(slug text primary key, description text, default_autonomy text, dispatch_handler text, never_auto boolean);
SQL
for m in 20260928210000_ad_budget_core 20260928230000_ad_budget_setup_ledger 20260928230100_ad_budget_reconcile \
         20260928233000_ad_budget_end_pauses 20260929010000_ad_budget_monthly 20260929210000_ad_budget_events \
         20260930010000_ad_ledger 20260930020000_ad_ledger_removed_objects 20260930030000_ad_budget_brake \
         20260930193700_ad_object_changes 20261005090000_creator_hire_budget 20261005140000_autopilot_tracking_links \
         20261012110000_cgo_spend_pace_holds 20261012140000_cgo_spend_holds_cbo_and_freshness \
         20261013110000_cgo_cbo_holds_ignore_stale_children 20261016180000_cgo_holds_removed_objects_and_cbo_budget \
         20261017100000_cgo_unknown_ad_holds 20261021120000_cgo_inflight_ad_holds \
         20261022140000_ad_budget_raise_holds_increase 20260909200000_set_channel_autorun \
         20261023125328_chatgpt_growth_autopilot; do
  psql_q -f "$MIG/$m.sql" >/dev/null
done
psql_q -c "create or replace function public._ad_budget_today() returns date language sql stable as \$\$ select date '2026-10-12' \$\$;"

T=11111111-1111-1111-1111-111111111111
T2=22222222-2222-2222-2222-222222222222
pass=0; fail=0
check() { # name, got, want
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "ok    $1"; else fail=$((fail + 1)); echo "FAIL  $1: got [$2] want [$3]"; fi
}
raises() { # name, sql, needle
  local out
  if out="$("$PGBIN/psql" -h "$DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt -c "$2" 2>&1)"; then
    fail=$((fail + 1)); echo "FAIL  $1: did not raise ($out)"
  elif echo "$out" | grep -q "$3"; then pass=$((pass + 1)); echo "ok    $1"
  else fail=$((fail + 1)); echo "FAIL  $1: raised something else: $out"; fi
}

psql_q <<SQL
insert into tenants values ('$T'), ('$T2');
insert into ad_budgets (tenant_id, monthly_usd, started_on, month_start, spent_usd, actual_read_at)
  values ('$T', 10000, '2026-09-01', '2026-10-01', 2000, now()), ('$T2', 500, '2026-09-01', '2026-10-01', 0, now());
SQL
B="$(psql_q -c "select id from ad_budgets where tenant_id = '$T'")"
B2="$(psql_q -c "select id from ad_budgets where tenant_id = '$T2'")"

gate_md5() {
  psql_q -c "select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.proname, p.oid::text)) from pg_proc p
              where p.pronamespace = 'public'::regnamespace
                and p.proname in ('reserve_ad_spend', '_ad_budget_held_usd', 'ad_budget_month_view', 'settle_ad_spend',
                                  'rebase_ad_spend_for_object', 'record_ad_budget_actual', 'reserve_creator_hire', 'update_ad_budget')"
}
before="$(gate_md5)"
psql_q -f "$MIG/20261028090000_ad_money_book_snapshot_shadow.sql" >/dev/null
check "the gate and every money function are byte-identical after the migration" "$(gate_md5)" "$before"
psql_q -f "$MIG/20261028090000_ad_money_book_snapshot_shadow.sql" >/dev/null
check "the migration can be applied twice" "$(gate_md5)" "$before"

psql_q -c "select reserve_ad_spend('$T', 'd1:raise', 'meta', 'raise', 'as1', 300)" >/dev/null
psql_q -c "select settle_ad_spend('$T', 'd1:raise', 'committed', 'as1')" >/dev/null
psql_q -c "select reserve_ad_spend('$T2', 'x1:raise', 'meta', 'raise', 'zz9', 5)" >/dev/null
H="$(psql_q -c "select id from ad_budget_reservations where tenant_id = '$T' and idem_key = 'd1:raise'")"

snap() { # tenant, budget, read_started_at, expected_rest
  psql_q -c "select record_ad_budget_snapshot('$1', '$2', '2026-10-01', '$3',
    '{\"expected_rest\": $4, \"ceiling_rest\": 3000}'::jsonb,
    '[{\"platform\":\"meta\",\"account_id\":\"act_1\",\"object_id\":\"as1\",\"expected_daily_usd\":150}]'::jsonb,
    array['meta'], array['google'], array['$H']::uuid[], '{\"v\":1,\"accounts\":[\"meta:act_1\"],\"objects\":{\"meta:act_1:as1\":{\"s\":\"daily:150::1\"}}}'::jsonb)"
}
check "the first snapshot is stored as generation 1" "$(snap "$T" "$B" "$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ)" 3000)" '{"status": "stored", "generation": 1}'
check "a newer read replaces it as generation 2" "$(snap "$T" "$B" "$(date -u -v-5M +%Y-%m-%dT%H:%M:%SZ)" 3100)" '{"status": "stored", "generation": 2}'
check "an older read is not stored" "$(snap "$T" "$B" "$(date -u -v-60M +%Y-%m-%dT%H:%M:%SZ)" 9999)" '{"status": "stale", "generation": null}'
check "the snapshot keeps its memory for the next one" "$(psql_q -c "select memory->'objects'->'meta:act_1:as1'->>'s' from ad_budget_snapshots where budget_id = '$B'")" "daily:150::1"
check "one row per budget, the newer one" "$(psql_q -c "select count(*), max(generation), max(totals->>'expected_rest') from ad_budget_snapshots where budget_id = '$B'")" "1|2|3100"
raises "a snapshot for another tenant's budget is refused" "$(echo "select record_ad_budget_snapshot('$T2', '$B', '2026-10-01', now(), '{}'::jsonb, '[]'::jsonb, '{}', '{}', '{}', '{}'::jsonb)")" "budget not found for tenant"
raises "a read start in the future is refused" "$(echo "select record_ad_budget_snapshot('$T', '$B', '2026-10-01', now() + interval '1 hour', '{}'::jsonb, '[]'::jsonb, '{}', '{}', '{}', '{}'::jsonb)")" "read start is in the future"
raises "a month that is not a first day is refused" "$(echo "select record_ad_budget_snapshot('$T', '$B', '2026-10-02', now(), '{}'::jsonb, '[]'::jsonb, '{}', '{}', '{}', '{}'::jsonb)")" "first of a month"

ctx="select ad_budget_shadow_context('$T')"
check "the context carries this month's numbers as the gate reads them" \
  "$(psql_q -c "with c as ($ctx as j) select j->'view'->>'id', j->'view'->>'month_cap_usd', j->'view'->>'spent_usd', j->'view'->>'held_usd', j->'view'->>'days_left' from c")" "$B|10000.00|2000.00|6000.00|20"
check "the context carries the latest snapshot without its object rows" \
  "$(psql_q -c "with c as ($ctx as j) select j->'snapshot'->>'generation', j->'snapshot'->'totals'->>'expected_rest', j->'snapshot' ? 'objects', j->'snapshot'->'reflected_hold_ids'->>0 = '$H', j->'snapshot'->'unread_platforms'->>0 from c")" "2|3100|f|t|google"
check "the context lists this tenant's live holds only" \
  "$(psql_q -c "with c as ($ctx as j) select jsonb_array_length(j->'open_holds'), j->'open_holds'->0->>'idem_key', j->'open_holds'->0->>'daily_delta_usd', j->'open_holds'->0->>'status', j->>'open_holds_truncated' from c")" "1|d1:raise|300.00|committed|false"
check "another tenant sees its own budget and holds and no snapshot" \
  "$(psql_q -c "with c as (select ad_budget_shadow_context('$T2') as j) select j->'view'->>'id', j->'snapshot' = 'null'::jsonb, j->'open_holds'->0->>'idem_key' from c")" "$B2|t|x1:raise"
check "a tenant with no budget gets an empty context" \
  "$(psql_q -c "select ad_budget_shadow_context('33333333-3333-3333-3333-333333333333')")" '{"view": null, "snapshot": null, "open_holds": [], "open_holds_truncated": false}'

row() { echo "{\"budget_id\":\"$1\",\"idem_key\":\"d9:raise\",\"platform\":\"meta\",\"op\":\"raise\",\"object_id\":\"as2\",\"daily_delta_usd\":120,\"real_verdict\":\"refused\",\"real_reason\":\"over_month\",\"real_amount_usd\":2400,\"real_room_usd\":2000,\"shadow_verdict\":\"$2\",\"shadow_note\":null,\"shadow_change_usd\":2400,\"shadow_open_auth_usd\":0,\"shadow_expected_room_usd\":5000,\"shadow_ceiling_room_usd\":5000,\"snapshot_generation\":2,\"snapshot_age_s\":300}"; }
check "a verdict row is recorded" "$(psql_q -c "select record_ad_budget_shadow_verdict('$T', '$(row "$B" would_allow)'::jsonb)->>'status'")" "recorded"
check "the row keeps both answers" \
  "$(psql_q -c "select tenant_id, real_verdict, real_reason, real_room_usd, shadow_verdict, shadow_expected_room_usd, snapshot_generation, object_id from ad_budget_shadow_verdicts")" "$T|refused|over_month|2000.00|would_allow|5000.00|2|as2"
raises "a verdict for another tenant's budget is refused" "$(echo "select record_ad_budget_shadow_verdict('$T2', '$(row "$B" would_allow)'::jsonb)")" "budget not found for tenant"
raises "an unknown shadow verdict is refused by the table" "$(echo "select record_ad_budget_shadow_verdict('$T', '$(row "$B" maybe)'::jsonb)")" "ad_budget_shadow_verdicts_shadow_verdict_check"
check "a refused write stored nothing" "$(psql_q -c "select count(*) from ad_budget_shadow_verdicts")" "1"

as_role() { "$PGBIN/psql" -h "$DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt -c "set role $1; $2" 2>&1 || true; }
for role in anon authenticated; do
  for t in ad_budget_snapshots ad_budget_shadow_verdicts; do
    check "$role cannot read $t" "$(as_role "$role" "select count(*) from $t" | grep -c 'permission denied')" "1"
  done
  check "$role cannot store a snapshot" "$(as_role "$role" "select record_ad_budget_snapshot('$T', '$B', '2026-10-01', now(), '{}'::jsonb, '[]'::jsonb, '{}', '{}', '{}', '{}'::jsonb)" | grep -c 'permission denied')" "1"
  check "$role cannot read the context" "$(as_role "$role" "select ad_budget_shadow_context('$T')" | grep -c 'permission denied')" "1"
  check "$role cannot record a verdict" "$(as_role "$role" "select record_ad_budget_shadow_verdict('$T', '{}'::jsonb)" | grep -c 'permission denied')" "1"
done
check "the service role reads both tables" "$(as_role service_role "select (select count(*) from ad_budget_snapshots), (select count(*) from ad_budget_shadow_verdicts)")" "1|1"
check "the service role cannot write a snapshot row directly" "$(as_role service_role "update ad_budget_snapshots set generation = 99" | grep -c 'permission denied')" "1"
check "the service role cannot write a verdict row directly" "$(as_role service_role "delete from ad_budget_shadow_verdicts" | grep -c 'permission denied')" "1"
check "the service role reads the context" "$(as_role service_role "select ad_budget_shadow_context('$T')->'snapshot'->>'generation'")" "2"
check "with RLS on and no policy, a role that does not bypass RLS reads no rows even with a grant" \
  "$(psql_q -c "create role plain; grant select on ad_budget_snapshots to plain; set role plain; select count(*) from ad_budget_snapshots")" "0"
check "RLS is on for both tables" "$(psql_q -c "select count(*) from pg_class where relname in ('ad_budget_snapshots', 'ad_budget_shadow_verdicts') and relrowsecurity")" "2"
check "neither table has a policy" "$(psql_q -c "select count(*) from pg_policies where tablename in ('ad_budget_snapshots', 'ad_budget_shadow_verdicts')")" "0"

check "the gate still refuses over the month" "$(psql_q -c "select reserve_ad_spend('$T', 'd2:raise', 'meta', 'raise', 'as2', 120)->>'reason'")" "over_month"
check "deleting a budget takes its snapshot and verdicts with it" \
  "$(psql_q -c "delete from ad_budgets where id = '$B'; select (select count(*) from ad_budget_snapshots), (select count(*) from ad_budget_shadow_verdicts)")" "0|0"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
