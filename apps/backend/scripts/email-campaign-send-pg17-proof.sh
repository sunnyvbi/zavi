#!/usr/bin/env bash
set -euo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
PORT="${PORT:-55437}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../../../supabase/migrations"
DIR="$(mktemp -d -t email-send-pg17)"

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
CL=c1a10000-0000-0000-0000-000000000001
CLASS=email_campaign.create_and_send

psql_q <<SQL
create role anon; create role authenticated; create role service_role;
create table public.tenants (id uuid primary key);
create table public.tenant_users (tenant_id uuid, user_id uuid, role text);
create table public.decision_classes (
  slug text primary key, description text, default_autonomy text, dispatch_handler text,
  never_auto boolean, click_allowlistable boolean, severity text);
create table public.channel_actions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, channel_slug text, run_id uuid,
  status text not null default 'pending', status_at timestamptz, note text,
  exec_class text, exec_payload jsonb, exec_status text, exec_result jsonb,
  exec_claim_id uuid, exec_claimed_at timestamptz, executed_at timestamptz,
  approved_by uuid, approved_by_source text);
create table public.channel_action_events (
  id bigint generated always as identity primary key, tenant_id uuid not null, action_id uuid not null,
  event text not null, actor_kind text not null, actor_user_id uuid, run_id uuid, note text,
  event_key text not null, at timestamptz not null default now(), unique (action_id, event_key));
create function public.enqueue_ops_alert(text, text, text, uuid, text) returns boolean language sql as \$\$ select true \$\$;
insert into public.tenants values ('$T'), ('$T2');
insert into public.tenant_users values ('$T', '$U', 'owner'), ('$T2', '$U', 'owner');
SQL
for m in 20261009100050_approve_channel_action_refuse_blocked \
         20261016170000_linkedin_ads_write_rail_NOTE_ONLY \
         20261016190000_meta_ad_readiness_exec_fixes \
         20261022090100_email_campaign_tool_send; do
  if [ "$m" = "20261016170000_linkedin_ads_write_rail_NOTE_ONLY" ]; then
    python3 - "$MIG/20261016170000_linkedin_ads_write_rail.sql" <<'PY' | psql_q >/dev/null
import sys
s = open(sys.argv[1]).read()
i = s.index("create or replace function exec_blocked_note(")
print(s[i : s.index("$$;", s.index("$$", i) + 2) + 3])
PY
    continue
  fi
  psql_q -f "$MIG/$m.sql" >/dev/null
done

FAILED=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1 ($2)"; else echo "FAIL  $1: expected [$3], got [$2]"; FAILED=1; fi; }
q() { psql_q -c "$1"; }
card() {
  q "insert into channel_actions (tenant_id, channel_slug, exec_class, exec_payload, exec_status)
     values ('$1', 'email_marketing', '$CLASS', jsonb_build_object('tool', '$2', 'audience_id', '$3'), $4) returning id"
}
progress() { q "select record_channel_action_exec_progress('$1', '$2', '$3', '$4'::jsonb)->>'code'"; }
progress_ok() { q "select record_channel_action_exec_progress('$1', '$2', '$3', '$4'::jsonb)->>'ok'"; }
cgo() {
  local code
  code=$(q "select approve_email_campaign_send_as_cgo('$1', '$2', 'cgo:$2', '$U')->>'code'")
  if [ -n "$code" ]; then echo "$code"; else q "select 'queued:' || exec_status || ':' || approved_by_source from channel_actions where id = '$2'"; fi
}
reconcile() { q "select coalesce(r->>'code', 'ok') from reconcile_channel_action_exec('$1', '$2', $3, '$4'::jsonb, '$5') r"; }

