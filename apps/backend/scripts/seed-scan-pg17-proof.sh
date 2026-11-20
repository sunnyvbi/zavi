#!/usr/bin/env bash
set -euo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
PORT="${PORT:-55437}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../../../supabase/migrations"
DIR="$(mktemp -d -t seed-scan-pg17)"

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
create table public.agent_runs (id uuid primary key, tenant_id uuid, status text, stop_requested boolean);
SQL
for m in 20260928100000_start_cards 20260928110000_start_card_reports \
         20261007120000_site_check_tool_funding 20261101170000_start_card_seed_scan \
         20261101185000_seed_notice_followups; do
  psql_q -f "$MIG/$m.sql" >/dev/null
done

FAILED=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1 ($2)"; else echo "FAIL  $1: expected [$3], got [$2]"; FAILED=1; fi; }
fails() { if psql_q -c "$2" >/dev/null 2>&1; then echo "FAIL  $1: statement succeeded"; FAILED=1; else echo "PASS  $1 (refused)"; fi; }

RUN=aaaaaaaa-0000-0000-0000-000000000001
psql_q -c "insert into seed_runs (id, manifest_hash, pipeline_version, privacy_version, spend_cap_usd)
           values ('$RUN', repeat('a',64), 'local-1', '2026-10-12', 200)"

reserve() { psql_q -c "insert into seed_run_items (run_id, domain, source) values ('$1', '$2', 'yc') on conflict do nothing" >/dev/null; psql_q -c "select seed_run_reserve('$1', '$2', 0.50)->>'outcome'"; }
claim() { reserve "$RUN" "$(echo "$1" | tr 'A-Z' 'a-z' | sed 's/^www\.//')" >/dev/null; psql_q -c "select start_card_seed_claim('$RUN', '$1', '$2', '{}'::jsonb)->>'$3'"; }

check "seed claim creates a card"            "$(claim Example.COM abcdefghijklmnop1 outcome)" "created"
check "domain stored lower-case"             "$(psql_q -c "select domain from start_cards where public_id='abcdefghijklmnop1'")" "example.com"
check "seed card has no budget day"          "$(psql_q -c "select coalesce(budget_day::text,'null') from start_cards where public_id='abcdefghijklmnop1'")" "null"
check "seed card reserves nothing"           "$(psql_q -c "select reserved_usd from start_cards where public_id='abcdefghijklmnop1'")" "0.0000"
check "seed card is kind seed"               "$(psql_q -c "select funding_kind from start_cards where public_id='abcdefghijklmnop1'")" "seed"
check "same run, same domain = resume"       "$(claim example.com abcdefghijklmnop2 outcome)" "same_run"
check "resume returns the first card"        "$(claim example.com abcdefghijklmnop3 public_id)" "abcdefghijklmnop1"

fails "seed row with a budget day refused"   "update start_cards set budget_day = current_date where public_id='abcdefghijklmnop1'"
fails "seed row with a reservation refused"  "update start_cards set reserved_usd = 1 where public_id='abcdefghijklmnop1'"
fails "seed row with a tenant refused"       "update start_cards set funding_tenant_id = gen_random_uuid() where public_id='abcdefghijklmnop1'"
fails "visitor row with a seed run refused"  "insert into start_cards (public_id, domain, funding_kind, seed_run_id) values ('abcdefghijklmnopq', 'x.com', 'public_budget', '$RUN')"

check "visitor gets a NEW card, not the seed one" \
  "$(psql_q -c "select start_card_claim('example.com', now() - interval '24 hours', 'visitorvisitor001', '{}'::jsonb, null, null, current_date, 1, 'public_budget', null, null, null, null, null)->>'outcome'")" "created"
check "visitor card is public_budget" \
  "$(psql_q -c "select funding_kind from start_cards where public_id='visitorvisitor001'")" "public_budget"
check "a second visitor reuses the visitor card" \
  "$(psql_q -c "select start_card_claim('example.com', now() - interval '24 hours', 'visitorvisitor002', '{}'::jsonb, null, null, current_date, 1, 'public_budget', null, null, null, null, null)->>'public_id'")" "visitorvisitor001"
fails "visitor claim cannot ask for kind seed" \
  "select start_card_claim('y.com', now(), 'visitorvisitor003', '{}'::jsonb, null, null, current_date, 1, 'seed', null, null, null, null, null)"

psql_q -c "insert into seed_notices (domain, card_id, email, idempotency_key)
           select 'example.com', id, 'hello@example.com', 'seed-notice-example-com-0001' from start_cards where public_id='abcdefghijklmnop1'"
