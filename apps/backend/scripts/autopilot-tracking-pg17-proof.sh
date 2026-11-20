#!/usr/bin/env bash
set -euo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
PORT="${PORT:-55434}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../../../supabase/migrations"
DIR="$(mktemp -d -t autopilot-tracking-pg17)"

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
U=99999999-9999-9999-9999-999999999999    # owner of T
U2=88888888-8888-8888-8888-888888888888   # member of T2 only
ST=77777777-7777-7777-7777-777777777777   # active Zavi staff (no tenant membership)
SR=66666666-6666-6666-6666-666666666666   # revoked staff
R1=c0000000-0000-0000-0000-000000000001   # a run of T
R2=c0000000-0000-0000-0000-000000000003   # another run of T
RX=c0000000-0000-0000-0000-000000000002   # a run of T2
D1=d0000000-0000-0000-0000-000000000001   # a cgo.dispatch-specialist decision of T (made by R2)
D3=d0000000-0000-0000-0000-000000000003   # another class of decision of T
DX=d0000000-0000-0000-0000-000000000002   # a decision of T2
A1=e0000000-0000-0000-0000-000000000001   # a card of T (made by R1)
A2=e0000000-0000-0000-0000-000000000003   # another card of T (made by R2)
AX=e0000000-0000-0000-0000-000000000002   # a card of T2
O1=a0000000-0000-0000-0000-000000000001
O2=a0000000-0000-0000-0000-000000000002
OX=b0000000-0000-0000-0000-000000000001   # an order of T2
F1=f0000000-0000-0000-0000-000000000001   # an offer of T

psql_q <<SQL
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as \$\$ select nullif(current_setting('proof.uid', true), '')::uuid \$\$;
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
insert into public.staff_users values ('$ST', null), ('$SR', now());
create function public._tenant_tier(p uuid) returns text language sql stable as \$\$ select 'pro'::text \$\$;
insert into public.tenants values ('$T'), ('$T2');
insert into public.tenant_users values ('$T', '$U', 'owner'), ('$T2', '$U2', 'owner');
insert into public.agent_runs values ('$R1', '$T'), ('$R2', '$T'), ('$RX', '$T2');
insert into public.decisions values ('$D1', '$T', '$R2', 'cgo.dispatch-specialist'), ('$DX', '$T2', '$RX', 'cgo.dispatch-specialist'),
  ('$D3', '$T', '$R2', 'meta_ads.update_ad_set_budget');
insert into public.channel_actions values ('$A1', '$T', '$R1'), ('$A2', '$T', '$R2'), ('$AX', '$T2', '$RX');
insert into public.creator_offers values ('$F1', '$T');
insert into public.creator_orders values ('$O1', '$T'), ('$O2', '$T'), ('$OX', '$T2');
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
raises() { # $1 name, $2 sql, $3 expected message fragment
  local out; out="$(psql_q -c "$2" 2>&1 || true)"
  check "$1" "$(printf '%s' "$out" | grep -c -- "$3" || true)" "1"
}
today() { psql_q -c "alter database postgres set proof.today = '$1'"; }
today 2026-10-10

echo "== test 1: run -> decision link, tenant-checked =="
check "a run links to its own tenant's decision" "$(psql_q -c "update agent_runs set source_decision_id='$D1' where id='$R1' returning source_decision_id")" "$D1"
raises "a run cannot link to another tenant's decision" "update agent_runs set source_decision_id='$DX' where id='$R1'" "agent_runs_source_decision_fk"
check "a new run takes its decision from payload.source_decision_id, in the same insert" \
  "$(psql_q -c "insert into agent_runs (id, tenant_id, payload) values ('c1000000-0000-0000-0000-000000000001','$T','{\"source_decision_id\":\"$D1\"}') returning source_decision_id")" "$D1"
check "a same-tenant decision of any other class is not copied (a forged key cannot link it)" \
  "$(psql_q -c "insert into agent_runs (id, tenant_id, payload) values ('c1000000-0000-0000-0000-000000000009','$T','{\"source_decision_id\":\"$D3\"}') returning coalesce(source_decision_id::text, 'null')")" "null"
check "another tenant's decision, a card id or junk leaves it null and the run is still created" \
  "$(psql_q -c "insert into agent_runs (id, tenant_id, payload) values ('c1000000-0000-0000-0000-000000000002','$T','{\"source_decision_id\":\"$DX\"}'), ('c1000000-0000-0000-0000-000000000003','$T','{\"source_decision_id\":\"$A1\"}'), ('c1000000-0000-0000-0000-000000000004','$T','{\"source_decision_id\":\"not-a-uuid\"}'), ('c1000000-0000-0000-0000-000000000005','$T','{}')"; psql_q -c "select count(*) from agent_runs where id::text like 'c1000000-%' and source_decision_id is null")" "5"