echo "== progress: only the claim that holds the row, and only forwards =="
A=$(card $T mailchimp L1 "'dispatching'")
q "update channel_actions set exec_claim_id = '$CL', exec_claimed_at = now() where id = '$A'"
check "another claim cannot write progress" "$(progress $T $A c1a10000-0000-0000-0000-00000000dead '{"campaign_id":"c1","stage":"created"}')" "not_owner"
check "another tenant's id reads as missing" "$(progress $T2 $A $CL '{"campaign_id":"c1","stage":"created"}')" "not_found"
check "an unknown stage is refused" "$(progress $T $A $CL '{"campaign_id":"c1","stage":"sent_twice"}')" "progress_invalid"
check "the holder records created" "$(progress_ok $T $A $CL '{"campaign_id":"c1","stage":"created"}')" "true"
check "before the send, the campaign may be replaced (the draft was deleted and remade)" "$(progress_ok $T $A $CL '{"campaign_id":"c2","stage":"created"}')" "true"
check "content_set on c2" "$(progress_ok $T $A $CL '{"campaign_id":"c2","stage":"content_set"}')" "true"
check "the draft was deleted before the send: a new campaign starts again at created" "$(progress_ok $T $A $CL '{"campaign_id":"c2b","stage":"created"}')" "true"
check "and the old one cannot come back behind it" "$(progress $T $A $CL '{"campaign_id":"c2b","stage":"created"}'):$(progress_ok $T $A $CL '{"campaign_id":"c2","stage":"content_set"}')" ":true"
check "content_set, then send_requested" "$(progress_ok $T $A $CL '{"campaign_id":"c2","stage":"content_set"}'):$(progress_ok $T $A $CL '{"campaign_id":"c2","stage":"send_requested"}')" "true:true"
check "a stage never goes backwards on the same campaign" "$(progress $T $A $CL '{"campaign_id":"c2","stage":"created"}')" "stage_backwards"
check "once the send was requested the row stays on that campaign" "$(progress $T $A $CL '{"campaign_id":"c3","stage":"sent"}')" "campaign_locked"
check "the stored progress" "$(q "select exec_progress->>'campaign_id' || ':' || (exec_progress->>'stage') from channel_actions where id = '$A'")" "c2:send_requested"
q "update channel_actions set exec_status = 'failed' where id = '$A'" >/dev/null
check "a settled row takes no more progress" "$(progress $T $A $CL '{"campaign_id":"c2","stage":"sent"}')" "not_owner"

echo "== reconcile: only an unknown outcome, only this class =="
check "a plain failure is not reconcilable" "$(reconcile $T $A true '{}' '')" "not_unknown"
q "update channel_actions set exec_result = '{\"code\":\"exec_outcome_unknown\",\"bucket\":\"partial_risk\"}' where id = '$A'" >/dev/null
check "Approve refuses an unknown outcome" "$(q "select approve_channel_action('$T', '$A', 'click-1', '$U')->>'code'")" "exec_partial_no_retry"
check "another tenant cannot reconcile it" "$(reconcile $T2 $A true '{}' '')" "not_found"
check "the reconcile settles it sent" "$(reconcile $T $A true '{"receipt":{"line":"Sent to 412 people via Mailchimp"}}' 'Sent to 412 people via Mailchimp.')" "ok"
check "the row is executed and done, with the receipt" "$(q "select exec_status || ':' || status || ':' || (exec_result->'receipt'->>'line') from channel_actions where id = '$A'")" "executed:acted:Sent to 412 people via Mailchimp"
check "one executed event, logged as the founder's (they tapped it)" "$(q "select count(*) || ':' || min(actor_kind) from channel_action_events where action_id = '$A' and event = 'executed'")" "1:founder"
check "a second pass writes nothing" "$(reconcile $T $A false '{}' 'x'):$(q "select exec_status from channel_actions where id = '$A'")" "not_unknown:executed"