psql_q -c "update start_cards set revoked_at = now() where public_id='visitorvisitor001'"
check "removal suppresses the domain"         "$(psql_q -c "select reason from seed_suppressions where domain='example.com'")" "owner_removed"
check "removal cancels the pending notice"    "$(psql_q -c "select state from seed_notices where domain='example.com'")" "cancelled"
check "a suppressed domain is never claimed"  "$(claim example.com abcdefghijklmnop4 outcome)" "suppressed"
check "manual suppression also blocks"        "$(psql_q -c "insert into seed_suppressions values ('blocked.io','manual') returning domain")" "blocked.io"
check "  ...claim refused"                    "$(claim blocked.io abcdefghijklmnop5 outcome)" "suppressed"

fails "a second notice for the same domain refused" \
  "insert into seed_notices (domain, card_id, email, idempotency_key) select 'example.com', id, 'x@example.com', 'seed-notice-example-com-0002' from start_cards where public_id='abcdefghijklmnop1'"

psql_q -c "update seed_runs set status='closed' where id='$RUN'"
check "closed run refuses new claims"         "$(claim other.org abcdefghijklmnop6 outcome)" "run_closed"

check "anon cannot execute the seed claim" \
  "$(psql_q -c "select has_function_privilege('anon', 'start_card_seed_claim(uuid,text,text,jsonb)', 'execute')")" "f"
check "authenticated cannot read seed_notices" \
  "$(psql_q -c "select has_table_privilege('authenticated', 'seed_notices', 'select')")" "f"

psql_q -c "update seed_runs set status='open' where id='$RUN'"
claim unsent.dev abcdefghijklmnop7 outcome >/dev/null
claim noticed.dev abcdefghijklmnop8 outcome >/dev/null
psql_q -c "update start_cards set status='done' where public_id='abcdefghijklmnop8'"
psql_q -c "insert into seed_notices (domain, card_id, email, idempotency_key) select 'noticed.dev', id, 'hi@noticed.dev', 'seed-notice-noticed-dev-0001' from start_cards where public_id='abcdefghijklmnop8'"
check "notice claim hands out the address"    "$(psql_q -c "select seed_notice_claim('noticed.dev')->>'outcome'")" "claimed"
check "provider accepted lists the card"      "$(psql_q -c "select seed_notice_accepted('noticed.dev','msg-1')->>'outcome'")" "accepted"
check "listing filter: unsent seed hidden, noticed seed + visitor shown" \
  "$(psql_q -c "select string_agg(public_id, ',' order by public_id) from start_cards where public_id in ('abcdefghijklmnop7','abcdefghijklmnop8','visitorvisitor001') and (funding_kind <> 'seed' or notice_sent_at is not null)")" \
  "abcdefghijklmnop8,visitorvisitor001"

fails "notice_sent_at cannot be set without an accepted notice" \
  "update start_cards set notice_sent_at = now() where public_id='abcdefghijklmnop7'"