psql_q -c "delete from agent_runs where id::text like 'c1000000-%'"
raises "an order cannot link to another tenant's card" "update creator_orders set channel_action_id='$AX' where id='$O1'" "creator_orders_channel_action_fk"
raises "an order cannot link to another tenant's run" "update creator_orders set agent_run_id='$RX' where id='$O1'" "creator_orders_agent_run_fk"
raises "an offer cannot link to another tenant's run" "update creator_offers set agent_run_id='$RX' where id='$F1'" "creator_offers_agent_run_fk"
check "an order and an offer link to their own tenant's card and run" \
  "$(psql_q -c "update creator_orders set channel_action_id='$A1', agent_run_id='$R1' where id='$O1'"; psql_q -c "update creator_offers set agent_run_id='$R1', agent_why='Fits the brief' where id='$F1' returning agent_why")" "Fits the brief"
raises "an offer's why is bounded" "update creator_offers set agent_why=repeat('x',1001) where id='$F1'" "creator_offers_agent_why_check"

echo "== test 3: reserve_ad_spend stores the links, tenant-checked, kept on retry =="
psql_q -c "insert into ad_budgets (tenant_id, monthly_usd, started_on, month_start) values ('$T', 1000, '2026-10-01', '2026-10-01')"
check "the old six-argument call still works (no links)" \
  "$(psql_q -c "select reserve_ad_spend('$T','old:create','meta','create',null,1)->>'status'"):$(psql_q -c "select coalesce(channel_action_id::text,'-')||coalesce(decision_id::text,'-') from ad_budget_reservations where idem_key='old:create'")" "held:--"
check "named call with a card: held, card stored" \
  "$(psql_q -c "select reserve_ad_spend(p_tenant_id=>'$T',p_idem_key=>'$A1:create',p_platform=>'meta',p_op=>'create',p_object_id=>null,p_daily_delta_usd=>1,p_channel_action_id=>'$A1')->>'status'"):$(psql_q -c "select channel_action_id from ad_budget_reservations where idem_key='$A1:create'")" "held:$A1"
check "a decision is stored" \
  "$(psql_q -c "select reserve_ad_spend(p_tenant_id=>'$T',p_idem_key=>'$D1:create',p_platform=>'google',p_op=>'create',p_object_id=>null,p_daily_delta_usd=>1,p_decision_id=>'$D1')->>'status'"):$(psql_q -c "select decision_id from ad_budget_reservations where idem_key='$D1:create'")" "held:$D1"
raises "another tenant's card is refused" "select reserve_ad_spend(p_tenant_id=>'$T',p_idem_key=>'x1',p_platform=>'meta',p_op=>'create',p_object_id=>null,p_daily_delta_usd=>1,p_channel_action_id=>'$AX')" "channel action not found for tenant"
raises "another tenant's decision is refused" "select reserve_ad_spend(p_tenant_id=>'$T',p_idem_key=>'x2',p_platform=>'meta',p_op=>'create',p_object_id=>null,p_daily_delta_usd=>1,p_decision_id=>'$DX')" "decision not found for tenant"
check "nothing written by the refused links" "$(psql_q -c "select count(*) from ad_budget_reservations where idem_key in ('x1','x2')")" "0"
check "a retry of the same key (already_held) keeps the card it had" \
  "$(psql_q -c "select reserve_ad_spend(p_tenant_id=>'$T',p_idem_key=>'$A1:create',p_platform=>'meta',p_op=>'create',p_object_id=>null,p_daily_delta_usd=>1,p_channel_action_id=>'$A2')->>'status'"):$(psql_q -c "select channel_action_id from ad_budget_reservations where idem_key='$A1:create'")" "already_held:$A1"
psql_q -c "select settle_ad_spend('$T','$A1:create','released')" >/dev/null
check "a fresh attempt at a released key holds again and keeps its first card" \
  "$(psql_q -c "select reserve_ad_spend(p_tenant_id=>'$T',p_idem_key=>'$A1:create',p_platform=>'meta',p_op=>'create',p_object_id=>null,p_daily_delta_usd=>1,p_channel_action_id=>'$A2')->>'status'"):$(psql_q -c "select channel_action_id from ad_budget_reservations where idem_key='$A1:create'")" "held:$A1"
