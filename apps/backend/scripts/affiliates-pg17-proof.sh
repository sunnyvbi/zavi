#!/usr/bin/env bash
set -euo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
PORT="${PORT:-55441}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../../../supabase/migrations"
DIR="$(mktemp -d -t affiliates-pg17)"
cleanup() { "$PGBIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DIR/data" -U postgres -A trust >/dev/null
"$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR" -l "$DIR/log" -w start >/dev/null
psql_q() { "$PGBIN/psql" -h "$DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }

psql_q <<'SQL'
create role anon; create role authenticated; create role service_role;
create extension if not exists pgcrypto;
create schema auth;
create table auth.users (id uuid primary key, email text);
create table public.tenants (id uuid primary key);
create table public.tenant_users (tenant_id uuid, user_id uuid);
create table public.human_members (id uuid primary key, auth_user_id uuid, vetting_state text);
SQL
psql_q -f "$MIG/20261101200000_affiliates.sql" >/dev/null
psql_q -f "$MIG/20261117062529_affiliate_attribution_auth_boundary.sql" >/dev/null

psql_q <<'SQL'
alter role service_role bypassrls;
grant usage on schema public, auth to service_role;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
SQL

FAILED=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1 ($2)"; else echo "FAIL  $1: expected [$3], got [$2]"; FAILED=1; fi; }
fails() { if psql_q -c "$2" >/dev/null 2>&1; then echo "FAIL  $1: statement succeeded"; FAILED=1; else echo "PASS  $1 (refused)"; fi; }

fails "service_role still cannot read auth users directly" "set role service_role; select email from auth.users"
check "anonymous cannot execute attribution" "$(psql_q -c "select has_function_privilege('anon', 'public.affiliate_attribute(uuid,uuid,text,text,uuid)', 'execute')")" "f"
check "authenticated cannot execute attribution" "$(psql_q -c "select has_function_privilege('authenticated', 'public.affiliate_attribute(uuid,uuid,text,text,uuid)', 'execute')")" "f"
check "attribution uses its guarded owner" "$(psql_q -c "select prosecdef from pg_proc where oid='public.affiliate_attribute(uuid,uuid,text,text,uuid)'::regprocedure")" "t"
check "attribution pins public before temporary objects" "$(psql_q -c "select 'search_path=public, pg_temp' = any(proconfig) from pg_proc where oid='public.affiliate_attribute(uuid,uuid,text,text,uuid)'::regprocedure")" "t"

psql_q <<'SQL'
create role affiliate_owner_nobypass;
grant usage, create on schema public to affiliate_owner_nobypass;
grant usage on schema auth to affiliate_owner_nobypass;
grant select on auth.users to affiliate_owner_nobypass;
alter function public.affiliate_attribute(uuid,uuid,text,text,uuid) owner to affiliate_owner_nobypass;
SQL
if psql_q -f "$MIG/20261117062529_affiliate_attribution_auth_boundary.sql" >/dev/null 2>&1; then
  echo "FAIL owner without RLS bypass accepted"; FAILED=1
else
  echo "PASS owner without RLS bypass refused"
fi
psql_q -c "alter function public.affiliate_attribute(uuid,uuid,text,text,uuid) owner to postgres"
psql_q -f "$MIG/20261117062529_affiliate_attribution_auth_boundary.sql" >/dev/null

psql_q -c "create table public.system_config (id int primary key, blob jsonb, updated_at timestamptz); insert into public.system_config values (1, '{\"unrelated_key\":42}', now())"
psql_q -f "$HERE/../../../docs/qa-reports/creator-referrals-staging.sql" >/dev/null
check "staging flag enabled without replacing other config" "$(psql_q -c "select (blob->>'creator_hires_enabled') || ':' || (blob->>'unrelated_key') from system_config where id=1")" "true:42"
psql_q -f "$HERE/../../../docs/qa-reports/creator-referrals-staging.sql" >/dev/null
check "staging SQL can be replayed" "$(psql_q -c "select blob->>'creator_hires_enabled' from system_config where id=1")" "true"
psql_q -c "update system_config set blob=jsonb_set(blob, '{creator_hires_enabled}', 'false'); alter function public.affiliate_attribute(uuid,uuid,text,text,uuid) security invoker"
if psql_q -f "$HERE/../../../docs/qa-reports/creator-referrals-staging.sql" >/dev/null 2>&1; then echo "FAIL explicit disable overwritten"; FAILED=1; else echo "PASS explicit disable refused"; fi
check "failed staging apply rolls back function change" "$(psql_q -c "select prosecdef from pg_proc where oid='public.affiliate_attribute(uuid,uuid,text,text,uuid)'::regprocedure")" "f"
check "explicit false preserved" "$(psql_q -c "select blob->>'creator_hires_enabled' from system_config where id=1")" "false"
psql_q -f "$MIG/20261117062529_affiliate_attribution_auth_boundary.sql" >/dev/null

M=11111111-0000-0000-0000-000000000001   # approved creator
U=22222222-0000-0000-0000-000000000001   # their login
P=11111111-0000-0000-0000-000000000002   # pending creator
T1=33333333-0000-0000-0000-000000000001; T2=33333333-0000-0000-0000-000000000002; T3=33333333-0000-0000-0000-000000000003
psql_q <<SQL
insert into auth.users values ('$U', 'Creator@Example.com'), ('22222222-0000-0000-0000-000000000002', 'p@x.com');
insert into human_members values ('$M', '$U', 'approved'), ('$P', '22222222-0000-0000-0000-000000000002', 'pending');
insert into tenants values ('$T1'), ('$T2'), ('$T3');
insert into tenant_users values ('$T3', '$U');
insert into affiliate_codes (member_id, code) values ('$M', 'abcdefgh'), ('$P', 'pendpend');
SQL
CLICK=$(psql_q -c "insert into affiliate_clicks (code) values ('abcdefgh') returning id")
OLD=$(psql_q -c "insert into affiliate_clicks (code, clicked_at) values ('abcdefgh', now() - interval '61 days') returning id")
PCLICK=$(psql_q -c "insert into affiliate_clicks (code) values ('pendpend') returning id")
attr() { psql_q -c "set role service_role; select affiliate_attribute('$1', '$2', '$3', '$4', ${5:-null})->>'outcome'"; }

check "expired click is refused"            "$(attr $T1 $OLD activate a@b.com)" "expired"
check "unapproved creator is refused"       "$(attr $T1 $PCLICK activate a@b.com)" "not_eligible"
check "creator's own tenant is refused"     "$(attr $T3 $CLICK activate a@b.com)" "self_referral"
check "creator's own email is refused"      "$(attr $T2 $CLICK activate ' creator@example.COM ')" "self_referral"
check "unknown click is refused"            "$(attr $T1 44444444-0000-0000-0000-000000000000 activate a@b.com)" "unknown_click"
OLDU=22222222-0000-0000-0000-000000000009
psql_q -c "insert into tenant_users values ('$T2', '$OLDU')"
check "an existing customer's new workspace is refused" "$(attr $T1 $CLICK activate a@b.com "'$OLDU'")" "existing_customer"
check "  ...at the checkout door too"         "$(attr $T1 $CLICK checkout '' "'$OLDU'")" "existing_customer"
check "a valid click attributes"            "$(attr $T1 $CLICK activate a@b.com)" "attributed"
check "first attribution is final"          "$(attr $T1 $CLICK checkout a@b.com)" "already_attributed"
fails "a bad door is refused"               "select affiliate_attribute('$T2', '$CLICK', 'email', 'a@b.com', null)"

A='2026-10-01T00:00:00Z'
entry() { # key amount month rate base
  echo "{\"source_key\":\"$1\",\"amount_cents\":$2,\"invoice_id\":\"in_1\",\"month_index\":$3,\"rate\":$4,\"base_cents\":$5,\"matures_at\":\"2026-10-31T00:00:00Z\"}"
}
accrue() { psql_q -c "select affiliate_accrue('$1', '$2', $3, true, ${6:-null}, '$4', '[$5]'::jsonb)->>'outcome'"; }
total() { psql_q -c "select coalesce(sum(amount_cents),0) from affiliate_entries where charge_id = '$1'"; }
refund() { psql_q -c "select affiliate_refund('$1', $2)" >/dev/null; }
dispute() { psql_q -c "select affiliate_dispute('$1', '$2', $3, '$4')" >/dev/null; }

check "accrue on a referred tenant"         "$(accrue $T1 ch_1 2000 $A "$(entry in_1:li_1:1 2000 1 1.0 2000)")" "accrued"
check "  ...commission 100% of month 1"     "$(total ch_1)" "2000"
check "replay adds nothing"                 "$(accrue $T1 ch_1 2000 $A "$(entry in_1:li_1:1 2000 1 1.0 2000)")" "accrued"
check "  ...still one commission"           "$(total ch_1)" "2000"
check "not-referred tenant is ignored"      "$(accrue $T2 ch_x 2000 $A "$(entry k:x 2000 1 1.0 2000)")" "not_referred"
check "a different anchor is refused"       "$(accrue $T1 ch_2 2000 '2026-11-01T00:00:00Z' "$(entry in_2:li_1:2 2000 2 1.0 2000)")" "anchor_moved"

refund ch_1 500
check "partial refund 25% -> net 1500"      "$(total ch_1)" "1500"
refund ch_1 500
check "the same cumulative refund again"    "$(total ch_1)" "1500"
refund ch_1 1000
check "cumulative refund 50% -> net 1000"   "$(total ch_1)" "1000"
dispute dp_w ch_1 2000 warning_needs_response
check "an inquiry takes nothing"            "$(total ch_1)" "1000"
dispute dp_w ch_1 2000 warning_closed
check "  ...and closing it changes nothing" "$(total ch_1)" "1000"
dispute dp_1 ch_1 500 needs_response
check "a partial dispute takes its own amount (25% more)" "$(total ch_1)" "500"
dispute dp_1 ch_1 500 under_review
check "  ...repeated status, same"          "$(total ch_1)" "500"
dispute dp_1 ch_1 500 won
check "  ...won: restored"                  "$(total ch_1)" "1000"
dispute dp_1 ch_1 500 needs_response
check "  ...an older open status after won is ignored" "$(total ch_1)" "1000"
dispute dp_2 ch_1 1000 lost
check "a second, lost dispute takes its amount" "$(total ch_1)" "0"

refund ch_3 600
psql_q -c "select affiliate_credit_note('cn_0', 'ch_3', 400, false)" >/dev/null
check "early facts are kept"                "$(psql_q -c "select (select refunded_cents from affiliate_refunds where charge_id='ch_3') || ':' || (select amount_cents from affiliate_credit_notes where id='cn_0')")" "600:400"
accrue $T1 ch_3 2000 $A "$(entry in_3:li_1:2 2000 2 1.0 2000)" >/dev/null
check "  ...applied when the commission lands (50% kept)" "$(total ch_3)" "1000"
psql_q -c "select affiliate_credit_note('cn_0', 'ch_3', 400, true)" >/dev/null
check "a voided credit note stops counting (70% kept)" "$(total ch_3)" "1400"
psql_q -c "select affiliate_credit_note('cn_0', 'ch_3', 400, false)" >/dev/null
check "  ...and a late 'created' cannot un-void it" "$(total ch_3)" "1400"

fails "journal rows cannot be edited"       "update affiliate_entries set amount_cents = 1 where charge_id = 'ch_3'"
fails "journal rows cannot be deleted"      "delete from affiliate_entries where charge_id = 'ch_3'"

claim() { psql_q -c "select affiliate_payout_claim('$M', 2000, true, now())->>'$1'"; }
check "below the minimum: nothing claimed"  "$(claim outcome)" "below_minimum"
check "test-mode rows are never claimed for live" "$(psql_q -c "select affiliate_payout_claim('$M', 1, false, now())->>'outcome'")" "below_minimum"
accrue $T1 ch_4 2000 $A "$(entry in_4:li_1:3 600 3 0.3 2000)" >/dev/null
check "2000 reached: first payout waits for approval" "$(claim outcome)" "awaiting_approval"
PAY=$(psql_q -c "select id from affiliate_payouts where member_id='$M'")
check "  ...amount is the net"              "$(psql_q -c "select amount_cents from affiliate_payouts where id='$PAY'")" "2000"

refund ch_4 2000
check "refund before send: rebuilt under the minimum -> cancelled" "$(claim outcome)" "cancelled"
check "  ...its rows are back"              "$(psql_q -c "select count(*) from affiliate_entries where payout_id='$PAY'")" "0"
accrue $T1 ch_5 2000 $A "$(entry in_5:li_1:4 2600 4 0.3 8667)" >/dev/null
check "new claim nets the refund (1400 + 600 - 600 + 2600)" "$(claim amount_cents)" "4000"
PAY=$(psql_q -c "select id from affiliate_payouts where member_id='$M' and state='awaiting_approval'")
mv_() { psql_q -c "select affiliate_payout_move('$PAY', '$1', '$2', '$3', null, null)->>'outcome'"; }
fails "skipping approval is refused"        "select affiliate_payout_move('$PAY', 'awaiting_approval', 'sent', 'tr_x', null, null)"
check "approve"                             "$(mv_ awaiting_approval claimed '')" "moved"
check "transfer starts"                     "$(mv_ claimed transferring '')" "moved"
check "a claim while a transfer is in flight" "$(claim outcome)" "payout_in_flight"
fails "sent without a transfer id"          "select affiliate_payout_move('$PAY', 'transferring', 'sent', '', null, null)"
check "sent"                                "$(mv_ transferring sent tr_1)" "moved"

refund ch_5 2600
check "refund after payout: an open negative row" "$(psql_q -c "select sum(amount_cents) from affiliate_entries where member_id='$M' and payout_id is null")" "-2600"
REV=$(psql_q -c "select affiliate_reversal_claim('$M', true)->>'reversal_id'")
check "  ...a reversal is claimed for the debt" "$(psql_q -c "select amount_cents || ':' || state from affiliate_reversals where id='$REV'")" "2600:claimed"
check "  ...only one open reversal"         "$(psql_q -c "select affiliate_reversal_claim('$M', true)->>'outcome'")" "open"
check "  ...and no claim nets the same debt meanwhile" "$(claim outcome)" "reversal_open"
check "  ...start recomputes and moves it to reconcile" "$(psql_q -c "select affiliate_reversal_start('$REV')->>'outcome'")" "reconcile"
psql_q -c "select affiliate_reversal_move('$REV', 'reconcile', 'sent', 'trr_1', null)" >/dev/null
check "  ...recovered: the debt is cancelled" "$(psql_q -c "select sum(amount_cents) from affiliate_entries where member_id='$M' and payout_id is null")" "0"
check "  ...no debt left to reverse"        "$(psql_q -c "select affiliate_reversal_claim('$M', true)->>'outcome'")" "no_debt"

accrue $T1 ch_6 2500 $A "$(entry in_6:li_1:5 2500 5 0.3 8000)" >/dev/null
check "next payout (not first) is claimed"  "$(claim outcome)" "claimed"
PAY2=$(psql_q -c "select id from affiliate_payouts where member_id='$M' and state='claimed'")
psql_q -c "select affiliate_payout_move('$PAY2', 'claimed', 'failed', null, 'card_declined', null)" >/dev/null
check "a failed transfer releases its rows" "$(psql_q -c "select count(*) from affiliate_entries where payout_id='$PAY2'")" "0"

accrue $T1 ch_s1 2600 $A "$(entry in_s1:li_1:6 2600 6 0.3 8667)" >/dev/null
claim outcome >/dev/null
PS=$(psql_q -c "select id from affiliate_payouts where member_id='$M' and state='claimed'")
refund ch_s1 1300
check "start absorbs a late refund: sends the net" "$(psql_q -c "select affiliate_payout_start('$PS', 2000, 'acct_test1', now())->>'amount_cents'")" "$(psql_q -c "select sum(amount_cents) from affiliate_entries where payout_id='$PS'")"
psql_q -c "select affiliate_payout_move('$PS', 'transferring', 'failed', null, 'test', null)" >/dev/null
check "member scan is distinct in the database" "$(psql_q -c "select count(*) from affiliate_members_to_visit(true, null, 10)")" "1"

( psql_q -c "select affiliate_payout_claim('$M', 2000, true, now())->>'outcome'" >"$DIR/a.out" 2>&1 ) &
( psql_q -c "select affiliate_payout_claim('$M', 2000, true, now())->>'outcome'" >"$DIR/b.out" 2>&1 ) &
wait
check "two racing claims: one payout"       "$(psql_q -c "select count(*) from affiliate_payouts where member_id='$M' and state='claimed'")" "1"

accrue $T1 ch_7 3000 $A "$(entry in_7:li_1:6 3000 6 0.3 10000)" >/dev/null
( psql_q -c "select affiliate_payout_claim('$M', 2000, true, now())" >/dev/null 2>&1 ) &
( psql_q -c "select affiliate_refund('ch_7', 3000)" >/dev/null 2>&1 ) &
wait
psql_q -c "select affiliate_payout_claim('$M', 2000, true, now())" >/dev/null
check "refund racing claim: payout amount = its rows" \
  "$(psql_q -c "select bool_and(p.amount_cents = (select sum(amount_cents) from affiliate_entries e where e.payout_id = p.id))::text from affiliate_payouts p where p.member_id='$M' and p.state in ('claimed','awaiting_approval')")" "true"

PAYC=$(psql_q -c "select id from affiliate_payouts where member_id='$M' and state='claimed'")
psql_q -c "insert into tenants values ('33333333-0000-0000-0000-000000000004')"
check "staff reject (first-payout path) forfeits" "$(psql_q -c "update affiliate_payouts set state='awaiting_approval' where id='$PAYC'; select affiliate_payout_move('$PAYC', 'awaiting_approval', 'rejected', null, 'fraud', null)->>'outcome'" | tail -1)" "moved"
check "  ...its rows stay with the rejected payout" "$(psql_q -c "select count(*) > 0 from affiliate_entries where payout_id='$PAYC'")" "t"
check "  ...and are never claimed again"    "$(psql_q -c "select affiliate_payout_claim('$M', 1, true, '2030-01-01T00:00:00Z')->>'outcome'")" "below_minimum"

FCH=$(psql_q -c "select charge_id from affiliate_entries where payout_id='$PAYC' and kind='commission' limit 1")
refund "$FCH" 100000
check "refund on a forfeited commission stays with the rejected payout" "$(psql_q -c "select count(*) from affiliate_entries where charge_id='$FCH' and kind='adjustment' and payout_id is null")" "0"
check "  ...so it creates no debt to reverse" "$(psql_q -c "select affiliate_reversal_claim('$M', true)->>'outcome'")" "no_debt"

psql_q -c "insert into affiliate_clicks (code, clicked_at) select 'abcdefgh', now() - interval '200 days' from generate_series(1, 25)"
check "click purge deletes in bounded batches" "$(psql_q -c "select affiliate_purge_clicks(now() - interval '120 days', 10)")" "10"

psql_q -c "update human_members set vetting_state='rejected' where id='$M'"
check "a rejected creator is not claimed"  "$(psql_q -c "select affiliate_payout_claim('$M', 1, true, '2030-01-01T00:00:00Z')->>'outcome'")" "not_eligible"
psql_q -c "update human_members set vetting_state='approved' where id='$M'"

check "member totals: paid net of the reversal, forfeits excluded" "$(psql_q -c "select (affiliate_member_totals('$M', true, now())->>'paid_cents')")" "1400"

accrue $T1 ch_w 2000 $A "$(entry in_w:li_1:8 600 8 0.3 2000)" >/dev/null
SENTP=$(psql_q -c "select id from affiliate_payouts where member_id='$M' and state='sent' order by created_at desc limit 1")
psql_q -c "update affiliate_entries set payout_id='$SENTP' where charge_id='ch_w' and kind='commission'"
dispute dp_w2 ch_w 2000 needs_response
dispute dp_w2 ch_w 2000 won
check "a refund undone before the reversal: nothing to reverse" "$(psql_q -c "select affiliate_reversal_claim('$M', true)->>'outcome'")" "no_debt"
check "  ...and its zero-net rows are filed with the paid payout" "$(psql_q -c "select count(*) from affiliate_entries where charge_id='ch_w' and kind='adjustment' and payout_id is null")" "0"

check "staff can record a dashboard reversal" "$(psql_q -c "select affiliate_reversal_external('$SENTP', 'trr_dash1', 300)->>'outcome'")" "recorded"
check "  ...only once"                        "$(psql_q -c "select affiliate_reversal_external('$SENTP', 'trr_dash1', 300)->>'outcome'")" "already_recorded"
psql_q -c "insert into affiliate_reversals (member_id, payout_id, livemode, amount_cents, state, attempted_at) values ('$M', '$SENTP', true, 100, 'reconcile', now())"
check "  ...refused while our own reversal is in flight" "$(psql_q -c "select affiliate_reversal_external('$SENTP', 'trr_dash2', 100)->>'outcome'")" "reversal_in_flight"
psql_q -c "update affiliate_reversals set state='failed' where payout_id='$SENTP' and stripe_reversal_id is null and state='reconcile'"

psql_q -c "insert into affiliate_referrals (tenant_id, member_id, code, clicked_at, door) values ('$T2', '$M', 'abcdefgh', now(), 'activate')"
accrue $T1 ch_8 2000 $A "$(entry in_8:li_1:7 600 7 0.3 2000)" "'fp_same'" >/dev/null
accrue $T2 ch_9 2000 $A "$(entry in_9:li_1:1 2000 1 1.0 2000)" "'fp_same'" >/dev/null
check "same card on another referral is flagged for staff" "$(psql_q -c "select signals->>'card_seen_on_other_referral' from affiliate_referrals where tenant_id='$T2'")" "true"

echo; if [ "$FAILED" = 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; exit 1; fi