check "www. is stripped: www.acme.io claims acme.io" "$(claim www.ACME.io abcdefghijklmnop9 outcome)" "created"
check "  ...stored as acme.io"                 "$(psql_q -c "select domain from start_cards where public_id='abcdefghijklmnop9'")" "acme.io"
fails "suppression key must be canonical (capitals)" "insert into seed_suppressions values ('Mixed.com','manual')"
fails "suppression key must be canonical (www.)"     "insert into seed_suppressions values ('www.mixed.com','manual')"
fails "a freemail contact is refused"          "insert into seed_notices (domain, card_id, email, idempotency_key) select 'acme.io', id, 'founder@gmail.com', 'seed-notice-acme-io-0001' from start_cards where public_id='abcdefghijklmnop9'"
check "a same-domain contact is accepted"      "$(psql_q -c "insert into seed_notices (domain, card_id, email, idempotency_key) select 'acme.io', id, 'team@mail.acme.io', 'seed-notice-acme-io-0002' from start_cards where public_id='abcdefghijklmnop9' returning state")" "pending"
psql_q -c "update start_cards set status='done' where public_id='abcdefghijklmnop9'"
check "claimed notice before removal"          "$(psql_q -c "select seed_notice_claim('acme.io')->>'outcome'")" "claimed"
psql_q -c "select start_card_claim('acme.io', now() - interval '24 hours', 'visitorvisitor009', '{}'::jsonb, null, null, current_date, 1, 'public_budget', null, null, null, null, null)" >/dev/null
psql_q -c "update start_cards set revoked_at = now() where public_id='visitorvisitor009'"
check "removal cancels a CLAIMED notice too"   "$(psql_q -c "select state from seed_notices where domain='acme.io'")" "cancelled"
check "accepting a cancelled notice lists nothing" "$(psql_q -c "select seed_notice_accepted('acme.io','msg-2')->>'outcome'")" "not_claimed"
psql_q -c "delete from start_cards where public_id='abcdefghijklmnop8'"
check "deleting a card keeps its notice (domain stays used)" "$(psql_q -c "select state || ':' || coalesce(card_id::text,'null') from seed_notices where domain='noticed.dev'")" "accepted:null"
RUN2=aaaaaaaa-0000-0000-0000-000000000002
psql_q -c "insert into seed_runs (id, manifest_hash, pipeline_version, privacy_version, spend_cap_usd) values ('$RUN2', repeat('b',64), 'local-1', '2026-10-12', 1.00)"
psql_q -c "insert into seed_run_items (run_id, domain, source) values ('$RUN2','one.dev','yc'), ('$RUN2','two.dev','yc'), ('$RUN2','three.dev','yc')"
check "no claim without a reservation"         "$(psql_q -c "select start_card_seed_claim('$RUN2', 'one.dev', 'resresresresres01', '{}'::jsonb)->>'outcome'")" "not_reserved"
check "reserve within the cap"                 "$(psql_q -c "select seed_run_reserve('$RUN2', 'one.dev', 0.60)->>'outcome'")" "reserved"
check "a replayed reserve holds nothing more"  "$(psql_q -c "select seed_run_reserve('$RUN2', 'one.dev', 0.60)->>'outcome'")" "already_reserved"
check "reserve past the cap is refused"        "$(psql_q -c "select seed_run_reserve('$RUN2', 'two.dev', 0.60)->>'outcome'")" "cap_reached"
check "claim works once reserved"              "$(psql_q -c "select start_card_seed_claim('$RUN2', 'one.dev', 'resresresresres02', '{}'::jsonb)->>'outcome'")" "created"
check "settle replaces the reservation"        "$(psql_q -c "select seed_run_settle('$RUN2', 'one.dev', 0.25)->>'outcome'")" "settled"
check "  ...run spend is the actual cost"      "$(psql_q -c "select spent_usd from seed_runs where id='$RUN2'")" "0.2500"
check "a replayed settle changes nothing"      "$(psql_q -c "select seed_run_settle('$RUN2', 'one.dev', 9.00)->>'outcome'")" "already_settled"
check "  ...spend unchanged"                   "$(psql_q -c "select spent_usd from seed_runs where id='$RUN2'")" "0.2500"
check "a settled item cannot be re-reserved"   "$(psql_q -c "select seed_run_reserve('$RUN2', 'one.dev', 0.10)->>'outcome'")" "settled"
check "now two.dev fits"                       "$(psql_q -c "select seed_run_reserve('$RUN2', 'two.dev', 0.60)->>'outcome'")" "reserved"
check "an overrun is recorded as spent"        "$(psql_q -c "select seed_run_settle('$RUN2', 'two.dev', 0.90)->>'outcome'")" "settled"
check "  ...and blocks further reservations"   "$(psql_q -c "select seed_run_reserve('$RUN2', 'three.dev', 0.10)->>'outcome'")" "cap_reached"

fails "a notice for another domain's card refused" \
  "insert into seed_notices (domain, card_id, email, idempotency_key) select 'other.dev', id, 'a@other.dev', 'seed-notice-other-dev-00001' from start_cards where public_id='resresresresres02'"
fails "a notice pointing at a visitor card refused" \
  "insert into seed_notices (domain, card_id, email, idempotency_key) select 'example.com', id, 'a@example.com', 'seed-notice-example-com-0009' from start_cards where public_id='visitorvisitor001'"
psql_q -c "update start_cards set status='done' where public_id='resresresresres02'"
psql_q -c "insert into seed_notices (domain, card_id, email, idempotency_key) select 'one.dev', id, 'hi@one.dev', 'seed-notice-one-dev-000001' from start_cards where public_id='resresresresres02'"
check "notice claimed"                         "$(psql_q -c "select seed_notice_claim('one.dev')->>'outcome'")" "claimed"
fails "accept without a provider message id refused" "select seed_notice_accepted('one.dev', null)"
psql_q -c "insert into seed_suppressions values ('one.dev','manual')"
check "manual suppression cancels a claimed notice" "$(psql_q -c "select state from seed_notices where domain='one.dev'")" "cancelled"
check "  ...and the card is never listed"      "$(psql_q -c "select seed_notice_accepted('one.dev','msg-9')->>'outcome'")" "not_claimed"
fails "a card cannot be inserted already noticed" \
  "insert into start_cards (public_id, domain, funding_kind, seed_run_id, notice_sent_at) values ('insinsinsinsins01', 'z.dev', 'seed', '$RUN2', now())"