check "a refused hold still records its card" \
  "$(psql_q -c "select reserve_ad_spend(p_tenant_id=>'$T',p_idem_key=>'$A2:create',p_platform=>'meta',p_op=>'create',p_object_id=>null,p_daily_delta_usd=>100000,p_channel_action_id=>'$A2')->>'status'"):$(psql_q -c "select status||':'||channel_action_id from ad_budget_reservations where idem_key='$A2:create'")" "refused:refused:$A2"

echo "== test 2 (SQL half): reserve_creator_hire stores the card and the approver =="
C1=$(psql_q -c "select record_cgo_creator_caps('$T',300,500,'test caps','$R1')->>'id'")
raises "another tenant's card is refused" "select reserve_creator_hire('$T','h0','$O2',10,'$C1','$AX','$U')" "channel action not found for tenant"
raises "an approver who is not a member is refused" "select reserve_creator_hire('$T','h0','$O2',10,'$C1','$A2','$U2')" "approver is not a member of the tenant"
check "the old five-argument call still works" "$(psql_q -c "select reserve_creator_hire('$T','h9','$O2',1,'$C1')->>'status'")" "reserved"
psql_q -c "select settle_creator_hire('$T','h9','released')" >/dev/null
check "reserved with the card and approver stored" \
  "$(psql_q -c "select reserve_creator_hire('$T','h1','$O1',100,'$C1','$A1','$U')->>'status'"):$(psql_q -c "select channel_action_id||':'||approved_by_user_id from creator_hire_spend where idem_key='h1'")" "reserved:$A1:$U"
check "a retry (already_held) keeps them" \
  "$(psql_q -c "select reserve_creator_hire('$T','h1','$O1',100,'$C1','$A2',null)->>'status'"):$(psql_q -c "select channel_action_id||':'||approved_by_user_id from creator_hire_spend where idem_key='h1'")" "already_held:$A1:$U"

echo "== test 4: a run with money attached cannot be deleted alone; the tenant can =="
raises "deleting R1 (its card A1 carries a hire hold and an ad hold) fails" "delete from agent_runs where id='$R1'" "violates foreign key constraint"
check "R1, A1 and the holds are all still there" "$(psql_q -c "select concat((select count(*) from agent_runs where id='$R1'),(select count(*) from channel_actions where id='$A1'),(select count(*) from creator_hire_spend where idem_key='h1'))")" "111"
raises "deleting R2 (its decision D1 is a run's source and an ad hold's decision) fails" "delete from agent_runs where id='$R2'" "violates foreign key constraint"
raises "deleting the card A1 alone fails" "delete from channel_actions where id='$A1'" "violates foreign key constraint"

echo "== test 5: goal history =="
goal() { psql_q -c "select write_autopilot_goal($1)"; }
G=$(psql_q -c "select write_autopilot_goal('$T','insert',null,'{\"objective\":\"More hosts\",\"target_metric\":\"hosts\",\"target_value\":100,\"due_date\":\"2026-12-31\"}',null,null,'founder','$U',null,null)->>'id'")
check "founder insert: one row, op insert, founder, the user, no run or why" \
  "$(psql_q -c "select count(*)||':'||max(op)||':'||max(changed_by_source)||':'||max(changed_by_user_id::text)||':'||coalesce(max(run_id::text),'-')||':'||coalesce(max(why),'-') from autopilot_goal_changes where goal_id='$G'")" "1:insert:founder:$U:-:-"
check "the insert records the goal's fields from null" \
  "$(psql_q -c "select changed_fields->'target_value'->>'to'||':'||(changed_fields->'target_value'->'from')::text||':'||(changed_fields ? 'updated_at')::text from autopilot_goal_changes where goal_id='$G' and op='insert'")" "100:null:false"
check "cgo update: only the changed column, from -> to, with run and why" \
  "$(psql_q -c "select write_autopilot_goal('$T','update','$G','{\"target_value\":120,\"updated_at\":\"2026-10-10T00:00:00Z\"}','{\"target_value\":100}',array['met','missed'],'cgo',null,'$R1','On pace, so aim higher')->>'status'"):$(psql_q -c "select changed_fields::text||'|'||changed_by_source||'|'||run_id||'|'||why from autopilot_goal_changes where goal_id='$G' and op='update'")" \
  "written:{\"target_value\": {\"to\": 120, \"from\": 100}}|cgo|$R1|On pace, so aim higher"