B=$(card $T mailchimp L1 "'dispatching'")
q "update channel_actions set exec_claim_id = '$CL', exec_claimed_at = now(), exec_progress = '{\"campaign_id\":\"c9\",\"stage\":\"send_requested\"}' where id = '$B'" >/dev/null
check "a row a worker still holds is left alone" "$(reconcile $T $B true '{}' '')" "not_unknown"
q "update channel_actions set exec_claimed_at = now() - interval '11 minutes' where id = '$B'" >/dev/null
check "an abandoned row (lease expired) settles NOT sent, as partial" "$(reconcile $T $B false '{"error":"not sent","code":"exec_partial"}' 'This email was not sent.')" "ok"
check "stamped partial_risk, still open, and Approve refuses to run it again" "$(q "select exec_status || ':' || status || ':' || (exec_result->>'bucket') from channel_actions where id = '$B'"):$(q "select approve_channel_action('$T', '$B', 'click-2', '$U')->>'code'")" "failed:pending:partial_risk:exec_partial_no_retry"

C=$(card $T mailchimp L1 "'failed'")
q "update channel_actions set exec_result = '{\"code\":\"exec_outcome_unknown\"}' where id = '$C'" >/dev/null
check "no stored progress: nothing to read, so nothing to reconcile" "$(reconcile $T $C true '{}' '')" "no_progress"
D=$(q "insert into channel_actions (tenant_id, exec_class, exec_payload, exec_status, exec_result) values ('$T', 'meta_ads.create_ad', '{}', 'failed', '{\"code\":\"exec_outcome_unknown\"}') returning id")
q "update channel_actions set exec_progress = '{\"campaign_id\":\"x\",\"stage\":\"sent\"}' where id = '$D'" >/dev/null
check "an ad card is never reconciled through this door" "$(reconcile $T $D true '{}' '')" "class_not_reconcilable"
q "delete from channel_actions" >/dev/null

echo "== cgo approval: one Autopilot send per list per 7 days =="
A1=$(card $T mailchimp L1 null)
check "the first send to a list is queued as cgo's" "$(cgo $T $A1)" "queued:queued:cgo"
check "its approval event is the system's, not the founder's" "$(q "select actor_kind from channel_action_events where action_id = '$A1' and event = 'approved'")" "system"
A2=$(card $T mailchimp L1 null)
check "a second send to the same list while the first is queued is refused" "$(cgo $T $A2)" "cgo_email_sent_recently"
check "and stays unapproved for the founder" "$(q "select coalesce(exec_status, 'none') || ':' || status from channel_actions where id = '$A2'")" "none:pending"
check "the founder may still send it (their taps are not limited)" "$(q "select approve_channel_action('$T', '$A2', 'click-3', '$U')->>'ok'"):$(q "select coalesce(approved_by_source, 'founder') from channel_actions where id = '$A2'")" "true:founder"
A3=$(card $T mailchimp L2 null)
check "another list is free" "$(cgo $T $A3)" "queued:queued:cgo"
A4=$(card $T klaviyo L1 null)
check "the same list id in the other tool is a different list" "$(cgo $T $A4)" "queued:queued:cgo"
A5=$(card $T2 mailchimp L1 null)
check "another workspace's sends never count" "$(cgo $T2 $A5)" "queued:queued:cgo"
check "another workspace cannot approve this one's card" "$(q "select approve_email_campaign_send_as_cgo('$T2', '$A2', 'k', '$U')->>'code'")" "not_found"
AD=$(q "insert into channel_actions (tenant_id, exec_class, exec_payload) values ('$T', 'meta_ads.set_status', '{\"tool\":\"mailchimp\",\"audience_id\":\"L1\"}') returning id")
check "an ad card never passes this door" "$(q "select approve_email_campaign_send_as_cgo('$T', '$AD', 'k', '$U')->>'code'")" "not_email_send"