check "anon cannot run the notice or spend functions" \
  "$(psql_q -c "select has_function_privilege('anon','seed_notice_claim(text)','execute') or has_function_privilege('anon','seed_run_reserve(uuid,text,numeric)','execute')")" "f"

RUN3=aaaaaaaa-0000-0000-0000-000000000003
psql_q -c "insert into seed_runs (id, manifest_hash, pipeline_version, privacy_version, spend_cap_usd) values ('$RUN3', repeat('c',64), 'local-1', '2026-10-12', 10)"
reserve "$RUN3" race.dev >/dev/null
psql_q -c "select start_card_seed_claim('$RUN3', 'race.dev', 'raceraceraceracer', '{}'::jsonb)" >/dev/null
psql_q -c "update start_cards set status='done' where public_id='raceraceraceracer'"
psql_q -c "insert into seed_notices (domain, card_id, email, idempotency_key) select 'race.dev', id, 'hi@race.dev', 'seed-notice-race-dev-000001' from start_cards where public_id='raceraceraceracer'"
psql_q -c "select seed_notice_claim('race.dev')" >/dev/null
( psql_q -c "begin; update start_cards set revoked_at = now() where public_id='raceraceraceracer'; select pg_sleep(2); commit;" >/dev/null 2>"$DIR/a.err" ) &
APID=$!
sleep 0.5
B_OUT="$(psql_q -c "select seed_notice_accepted('race.dev','msg-race')->>'outcome'" 2>"$DIR/b.err" || true)"
wait $APID
check "accept racing a removal waits, then lists nothing" "$B_OUT" "not_claimed"
check "  ...no deadlock in either session" "$(cat "$DIR/a.err" "$DIR/b.err" | grep -c deadlock || true)" "0"
check "  ...the card was never listed" "$(psql_q -c "select coalesce(notice_sent_at::text,'null') from start_cards where public_id='raceraceraceracer'")" "null"

reserve "$RUN3" race2.dev >/dev/null
psql_q -c "select start_card_seed_claim('$RUN3', 'race2.dev', 'race2race2race2ra', '{}'::jsonb)" >/dev/null
( psql_q -c "begin; update start_cards set revoked_at = now() where public_id='race2race2race2ra'; select pg_sleep(2); commit;" >/dev/null 2>"$DIR/c.err" ) &
CPID=$!
sleep 0.5
psql_q -c "insert into seed_suppressions values ('race2.dev','manual') on conflict (domain) do nothing" >/dev/null 2>"$DIR/d.err" || true
wait $CPID
check "manual suppression racing a removal: no deadlock" "$(cat "$DIR/c.err" "$DIR/d.err" | grep -c deadlock || true)" "0"
check "  ...domain suppressed once"                     "$(psql_q -c "select count(*) from seed_suppressions where domain='race2.dev'")" "1"

fails "a notice with no card is refused" "insert into seed_notices (domain, card_id, email, idempotency_key) values ('nocard.dev', null, 'a@nocard.dev', 'seed-notice-nocard-dev-00001')"
reserve "$RUN3" gone.dev >/dev/null
psql_q -c "select start_card_seed_claim('$RUN3', 'gone.dev', 'gonegonegonegoneg', '{}'::jsonb)" >/dev/null
psql_q -c "update start_cards set status='done' where public_id='gonegonegonegoneg'"
psql_q -c "insert into seed_notices (domain, card_id, email, idempotency_key) select 'gone.dev', id, 'hi@gone.dev', 'seed-notice-gone-dev-000001' from start_cards where public_id='gonegonegonegoneg'"
psql_q -c "select seed_notice_claim('gone.dev')" >/dev/null
psql_q -c "delete from start_cards where public_id='gonegonegonegoneg'"
check "card deleted after the claim: the send is still recorded" "$(psql_q -c "select seed_notice_accepted('gone.dev','msg-gone')->>'outcome'")" "accepted_no_card"
check "  ...notice accepted, domain stays used"          "$(psql_q -c "select state from seed_notices where domain='gone.dev'")" "accepted"