raises "a cgo write without a run is refused" "select write_autopilot_goal('$T','update','$G','{\"priority\":60}',null,null,'cgo',null,null,'why')" "a cgo write needs its run and why"
raises "a cgo write without a why is refused" "select write_autopilot_goal('$T','update','$G','{\"priority\":60}',null,null,'cgo',null,'$R1','  ')" "a cgo write needs its run and why"
raises "a run of another tenant is refused" "select write_autopilot_goal('$T','update','$G','{\"priority\":60}',null,null,'cgo',null,'$RX','why')" "run not found for tenant"
raises "a founder of another tenant is refused" "select write_autopilot_goal('$T','update','$G','{\"priority\":60}',null,null,'founder','$U2',null,null)" "user is not a member of the tenant"
raises "the tenant column cannot be written" "select write_autopilot_goal('$T','update','$G','{\"tenant_id\":\"$T2\"}',null,null,'system',null,null,null)" "column tenant_id cannot be written"
raises "an unknown column is refused" "select write_autopilot_goal('$T','update','$G','{\"nope\":1}',null,null,'system',null,null,null)" "column nope cannot be written"
check "a stale guard matches nothing and writes no history" \
  "$(psql_q -c "select write_autopilot_goal('$T','update','$G','{\"priority\":60}','{\"target_value\":100}',null,'system',null,null,null)->>'status'"):$(psql_q -c "select count(*) from autopilot_goal_changes where goal_id='$G'")" "not_matched:2"
check "another tenant cannot update T's goal" \
  "$(psql_q -c "select write_autopilot_goal('$T2','update','$G','{\"priority\":1}',null,null,'system',null,null,null)->>'status'"):$(psql_q -c "select priority from autopilot_goals where id='$G'")" "not_matched:50"
check "a null guard matches a null column (baseline_value is null)" \
  "$(psql_q -c "select write_autopilot_goal('$T','update','$G','{\"priority\":55}','{\"baseline_value\":null}',null,'system',null,null,null)->>'status'")" "written"
check "a status line and a new number alone write no history" \
  "$(psql_q -c "select write_autopilot_goal('$T','update','$G','{\"cgo_status_line\":\"On pace\",\"current_value\":40}',null,null,'cgo',null,'$R1','On pace')->>'status'"):$(psql_q -c "select count(*) from autopilot_goal_changes where goal_id='$G'")" "written:3"
check "a direct write (no RPC) is the system's, with no why" \
  "$(psql_q -c "update autopilot_goals set status='paused' where id='$G'"; psql_q -c "select changed_by_source||':'||coalesce(why,'-')||':'||(changed_fields->'status')::text from autopilot_goal_changes where goal_id='$G' order by created_at desc, id limit 1")" 'system:-:{"to": "paused", "from": "active"}'
check "a signed-in user's own direct write is theirs" \
  "$(psql_q -c "begin; select set_config('proof.uid','$U',true); update autopilot_goals set status='active' where id='$G'; commit;" >/dev/null; psql_q -c "select changed_by_source||':'||changed_by_user_id from autopilot_goal_changes where goal_id='$G' and op='update' and changed_fields->'status'->>'to'='active'")" "founder:$U"
check "the RPC's who/why do not leak onto a later write in the same transaction" \
  "$(psql_q -c "begin; select write_autopilot_goal('$T','update','$G','{\"priority\":70}',null,null,'cgo',null,'$R1','first'); update autopilot_goals set priority=71 where id='$G'; commit;" >/dev/null; psql_q -c "select string_agg(changed_by_source||'/'||coalesce(why,'-'), ',' order by (changed_fields->'priority'->>'to')::int) from autopilot_goal_changes where goal_id='$G' and (changed_fields->'priority'->>'to')::int in (70,71)")" "cgo/first,system/-"
check "status_not_in keeps a write off a finished goal" \
  "$(psql_q -c "update autopilot_goals set status='met' where id='$G'"; psql_q -c "select write_autopilot_goal('$T','update','$G','{\"priority\":1}',null,array['met','missed'],'founder','$U',null,null)->>'status'")" "not_matched"
check "founder delete: one row, op delete, the fields go to null" \
  "$(psql_q -c "select write_autopilot_goal('$T','delete','$G',null,null,null,'founder','$U',null,null)->>'status'"):$(psql_q -c "select changed_by_source||':'||(changed_fields->'objective'->>'from')||':'||(changed_fields->'objective'->'to')::text from autopilot_goal_changes where goal_id='$G' and op='delete'")" "written:founder:More hosts:null"