q "update channel_actions set exec_status = 'executed', executed_at = now() - interval '3 days' where id = '$A1'" >/dev/null
A6=$(card $T mailchimp L1 null)
check "a cgo send to the list 3 days ago holds the next one" "$(cgo $T $A6)" "cgo_email_sent_recently"
q "update channel_actions set executed_at = now() - interval '8 days' where id = '$A1'" >/dev/null
check "8 days ago does not" "$(cgo $T $A6)" "queued:queued:cgo"
q "update channel_actions set exec_status = 'failed', exec_claimed_at = now() - interval '1 day', exec_progress = '{\"campaign_id\":\"c\",\"stage\":\"content_set\"}' where id = '$A6'" >/dev/null
A7=$(card $T mailchimp L1 null)
check "a failed attempt that never requested the send does not count" "$(cgo $T $A7)" "queued:queued:cgo"
q "update channel_actions set exec_status = 'failed', exec_claimed_at = now() - interval '1 day', exec_progress = '{\"campaign_id\":\"c\",\"stage\":\"send_requested\"}' where id = '$A7'" >/dev/null
A8=$(card $T mailchimp L1 null)
check "a failed attempt whose send was requested does (it may have gone out)" "$(cgo $T $A8)" "cgo_email_sent_recently"

echo "== two cgo runs approving the same list at the same moment =="
q "delete from channel_actions" >/dev/null
R1=$(card $T mailchimp L9 null)
R2=$(card $T mailchimp L9 null)
( psql_q -c "begin; select approve_email_campaign_send_as_cgo('$T', '$R1', 'cgo:$R1', '$U'); select pg_sleep(2); commit;" >/dev/null ) &
sleep 0.6
START=$(date +%s)
SECOND=$(q "select coalesce(approve_email_campaign_send_as_cgo('$T', '$R2', 'cgo:$R2', '$U')->>'code', 'queued')")
WAITED=$(( $(date +%s) - START ))
wait
check "the second run waited for the first and was then refused" "$SECOND" "cgo_email_sent_recently"
check "it really waited on the lock (at least a second)" "$([ "$WAITED" -ge 1 ] && echo yes || echo "no:$WAITED")" "yes"
check "exactly one of the two is queued" "$(q "select count(*) from channel_actions where exec_status = 'queued'")" "1"

echo "== the classifier, the note and the chat class =="
check "not connected: the founder reconnects" "$(q "select classify_exec_failure('{\"code\":\"email_tool_not_connected\"}')::text")" '{"fix": "reconnect", "bucket": "needs_founder", "platform_code": null}'
check "list gone: stays open, try again" "$(q "select classify_exec_failure('{\"code\":\"email_audience_missing\"}')->>'bucket'")" "temporary"
check "the tool said no: stays open, try again" "$(q "select classify_exec_failure('{\"code\":\"email_tool_refused\"}')->>'bucket'")" "temporary"
check "an older code is unchanged" "$(q "select classify_exec_failure('{\"code\":\"meta_ads_no_page\"}')->>'fix'")" "page"
check "the blocked note names the tools" "$(q "select exec_blocked_note('$CLASS')")" "Mailchimp or Klaviyo refused this change, so Zavi closed the card. We've been alerted; nothing for you to do."
check "the chat class is approval-only and never auto" "$(q "select default_autonomy || ':' || never_auto || ':' || dispatch_handler from decision_classes where slug = '$CLASS'")" "approval:true:$CLASS"
check "service role only" "$(q "select has_function_privilege('authenticated', 'approve_email_campaign_send_as_cgo(uuid,uuid,text,uuid)', 'execute') || ':' || has_function_privilege('service_role', 'approve_email_campaign_send_as_cgo(uuid,uuid,text,uuid)', 'execute') || ':' || has_function_privilege('anon', 'reconcile_channel_action_exec(uuid,uuid,boolean,jsonb,text)', 'execute') || ':' || has_function_privilege('authenticated', 'record_channel_action_exec_progress(uuid,uuid,uuid,jsonb)', 'execute')")" "false:true:false:false"

if [ "$FAILED" = 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; exit 1; fi