reserve "$RUN3" gone2.dev >/dev/null
psql_q -c "select start_card_seed_claim('$RUN3', 'gone2.dev', 'gone2gone2gone2go', '{}'::jsonb)" >/dev/null
psql_q -c "update start_cards set status='done' where public_id='gone2gone2gone2go'"
psql_q -c "insert into seed_notices (domain, card_id, email, idempotency_key) select 'gone2.dev', id, 'hi@gone2.dev', 'seed-notice-gone2-dev-00001' from start_cards where public_id='gone2gone2gone2go'"
psql_q -c "select seed_notice_claim('gone2.dev')" >/dev/null
( psql_q -c "begin; delete from start_cards where public_id='gone2gone2gone2go'; select pg_sleep(2); commit;" >/dev/null 2>"$DIR/e.err" ) &
EPID=$!
sleep 0.5
F_OUT="$(psql_q -c "select seed_notice_accepted('gone2.dev','msg-gone2')->>'outcome'" 2>"$DIR/f.err" || true)"
wait $EPID
check "delete racing accept: the send is still recorded" "$F_OUT" "accepted_no_card"
check "  ...with its provider id"                         "$(psql_q -c "select state || ':' || provider_message_id from seed_notices where domain='gone2.dev'")" "accepted:msg-gone2"

RUN4=aaaaaaaa-0000-0000-0000-000000000004
psql_q -c "insert into seed_runs (id, manifest_hash, pipeline_version, privacy_version, spend_cap_usd) values ('$RUN4', repeat('d',64), 'local-1', '2026-10-12', 200)"
mk_notice() { # domain public_id
  reserve "$RUN4" "$1" >/dev/null
  psql_q -c "select start_card_seed_claim('$RUN4', '$1', '$2', '{}'::jsonb)" >/dev/null
  psql_q -c "update start_cards set status='done' where public_id='$2'"
  psql_q -c "insert into seed_notices (domain, card_id, email, idempotency_key) select '$1', id, 'hello@$1', 'seed-notice-' || md5('$1') from start_cards where public_id='$2'"
}
mk_notice cap1.dev capcapcapcapcap01
mk_notice cap2.dev capcapcapcapcap02
mk_notice cap3.dev capcapcapcapcap03
BEFORE="$(psql_q -c "select count(*) from seed_notices where claimed_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'")"
CAP=$((BEFORE + 1))
check "capped claim under the cap claims"   "$(psql_q -c "select seed_notice_claim_capped('cap1.dev', $CAP)->>'outcome'")" "claimed"
check "capped claim at the cap is refused"  "$(psql_q -c "select seed_notice_claim_capped('cap2.dev', $CAP)->>'outcome'")" "day_cap"
check "  ...and the notice stays pending"   "$(psql_q -c "select state from seed_notices where domain='cap2.dev'")" "pending"
CAP2=$((CAP + 1))
( psql_q -c "select seed_notice_claim_capped('cap2.dev', $CAP2)->>'outcome'" >"$DIR/g.out" 2>&1 ) &
( psql_q -c "select seed_notice_claim_capped('cap3.dev', $CAP2)->>'outcome'" >"$DIR/h.out" 2>&1 ) &
wait
check "two senders, one slot: one claimed"  "$(cat "$DIR/g.out" "$DIR/h.out" | grep -c '^claimed$')" "1"
check "  ...the other hit the cap"          "$(cat "$DIR/g.out" "$DIR/h.out" | grep -c '^day_cap$')" "1"

mk_notice unsub.dev unsubunsubunsub01
KEY="seed-notice-$(printf %s unsub.dev | md5)"
check "unsubscribe with an unknown key does nothing" "$(psql_q -c "select seed_notice_unsubscribe('seed-notice-nope')->>'outcome'")" "unknown"
check "unsubscribe removes the site"                 "$(psql_q -c "select seed_notice_unsubscribe('$KEY')->>'outcome'")" "removed"
check "  ...card revoked"                            "$(psql_q -c "select (revoked_at is not null)::text from start_cards where public_id='unsubunsubunsub01'")" "true"
check "  ...domain suppressed"                       "$(psql_q -c "select count(*) from seed_suppressions where domain='unsub.dev'")" "1"
check "  ...pending notice cancelled"                "$(psql_q -c "select state from seed_notices where domain='unsub.dev'")" "cancelled"
check "unsubscribe twice is harmless"                "$(psql_q -c "select seed_notice_unsubscribe('$KEY')->>'outcome'")" "removed"

echo; if [ "$FAILED" = 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; exit 1; fi