check "a system insert with a why" \
  "$(psql_q -c "select write_autopilot_goal('$T','insert',null,'{\"objective\":\"B\",\"target_metric\":\"m\",\"target_value\":1}',null,null,'system',null,null,'seeded')->>'status'"):$(psql_q -c "select changed_by_source||':'||why from autopilot_goal_changes where op='insert' and changed_fields->'objective'->>'to'='B'")" "written:system:seeded"
check "a staff write records the staff user" \
  "$(psql_q -c "select write_autopilot_goal('$T','insert',null,'{\"objective\":\"S\",\"target_metric\":\"m\",\"target_value\":2}',null,null,'staff','$ST',null,'Coach set it')->>'status'"):$(psql_q -c "select changed_by_source||':'||changed_by_user_id||':'||why from autopilot_goal_changes where op='insert' and changed_fields->'objective'->>'to'='S'")" "written:staff:$ST:Coach set it"
raises "revoked staff is refused" "select write_autopilot_goal('$T','insert',null,'{\"objective\":\"S2\",\"target_metric\":\"m\",\"target_value\":2}',null,null,'staff','$SR',null,null)" "user is not active staff"
raises "a staff write needs the user" "select write_autopilot_goal('$T','insert',null,'{\"objective\":\"S2\",\"target_metric\":\"m\",\"target_value\":2}',null,null,'staff',null,null,null)" "a staff write needs the user"
raises "a system write cannot name a user" "select write_autopilot_goal('$T','insert',null,'{\"objective\":\"S2\",\"target_metric\":\"m\",\"target_value\":2}',null,null,'system','$U',null,null)" "only a founder or staff write names a user"
raises "an insert takes no goal id" "select write_autopilot_goal('$T','insert','$G','{\"objective\":\"B\"}',null,null,'system',null,null,null)" "an insert takes no goal id"

echo "== test 10: grants and RLS =="
check "autopilot_goal_changes: RLS on; authenticated read only; service_role read only; anon nothing" \
  "$(psql_q -c "select relrowsecurity::text || has_table_privilege('authenticated','autopilot_goal_changes','select')::text || has_table_privilege('authenticated','autopilot_goal_changes','insert')::text || has_table_privilege('service_role','autopilot_goal_changes','select')::text || has_table_privilege('service_role','autopilot_goal_changes','insert')::text || has_table_privilege('service_role','autopilot_goal_changes','update')::text || has_table_privilege('anon','autopilot_goal_changes','select')::text from pg_class where relname='autopilot_goal_changes'")" \
  "truetruefalsetruefalsefalsefalse"
for fn in "reserve_ad_spend(uuid,text,text,text,text,numeric,uuid,uuid)" "reserve_creator_hire(uuid,text,uuid,numeric,uuid,uuid,uuid)" \
          "write_autopilot_goal(uuid,text,uuid,jsonb,jsonb,text[],text,uuid,uuid,text)"; do
  check "$fn: not for anon/authenticated/public, granted to service_role, security definer" \
    "$(psql_q -c "select has_function_privilege('anon','$fn','execute')::text || has_function_privilege('authenticated','$fn','execute')::text || has_function_privilege('service_role','$fn','execute')::text || (select prosecdef::text from pg_proc where oid = '$fn'::regprocedure)")" "falsefalsetruetrue"
done
check "the trigger function runs for nobody directly" \
  "$(psql_q -c "select has_function_privilege('authenticated','_autopilot_goal_history()','execute')::text || has_function_privilege('service_role','_autopilot_goal_history()','execute')::text")" "falsefalse"
check "the old signatures are gone (one of each)" \
  "$(psql_q -c "select count(*) from pg_proc where proname in ('reserve_ad_spend','reserve_creator_hire')")" "2"

echo "== test 4: the tenant delete still succeeds =="
check "delete from tenants removes T with its runs, cards, holds, goals and history" \
  "$(psql_q -c "delete from tenants where id='$T'"; psql_q -c "select concat((select count(*) from agent_runs where tenant_id='$T'),(select count(*) from channel_actions where tenant_id='$T'),(select count(*) from creator_hire_spend where tenant_id='$T'),(select count(*) from ad_budget_reservations where tenant_id='$T'),(select count(*) from autopilot_goals where tenant_id='$T'),(select count(*) from autopilot_goal_changes where tenant_id='$T'))")" "000000"
check "T2 is untouched" "$(psql_q -c "select count(*) from agent_runs where tenant_id='$T2'")" "1"

echo; if [ "$FAILED" = 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; exit 1; fi
