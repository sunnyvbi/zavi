#!/usr/bin/env bash
set -uo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
PORT="${PORT:-55443}"
HERE="$(cd "$(dirname "$0")" && pwd)"
AUTH="$HERE/.."
MIG="${SHARD_MIGRATIONS_DIR:-$HERE/../../migrations}"
DIR="$(mktemp -d -t site-auth-pg17)"

cleanup() {
  if [ -n "${KEEP:-}" ]; then echo "KEEP: cluster left at $DIR (port $PORT)"; return; fi
  "$PGBIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT

[ -f "$MIG/0001_core.sql" ] || { echo "slice 1 migrations not found at $MIG (set SHARD_MIGRATIONS_DIR)"; exit 2; }

"$PGBIN/initdb" -D "$DIR/data" -U postgres -A trust >/dev/null
"$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=''" -l "$DIR/log" -w start >/dev/null

PSQL=("$PGBIN/psql" -h "$DIR" -p "$PORT" -d postgres -X -v ON_ERROR_STOP=1 -qAt)
su_q() { PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -U postgres "$@"; }
as_role() {
  local out rc
  out=$(PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -U postgres 2>&1 <<SQL
\set VERBOSITY terse
set role $1;
$2;
SQL
  ); rc=$?
  if [ $rc -ne 0 ]; then echo "ERR: $(echo "$out" | grep -m1 -E 'ERROR' | sed -E 's/^.*ERROR: +//')"; else echo "$out"; fi
}
sq() { as_role postgres "$1"; }
bq() { as_role zsite_broker "$1"; }
req() {
  local out rc
  out=$(PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -U postgres 2>&1 <<SQL
\set VERBOSITY terse
begin;
select set_config('request.jwt.claims', '$2', true) is not null as _;
set local role $1;
$3;
commit;
SQL
  ); rc=$?
  if [ $rc -ne 0 ]; then echo "ERR: $(echo "$out" | grep -m1 -E 'ERROR' | sed -E 's/^.*ERROR: +//')"; else echo "$out" | grep -v '^$' | tail -1; fi
}

PASSN=0; FAILN=0
check() { if [ "$2" = "$3" ]; then PASSN=$((PASSN+1)); echo "PASS  $1  [$2]";
          else FAILN=$((FAILN+1)); echo "FAIL  $1: expected [$3], got [$2]"; fi; }
check_err() { if [[ "$2" == ERR:* && "$2" == *"$3"* ]]; then PASSN=$((PASSN+1)); echo "PASS  $1  [denied: ${2#ERR: }]";
              else FAILN=$((FAILN+1)); echo "FAIL  $1: expected error containing [$3], got [$2]"; fi; }

su_q <<'SQL'
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
create role supabase_auth_admin nologin noinherit;
grant anon, authenticated, service_role to authenticator;

create schema auth;
create table auth.users (
  id uuid primary key, email text unique, email_confirmed_at timestamptz, is_anonymous boolean default false);
create table auth.sessions (id uuid primary key, user_id uuid, created_at timestamptz not null default now());
grant usage on schema auth to supabase_auth_admin;
grant all on auth.users, auth.sessions to supabase_auth_admin;

create schema storage;
create table storage.buckets (
  id text primary key, name text not null, public boolean not null default false,
  file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null, owner uuid, owner_id text, metadata jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  unique (bucket_id, name));
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
SQL

apply() { su_q -f "$1" >"$DIR/mig.log" 2>&1 || { echo "apply $(basename "$1") failed"; cat "$DIR/mig.log"; exit 1; }; }
for pass in 1 2; do for m in 0001_core 0002_api 0003_storage; do apply "$MIG/$m.sql"; done; done
for f in "$MIG"/0*.sql; do
  case "$(basename "$f")" in 0001_*|0002_*|0003_*) continue;; esac
  apply "$f"; apply "$f"
done
for pass in 1 2; do for f in "$AUTH"/1*.sql; do apply "$f"; done; done
echo "applied $(ls "$MIG"/0*.sql | xargs -n1 basename | tr '\n' ' ')+ $(ls "$AUTH"/1*.sql | xargs -n1 basename | tr '\n' ' ')(twice)"

su_q -c "do \$\$ begin
  if to_regclass('zsite.site_contracts') is null then
    create table zsite.site_contracts (site_id uuid primary key, schema_version int not null default 2, roles jsonb not null default '[]');
  end if;
end \$\$" >/dev/null
set_roles() { # set_roles <site> <json array>
  su_q -c "do \$\$ declare t text; begin
    select data_type into t from information_schema.columns where table_schema='zsite' and table_name='site_contracts' and column_name='roles';
    delete from zsite.site_contracts where site_id = '$1';
    if t = 'ARRAY' then
      execute format('insert into zsite.site_contracts (site_id, schema_version, roles) values (%L, 2, %L::text[])', '$1',
        (select coalesce('{' || string_agg(x, ',') || '}', '{}') from jsonb_array_elements_text('$2'::jsonb) x));
    else
      execute format('insert into zsite.site_contracts (site_id, schema_version, roles) values (%L, 2, %L::jsonb)', '$1', '$2');
    end if; end \$\$" >/dev/null
}

A=aaaaaaaa-0000-4000-8000-00000000000a
B=bbbbbbbb-0000-4000-8000-00000000000b
S=eeeeeeee-0000-4000-8000-00000000000e     # suspended
UA=a0000000-0000-4000-8000-000000000001    # alice on A
UB=b0000000-0000-4000-8000-000000000001    # alice (same real email) on B: a different account
UBOB=a0000000-0000-4000-8000-000000000003  # bob on A
UX=c0000000-0000-4000-8000-000000000009    # an auth user with NO identity row

su_q <<SQL
insert into zsite.sites (site_id) values ('$A'), ('$B'), ('$S');
update zsite.sites set status = 'suspended' where site_id = '$S';
insert into zsite.collections (site_id, name, rules, schema) values
 ('$A', 'notes', '{"list":["owner"],"get":["owner"],"create":["signed_in"],"update":["owner"],"delete":["owner"]}',
  '{"type":"object","properties":{"t":{"type":"string","maxLength":50}}}'),
 ('$B', 'notes', '{"list":["owner"],"get":["owner"],"create":["signed_in"],"update":["owner"],"delete":["owner"]}',
  '{"type":"object","properties":{"t":{"type":"string","maxLength":50}}}');
SQL

sha() { printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; }
cid() { printf 'c%07d-0000-4000-8000-000000000000' "$1"; }
signup_req() { bq "select zsite_auth.signup_request('$1','$2','$3','$4','$(cid "$5")','$(sha "tok-$5")', ${7:-3600}, ${6:-0}, 3)"; }
begin_c() { bq "select outcome || ':' || coalesce(auth_user_id::text,'') from zsite_auth.signup_confirm_begin('$1','$(sha "tok-$2")', 30)"; }
finish_c() { bq "select zsite_auth.signup_confirm_finish('$1','$(sha "tok-$2")')"; }
nchal() { sq "select count(*) from zsite_auth.signup_challenges where site_id='$1' and email_norm='$2'"; }
new_session() { sq "insert into auth.sessions (id, user_id, created_at) values (gen_random_uuid(), '$1', ${2:-clock_timestamp()}) returning id"; }

check "signup: new address on A returns nothing"  "$(signup_req $A alice@x.com ua@u.test $UA 1)" ""
check "signup row pending, preallocated id"       "$(sq "select state||'|'||auth_user_id from zsite_auth.signups where site_id='$A' and email_norm='alice@x.com'")" "pending|$UA"
check "no identity, no auth user before confirm"  "$(sq "select count(*) from zsite.identities where email_norm='alice@x.com'")/$(sq "select count(*) from auth.users")" "0/0"
check "one verify mail in the outbox (challenge id only)" "$(sq "select kind||'|'||challenge_id from zsite_auth.mail_outbox where to_email='alice@x.com' and site_id='$A'")" "verify_signup|$(cid 1)"
check "same email on B is a separate signup"      "$(signup_req $B alice@x.com ub@u.test $UB 50)$(sq "select auth_user_id from zsite_auth.signups where site_id='$B'")" "$UB"
signup_req $A alice@x.com ua@u.test c0000000-0000-4000-8000-0000000000ff 2 3600 >/dev/null
check "repeat within cooldown adds no challenge"  "$(nchal $A alice@x.com)" "1"
check "repeat never replaces the row's id"        "$(sq "select auth_user_id from zsite_auth.signups where site_id='$A' and email_norm='alice@x.com'")" "$UA"
signup_req $A alice@x.com ua@u.test c0000000-0000-4000-8000-0000000000ff 3 0 >/dev/null
signup_req $A alice@x.com ua@u.test c0000000-0000-4000-8000-0000000000ff 4 0 >/dev/null
signup_req $A alice@x.com ua@u.test c0000000-0000-4000-8000-0000000000ff 5 0 >/dev/null
check "at most 3 live challenges"                 "$(nchal $A alice@x.com)" "3"
check "still the original id"                     "$(sq "select auth_user_id from zsite_auth.signups where site_id='$A' and email_norm='alice@x.com'")" "$UA"
check "suspended site: nothing recorded"          "$(signup_req $S s@x.com s@u.test c0000000-0000-4000-8000-000000000011 6)$(sq "select count(*) from zsite_auth.signups where site_id='$S'")" "0"
check_err "email must be normalized"              "$(signup_req $A Alice@X.com x@u.test c0000000-0000-4000-8000-000000000012 7)" "email_not_normalized"

check "challenge of A used on B -> invalid"       "$(begin_c $B 1)" "invalid:"
check "guessed token -> invalid"                  "$(bq "select outcome from zsite_auth.signup_confirm_begin('$A', '$(sha guess)', 30)")" "invalid"
check "begin with challenge 3 -> ok + lease"      "$(begin_c $A 3)" "ok:$UA"
check "another challenge of the same signup waits" "$(begin_c $A 4)" "busy:"
check "same link again resumes the lease"         "$(begin_c $A 3)" "ok:$UA"
check "release (auth user confirmed absent) -> pending" "$(bq "select zsite_auth.signup_confirm_release('$A','$(sha tok-3)')")/$(sq "select state from zsite_auth.signups where auth_user_id='$UA'")" "t/pending"
check "begin again with challenge 1"              "$(begin_c $A 1)" "ok:$UA"
check "nothing is used before activation (all 3 challenges live)" "$(nchal $A alice@x.com)" "3"
check "finish by a non-holder -> invalid"         "$(finish_c $A 4)" "invalid"
check "finish -> ok"                              "$(finish_c $A 1)" "ok"
check "identity active + member user"             "$(sq "select i.state||'|'||m.role||'|'||m.status||'|'||i.alias from zsite.identities i join zsite.members m on m.user_id=i.auth_user_id where i.auth_user_id='$UA'")" "active|user|active|ua@u.test"
check "first confirmation kills every challenge"  "$(nchal $A alice@x.com)/$(sq "select count(*) from zsite_auth.signups where site_id='$A' and email_norm='alice@x.com'")" "0/0"
check "an older link afterwards -> invalid"       "$(begin_c $A 4)" "invalid:"
check "the confirming link again -> done (receipt replay)" "$(begin_c $A 1)" "done:$UA"
check "finish again -> done (receipt: no second session)" "$(finish_c $A 1)" "done"
su_q -c "update zsite_auth.signup_receipts set expires_at = now() - interval '1 s'" >/dev/null
check "after the receipt window -> invalid"       "$(begin_c $A 1)/$(finish_c $A 1)" "invalid:/invalid"
check "signup of an active account: account_exists mail, no signup row" "$(signup_req $A alice@x.com ua@u.test c0000000-0000-4000-8000-000000000013 8)$(sq "select count(*) from zsite_auth.mail_outbox where to_email='alice@x.com' and site_id='$A' and kind='account_exists'")/$(sq "select count(*) from zsite_auth.signups where site_id='$A' and email_norm='alice@x.com'")" "1/0"
signup_req $A late@x.com late@u.test c0000000-0000-4000-8000-000000000021 9 0 60 >/dev/null
su_q -c "update zsite_auth.signup_challenges set expires_at = now() - interval '1 second' where id = '$(cid 9)'" >/dev/null
check "expired challenge -> expired"              "$(begin_c $A 9)" "expired:"
signup_req $A race@x.com race@u.test c0000000-0000-4000-8000-000000000031 10 >/dev/null
check "race: begin ok"                            "$(begin_c $A 10)" "ok:c0000000-0000-4000-8000-000000000031"
su_q -c "insert into zsite.identities (site_id, email_norm, auth_user_id, alias, state) values ('$A','race@x.com','c0000000-0000-4000-8000-000000000032','raceother@u.test','active')" >/dev/null
check "race: finish -> conflict"                  "$(finish_c $A 10)" "conflict"
check "race: quarantined, the other account intact" "$(sq "select state from zsite_auth.signups where email_norm='race@x.com'")/$(sq "select auth_user_id from zsite.identities where email_norm='race@x.com'")" "quarantined/c0000000-0000-4000-8000-000000000032"
check "quarantined -> begin invalid"              "$(begin_c $A 10)" "invalid:"
signup_req $A gone@x.com gone@u.test c0000000-0000-4000-8000-000000000041 11 0 60 >/dev/null
begin_c $A 11 >/dev/null
su_q -c "update zsite_auth.signups set expires_at = now() - interval '1 s', lease_until = now() - interval '1 s' where email_norm='gone@x.com'; update zsite_auth.signup_challenges set expires_at = now() - interval '1 s' where id='$(cid 11)'" >/dev/null
check "purge returns the abandoned creating signup" "$(bq "select auth_user_id||'|'||alias from zsite_auth.signup_purge(100) where site_id='$A'")" "c0000000-0000-4000-8000-000000000041|gone@u.test"
check "purge removed it"                          "$(sq "select count(*) from zsite_auth.signups where email_norm='gone@x.com'")" "0"
su_q -c "insert into zsite.identities (site_id,email_norm,auth_user_id,alias,state) values ('$A','leg@x.com','c0000000-0000-4000-8000-0000000000e1','leg@u.test','unverified'); insert into zsite.members (site_id,user_id,role) values ('$A','c0000000-0000-4000-8000-0000000000e1','user')" >/dev/null
signup_req $A leg@x.com other@u.test c0000000-0000-4000-8000-0000000000e2 12 >/dev/null
check "legacy: the signup reuses the identity's id" "$(begin_c $A 12)" "ok:c0000000-0000-4000-8000-0000000000e1"
check "legacy: finish activates it in place"       "$(finish_c $A 12)/$(sq "select state||'|'||alias from zsite.identities where email_norm='leg@x.com'")" "ok/active|leg@u.test"
su_q -c "insert into zsite.identities (site_id,email_norm,auth_user_id,alias,state) values ('$A','resv@x.com',null,'resv-old@u.test','pending')" >/dev/null
signup_req $A resv@x.com resv@u.test c0000000-0000-4000-8000-0000000000e3 13 >/dev/null
begin_c $A 13 >/dev/null
check "reservation: finish claims it"              "$(finish_c $A 13)/$(sq "select state||'|'||auth_user_id||'|'||alias from zsite.identities where email_norm='resv@x.com'")" "ok/active|c0000000-0000-4000-8000-0000000000e3|resv@u.test"
check "outbox claim leases rows"                  "$(bq "select count(*) > 0 from zsite_auth.outbox_claim(100, 60)")" "t"
check "a second claim finds them leased"          "$(bq "select count(*) from zsite_auth.outbox_claim(100, 60)")" "0"
OID=$(sq "select min(id) from zsite_auth.mail_outbox")
OD=$(sq "select max(id) from zsite_auth.mail_outbox")
check "outbox_defer keeps a limited row for later" "$(bq "select zsite_auth.outbox_defer($OD, 900)")/$(sq "select lease_until > now() + interval '14 minutes' from zsite_auth.mail_outbox where id=$OD")" "t/t"
check "outbox_done deletes"                       "$(bq "select zsite_auth.outbox_done($OID)")/$(sq "select count(*) from zsite_auth.mail_outbox where id=$OID")" "t/0"
check_err "authenticated cannot request a signup" "$(as_role authenticated "select zsite_auth.signup_request('$A','e@x.com','e@u.test','$UX','$(cid 99)','$(sha x)',3600,0,3)")" "permission denied"
check_err "broker cannot read signups directly"   "$(bq "select count(*) from zsite_auth.signups")" "permission denied"
check_err "broker cannot read the outbox directly" "$(bq "select count(*) from zsite_auth.mail_outbox")" "permission denied"
check_err "old reserve_signup is gone"            "$(bq "select zsite_auth.reserve_signup('$A','z@x.com','z@u.test','$UX')")" "does not exist"
check_err "old activate_identity is gone"         "$(bq "select zsite_auth.activate_identity('$A','$UA')")" "does not exist"

begin_c $B 50 >/dev/null; finish_c $B 50 >/dev/null
signup_req $A bob@x.com bob@u.test $UBOB 60 >/dev/null; begin_c $A 60 >/dev/null; finish_c $A 60 >/dev/null
su_q -c "insert into auth.users (id, email, email_confirmed_at) values ('$UA','ua@u.test',now()), ('$UB','ub@u.test',now()), ('$UBOB','bob@u.test',now()), ('$UX','victim@example.com',now())" >/dev/null

hook() { # hook <uid> <claims-json> -> json
  as_role supabase_auth_admin "select zsite_auth.custom_access_token_hook(jsonb_build_object('user_id','$1','claims','$2'::jsonb,'authentication_method','password'))"
}
base() { echo "{\"sub\":\"$1\",\"role\":\"authenticated\",\"aud\":\"authenticated\",\"email\":\"x@u.test\",\"aal\":\"aal1\",\"session_id\":\"$2\",\"is_anonymous\":false${3:-}}"; }
pick() { sq "select coalesce(('$1'::jsonb) #>> '{$2}', '<null>')"; }

SA=$(new_session $UA "now() - interval '1 hour'")
out=$(hook $UA "$(base $UA $SA)")
check "hook stamps alice's site A"           "$(pick "$out" claims,site_id)" "$A"
check "hook stamps site_role user"           "$(pick "$out" claims,site_role)" "user"
check "hook stamps session_started_at = session creation" "$(sq "select (('$out'::jsonb)#>>'{claims,session_started_at}')::numeric = extract(epoch from created_at) from auth.sessions where id='$SA'")" "t"
check "hook keeps required claims"           "$(pick "$out" claims,session_id)/$(pick "$out" claims,aud)" "$SA/authenticated"
out=$(hook $UB "$(base $UB "$(new_session $UB)")")
check "same email on B -> B claim"           "$(pick "$out" claims,site_id)" "$B"
out=$(hook $UA "$(base $UA $SA ",\"site_id\":\"$B\",\"site_role\":\"admin\",\"session_started_at\":9999999999")")
check "tampered site_id is overwritten"      "$(pick "$out" claims,site_id)" "$A"
check "tampered site_role is overwritten"    "$(pick "$out" claims,site_role)" "user"
check "tampered session_started_at is overwritten" "$(sq "select (('$out'::jsonb)#>>'{claims,session_started_at}')::numeric < 9999999999")" "t"
out=$(hook $UX "$(base $UX "$(new_session $UX)")")
check "no identity row -> denied 403"        "$(pick "$out" error,http_code)" "403"
AMR=',"amr":[{"method":"password","timestamp":1700000000}]'
CL=$(base $UA 00000000-0000-4000-8000-000000000000 "$AMR")
out=$(hook $UA "$CL")
check "no session row: amr start is used"    "$(pick "$out" claims,session_started_at)" "1700000000"
out=$(hook $UA "$(base $UA 00000000-0000-4000-8000-000000000000)")
check "no session row and no amr -> denied (fail closed)" "$(pick "$out" error,http_code)" "403"
out=$(hook $UA "$(base $UA $SA | sed 's/"role":"authenticated"/"role":"service_role"/')")
check "non-authenticated role claim -> denied" "$(pick "$out" error,http_code)" "403"
out=$(hook $UA "$(base $UA $SA | sed 's/"is_anonymous":false/"is_anonymous":true/')")
check "anonymous user -> denied"              "$(pick "$out" error,http_code)" "403"
out=$(hook not-a-uuid "$(base $UA $SA)")
check "malformed user_id -> denied"           "$(pick "$out" error,http_code)" "403"
out=$(hook $UBOB "$(base $UA $SA)")
check "sub mismatch with user_id -> denied"   "$(pick "$out" error,http_code)" "403"
su_q -c "update zsite.members set status='disabled' where user_id='$UBOB'" >/dev/null
out=$(hook $UBOB "$(base $UBOB "$(new_session $UBOB)")")
check "disabled member -> denied"             "$(pick "$out" error,http_code)" "403"
su_q -c "update zsite.members set status='active' where user_id='$UBOB'" >/dev/null
su_q -c "insert into zsite.identities (site_id,email_norm,auth_user_id,alias,state) values ('$A','unv@x.com','c0000000-0000-4000-8000-000000000051','unv@u.test','unverified'); insert into zsite.members (site_id,user_id) values ('$A','c0000000-0000-4000-8000-000000000051'); insert into auth.users (id,email,email_confirmed_at) values ('c0000000-0000-4000-8000-000000000051','unv@u.test',now())" >/dev/null
out=$(hook c0000000-0000-4000-8000-000000000051 "$(base c0000000-0000-4000-8000-000000000051 "$(new_session c0000000-0000-4000-8000-000000000051)")")
check "unverified identity + confirmed email -> denied" "$(pick "$out" error,http_code)" "403"
su_q -c "update zsite.sites set status='suspended' where site_id='$A'" >/dev/null
check "suspended site -> denied"              "$(pick "$(hook $UA "$(base $UA $SA)")" error,http_code)" "403"
su_q -c "update zsite.sites set status='active' where site_id='$A'" >/dev/null

cross=$(sq "select count(*) from zsite.identities i
            where i.state = 'active' and exists (select 1 from auth.users u where u.id = i.auth_user_id)
              and (zsite_auth.custom_access_token_hook(jsonb_build_object('user_id', i.auth_user_id,
                     'claims', jsonb_build_object('sub', i.auth_user_id, 'role', 'authenticated', 'session_id', '$SA',
                                                  'amr', jsonb_build_array(jsonb_build_object('timestamp', 1)),
                                                  'site_id', '$B', 'is_anonymous', false)))
                   #>> '{claims,site_id}') is distinct from i.site_id::text")
check "no user ever gets another site's claim" "$cross" "0"

claims() { echo "{\"role\":\"authenticated\",\"sub\":\"$1\",\"site_id\":\"$2\",\"session_started_at\":$3}"; }
STARTED=$(sq "select extract(epoch from created_at) from auth.sessions where id='$SA'")
check "gateway check: live session valid"     "$(req authenticated "$(claims $UA $A $STARTED)" "select api.session_valid()")" "t"
check "revoke_sessions (password reset)"      "$(bq "select zsite_auth.revoke_sessions('$A','$UA')")" "t"
check "gateway check: the old session is refused at once" "$(req authenticated "$(claims $UA $A $STARTED)" "select api.session_valid()")" "f"
check "hook: refresh of the old session denied" "$(pick "$(hook $UA "$(base $UA $SA)")" error,http_code)" "403"
SNEW=$(new_session $UA)
check "hook: a session started after the reset is fine" "$(pick "$(hook $UA "$(base $UA $SNEW)")" claims,site_id)" "$A"
NEWSTART=$(sq "select extract(epoch from created_at) from auth.sessions where id='$SNEW'")
check "gateway check: new session valid"      "$(req authenticated "$(claims $UA $A $NEWSTART)" "select api.session_valid()")" "t"
check "gateway check: epochs are per (site, sub)" "$(req authenticated "$(claims $UB $B 1)" "select api.session_valid()")" "t"
check "gateway check: anon -> false"          "$(req anon "{\"role\":\"anon\",\"site_id\":\"$A\"}" "select api.session_valid()")" "f"
check "gateway check: no session_started_at -> false" "$(req authenticated "{\"role\":\"authenticated\",\"sub\":\"$UA\",\"site_id\":\"$A\"}" "select api.session_valid()")" "f"
check "revoke on the wrong site -> false"     "$(bq "select zsite_auth.revoke_sessions('$B','$UA')")" "f"

UAA=a0000000-0000-4000-8000-0000000000aa   # A's founder admin (provisioned)
UBA=b0000000-0000-4000-8000-0000000000aa   # B's founder admin
prov() { bq "select outcome||':'||auth_user_id from zsite_auth.provision_identity('$1','$2','$3','$4')"; }
check "provision founder on A"                "$(prov $A owner@x.com owner@u.test $UAA)" "created:$UAA"
check "bootstrap founder admin on A"          "$(bq "select zsite_auth.bootstrap_admin('$A','$UAA')")" "t"
check "bootstrap is idempotent"               "$(bq "select zsite_auth.bootstrap_admin('$A','$UAA')")" "t"
check_err "bootstrap cannot add a second admin" "$(bq "select zsite_auth.bootstrap_admin('$A','$UBOB')")" "admin_exists"
prov $B owner@x.com ownerb@u.test $UBA >/dev/null; bq "select zsite_auth.bootstrap_admin('$B','$UBA')" >/dev/null
su_q -c "insert into auth.users (id, email, email_confirmed_at) values ('$UAA','owner@u.test',now()), ('$UBA','ownerb@u.test',now())" >/dev/null
check_err "old set_member_role is gone"       "$(bq "select zsite_auth.set_member_role('$A','$UBOB','admin')")" "does not exist"
setrole() { bq "select user_id||'|'||role||'|'||status from zsite_auth.member_set_role('$1','$2','$3','$4')"; }
check_err "[malicious] non-admin cannot change roles" "$(setrole $A $UBOB $UA admin)" "member_admin_required"
check_err "[malicious] non-admin cannot invite" "$(bq "select outcome from zsite_auth.member_invite_reserve('$A','$UBOB','evil@x.com','evil@u.test','$UX','admin')")" "member_admin_required"
check_err "[malicious] non-admin cannot list"   "$(bq "select count(*) from zsite_auth.member_list('$A','$UBOB',null,50)")" "member_admin_required"
check_err "[malicious] B's admin cannot manage A (actor checked on A)" "$(setrole $A $UBA $UBOB user)" "member_admin_required"
check_err "[malicious] B's admin naming A's user on B -> member_not_found" "$(setrole $B $UBA $UBOB admin)" "member_not_found"
check_err "[malicious] B's admin cannot list A"  "$(bq "select count(*) from zsite_auth.member_list('$A','$UBA',null,50)")" "member_admin_required"
check_err "[malicious] undeclared role refused" "$(setrole $A $UAA $UBOB seller)" "invalid_role"
check_err "[malicious] malformed role refused"  "$(setrole $A $UAA $UBOB 'Admin; drop')" "invalid_role"
set_roles $A '["seller","moderator"]'
su_q -c "update zsite.site_contracts set schema_version = 1, roles = '[]'" >/dev/null
check_err "a v1 site has only admin/user"     "$(setrole $A $UAA $UBOB seller)" "invalid_role"
set_roles $A '["seller","moderator"]'
check "declared manifest role accepted"       "$(setrole $A $UAA $UBOB seller)" "$UBOB|seller|active"
check_err "a role declared on A is not valid on B" "$(setrole $B $UBA $UB seller)" "invalid_role"
check "role change bumps the member's sessions" "$(sq "select count(*) from zsite_auth.session_epochs where site_id='$A' and user_id='$UBOB'")" "1"
check "same role again is a no-op"            "$(setrole $A $UAA $UBOB seller)" "$UBOB|seller|active"
check_err "last admin cannot demote self"     "$(setrole $A $UAA $UAA user)" "last_admin"
check_err "last admin cannot be disabled"     "$(bq "select status from zsite_auth.member_disable('$A','$UAA','$UAA')")" "last_admin"
check_err "last admin cannot be removed"      "$(bq "select zsite_auth.member_remove_begin('$A','$UAA','$UAA')")" "last_admin"
check_err "last admin cannot delete own account" "$(bq "select zsite_auth.begin_deletion('$A','$UAA')")" "last_admin"
check "promote alice to admin"                "$(setrole $A $UAA $UA admin)" "$UA|admin|active"
( PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -U postgres >"$DIR/c1.out" 2>&1 <<SQL
set role zsite_broker;
begin;
select role from zsite_auth.member_set_role('$A','$UAA','$UA','user');
select pg_sleep(1.5);
commit;
SQL
) &
P1=$!
sleep 0.5
( PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -U postgres >"$DIR/c2.out" 2>&1 <<SQL
\set VERBOSITY terse
set role zsite_broker;
select role from zsite_auth.member_set_role('$A','$UA','$UAA','user');
SQL
) &
P2=$!
wait $P1; wait $P2
check "concurrent demotions: first committed"  "$(grep -c '^user$' "$DIR/c1.out")" "1"
check "concurrent demotions: second refused (actor no longer admin)" "$(grep -c 'member_admin_required' "$DIR/c2.out")" "1"
check "concurrent demotions: exactly one active admin left" "$(sq "select zsite_auth.active_admin_count('$A')")" "1"
setrole $A $UAA $UA admin >/dev/null
( PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -U postgres >"$DIR/d1.out" 2>&1 <<SQL
set role zsite_broker;
begin;
select status from zsite_auth.member_disable('$A','$UAA','$UA');
select pg_sleep(1.5);
commit;
SQL
) &
P1=$!
sleep 0.5
( PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -U postgres >"$DIR/d2.out" 2>&1 <<SQL
\set VERBOSITY terse
set role zsite_broker;
select status from zsite_auth.member_disable('$A','$UA','$UAA');
SQL
) &
P2=$!
wait $P1; wait $P2
check "concurrent disable: first committed"   "$(grep -c '^disabled$' "$DIR/d1.out")" "1"
check "concurrent disable: second refused"    "$(grep -c 'member_admin_required' "$DIR/d2.out")" "1"
check "concurrent disable: one active admin"   "$(sq "select zsite_auth.active_admin_count('$A')")" "1"
check_err "[malicious] a disabled admin is no longer an actor" "$(setrole $A $UA $UBOB user)" "member_admin_required"
out=$(hook $UA "$(base $UA "$(new_session $UA)")")
check "disabled member's token is denied"     "$(pick "$out" error,http_code)" "403"

inv() { bq "select outcome||':'||coalesce(auth_user_id::text,'') from zsite_auth.member_invite_reserve('$1','$2','$3','$4','$5','$6')"; }
UI=c0000000-0000-4000-8000-000000000061
check "invite a new address -> create"        "$(inv $A $UAA new@x.com new@u.test $UI seller)" "create:$UI"
check "invitee is unverified (grants nothing) with the role" "$(sq "select i.state||'|'||m.role from zsite.identities i join zsite.members m on m.user_id=i.auth_user_id where i.auth_user_id='$UI'")" "unverified|seller"
check "a repeat invite resumes the same id"   "$(inv $A $UAA new@x.com new@u.test c0000000-0000-4000-8000-000000000062 moderator)" "create:$UI"
check "invite finish activates"               "$(bq "select zsite_auth.member_invite_finish('$A','$UAA','$UI')")/$(sq "select state from zsite.identities where auth_user_id='$UI'")" "t/active"
check "invite of an existing account -> exists, role untouched" "$(inv $A $UAA bob@x.com bob@u.test c0000000-0000-4000-8000-000000000063 moderator)/$(sq "select role from zsite.members where user_id='$UBOB'")" "exists:$UBOB/seller"
check_err "invite with an undeclared role refused" "$(inv $A $UAA z@x.com z@u.test c0000000-0000-4000-8000-000000000064 superuser)" "invalid_role"
signup_req $A pend@x.com pend@u.test c0000000-0000-4000-8000-000000000071 70 >/dev/null
check "invite over a pending signup reuses its preallocated id" "$(inv $A $UAA pend@x.com pend@u.test c0000000-0000-4000-8000-000000000072 user)" "create:c0000000-0000-4000-8000-000000000071"
check "the pending signup's link is dead"     "$(begin_c $A 70)" "invalid:"
signup_req $A busy@x.com busy@u.test c0000000-0000-4000-8000-000000000081 80 >/dev/null; begin_c $A 80 >/dev/null
check "invite during a live confirm lease -> held" "$(inv $A $UAA busy@x.com busy@u.test c0000000-0000-4000-8000-000000000082 user)" "held:"
check "list: members, emails, invited status" "$(bq "select string_agg(email||':'||role||':'||status, ',' order by email) from zsite_auth.member_list('$A','$UAA',null,100)")" "alice@x.com:admin:disabled,bob@x.com:seller:active,leg@x.com:user:active,new@x.com:moderator:active,owner@x.com:admin:active,pend@x.com:user:invited,resv@x.com:user:active,unv@x.com:user:invited"
FIRST=$(bq "select user_id from zsite_auth.member_list('$A','$UAA',null,2) order by user_id desc limit 1")
check "list: keyset cursor continues after the cursor" "$(bq "select count(*) from zsite_auth.member_list('$A','$UAA','$FIRST',100) where user_id <= '$FIRST'")" "0"
check "list: limit is capped at 100"          "$(bq "select count(*) <= 100 from zsite_auth.member_list('$A','$UAA',null,100000)")" "t"
check "list never shows another site's members" "$(bq "select count(*) from zsite_auth.member_list('$A','$UAA',null,100) where user_id in ('$UB','$UBA')")" "0"
su_q -c "insert into zsite.records (site_id, collection, id, owner_id, data) values ('$A','notes',gen_random_uuid(),'$UBOB','{\"t\":\"bob-a1\"}'), ('$A','notes',gen_random_uuid(),'$UBOB','{\"t\":\"bob-a2\"}'), ('$B','notes',gen_random_uuid(),'$UB','{\"t\":\"b-only\"}')" >/dev/null
check "remove ends the membership only"       "$(bq "select zsite_auth.member_remove_begin('$A','$UAA','$UBOB')")/$(sq "select state from zsite.identities where auth_user_id='$UBOB'")/$(sq "select count(*) from zsite.members where user_id='$UBOB'")/$(sq "select count(*) from zsite_auth.deletions where auth_user_id='$UBOB'")" "t/active/0/0"
check "remove keeps the person's records"     "$(sq "select count(*) from zsite.records where owner_id='$UBOB'")" "2"
check "remove bumps sessions (access gone at once)" "$(sq "select count(*) from zsite_auth.session_epochs where site_id='$A' and user_id='$UBOB' and valid_after > now() - interval '1 minute'")" "1"
check "a removed member's token is denied"   "$(pick "$(hook $UBOB "$(base $UBOB "$(new_session $UBOB)")")" error,http_code)" "403"
check "remove is idempotent"                  "$(bq "select zsite_auth.member_remove_begin('$A','$UAA','$UBOB')")" "t"
check "a removed member is not listed"        "$(bq "select count(*) from zsite_auth.member_list('$A','$UAA',null,100) where user_id='$UBOB'")" "0"
check_err "remove of another site's member -> member_not_found" "$(bq "select zsite_auth.member_remove_begin('$A','$UAA','$UB')")" "member_not_found"
check "invite brings a removed member back"  "$(inv $A $UAA bob@x.com bob@u.test c0000000-0000-4000-8000-0000000000b1 seller)/$(sq "select role||'|'||status from zsite.members where user_id='$UBOB'")" "exists:$UBOB/seller|active"
bq "select zsite_auth.member_remove_begin('$A','$UAA','$UBOB')" >/dev/null
anonA() { echo "{\"role\":\"anon\",\"site_id\":\"$1\"}"; }
check "file capability check: removed member -> false" "$(req anon "$(anonA $A)" "select api.session_valid_for('$UBOB', 9999999999)")" "f"
check "file capability check: live member, current session -> true" "$(req anon "$(anonA $A)" "select api.session_valid_for('$UAA', extract(epoch from now()) + 1)")" "t"
check "file capability check: per site (A's member on B) -> false" "$(req anon "$(anonA $B)" "select api.session_valid_for('$UAA', 9999999999)")" "f"
check "site_active: active site"              "$(req anon "$(anonA $A)" "select api.site_active()")" "t"
su_q -c "update zsite.sites set status='suspended' where site_id='$A'" >/dev/null
check "site_active: frozen site refuses"        "$(req anon "$(anonA $A)" "select api.site_active()")" "f"
su_q -c "update zsite.sites set status='active' where site_id='$A'" >/dev/null
check "enable a disabled member"              "$(bq "select status from zsite_auth.member_enable('$A','$UAA','$UA')")" "active"
check_err "[malicious] enable by a non-admin" "$(bq "select status from zsite_auth.member_enable('$A','$UI','$UA')")" "member_admin_required"
check_err "[malicious] enable across sites"   "$(bq "select status from zsite_auth.member_enable('$A','$UAA','$UB')")" "member_not_found"
R1=$(sq "select id from zsite.records where owner_id='$UBOB' order by id limit 1")
RB=$(sq "select id from zsite.records where site_id='$B' limit 1")
check_err "[malicious] reassign by another site's admin" "$(bq "select owner_id from zsite_auth.member_reassign_record('$A','$UBA','notes','$R1','$UBA')")" "member_admin_required"
check_err "reassign to a non-member refused"  "$(bq "select owner_id from zsite_auth.member_reassign_record('$A','$UAA','notes','$R1','$UB')")" "member_not_found"
check_err "[malicious] reassign of another site's record -> not_found" "$(bq "select owner_id from zsite_auth.member_reassign_record('$A','$UAA','notes','$RB','$UAA')")" "not_found"
check_err "wrong collection -> not_found"     "$(bq "select owner_id from zsite_auth.member_reassign_record('$A','$UAA','other','$R1','$UAA')")" "not_found"
check "reassign one record"                   "$(bq "select id||'|'||owner_id from zsite_auth.member_reassign_record('$A','$UAA','notes','$R1','$UAA')")" "$R1|$UAA"
su_q -c "update zsite.records set idempotency_key='idem-key-reassign-0001', idempotency_hash=zsite.idem_hash('$UBOB', collection, data) where id = (select id from zsite.records where owner_id='$UBOB' limit 1)" >/dev/null
R2=$(sq "select id from zsite.records where owner_id='$UBOB' limit 1")
bq "select 1 from zsite_auth.member_reassign_record('$A','$UAA','notes','$R2','$UAA')" >/dev/null
check "reassign moves the idempotency binding with the owner" "$(sq "select idempotency_hash = zsite.idem_hash('$UAA', collection, data) from zsite.records where id='$R2'")" "t"
check "each reassign moves one record; other site untouched" "$(sq "select count(*) from zsite.records where owner_id='$UBOB'")/$(sq "select count(*) from zsite.records where site_id='$B' and owner_id='$UB'")" "0/1"
check_err "delete data needs the confirmation flag" "$(bq "select zsite_auth.member_delete_data_begin('$A','$UAA','$UBOB',false)")" "confirmation_required"
setrole $A $UAA $UA user >/dev/null
check_err "delete data of the last admin refused" "$(bq "select zsite_auth.member_delete_data_begin('$A','$UAA','$UAA',true)")" "last_admin"
check_err "[malicious] delete data across sites" "$(bq "select zsite_auth.member_delete_data_begin('$A','$UAA','$UB',true)")" "member_not_found"
check "delete data of a removed person freezes + tombstones" "$(bq "select zsite_auth.member_delete_data_begin('$A','$UAA','$UBOB',true)")/$(sq "select state from zsite.identities where auth_user_id='$UBOB'")/$(sq "select count(*) from zsite_auth.deletions where auth_user_id='$UBOB'")" "t/deleting/1"
check "delete data is idempotent"             "$(bq "select zsite_auth.member_delete_data_begin('$A','$UAA','$UBOB',true)")" "t"
check "audit rows by action" "$(sq "select string_agg(action||'='||n, ',' order by action) from (select action, count(*) n from zsite_auth.member_audit where site_id='$A' group by action) x")" "bootstrap_admin=1,delete_data=1,disable=1,enable=1,invite=6,invite_activated=1,list=6,reassign=2,remove=2,set_role=5"
check "audit carries actor, target, role change" "$(sq "select actor_id||'|'||target_id||'|'||(detail->>'from')||'>'||(detail->>'to') from zsite_auth.member_audit where action='set_role' order by id limit 1")" "$UAA|$UBOB|user>seller"
check "audit stores no email (hash only)"     "$(sq "select count(*) from zsite_auth.member_audit where detail::text like '%@%'")" "0"
check "refused attempts write no audit rows"  "$(sq "select count(*) from zsite_auth.member_audit where site_id='$A' and actor_id in ('$UBOB','$UBA')")" "0"
check_err "audit cannot be updated"           "$(sq "update zsite_auth.member_audit set action='list'")" "audit_append_only"
check_err "audit cannot be deleted"           "$(sq "delete from zsite_auth.member_audit")" "audit_append_only"
check_err "audit cannot be truncated"         "$(sq "truncate zsite_auth.member_audit")" "audit_append_only"
check_err "broker cannot read the audit"      "$(bq "select count(*) from zsite_auth.member_audit")" "permission denied"
check_err "broker cannot call internal helpers" "$(bq "select zsite_auth.bump_sessions('$A','$UA')")" "permission denied"
check_err "authenticated cannot call member RPCs" "$(as_role authenticated "select count(*) from zsite_auth.member_list('$A','$UAA',null,50)")" "permission denied"

bec() { bq "select zsite_auth.begin_email_change('$1','$2','$3','$4','$5', $6)"; }
claim() { bq "select outcome || ':' || coalesce(new_email_norm,'') from zsite_auth.claim_email_change('$1','$2')"; }
UC=c0000000-0000-4000-8000-000000000091
signup_req $A carol@x.com carol@u.test $UC 90 >/dev/null; begin_c $A 90 >/dev/null; finish_c $A 90 >/dev/null
check "change to an existing account's email -> taken" "$(bec $A $UC owner@x.com o2@u.test tok-taken 3600)" "taken"
check "change via the wrong site -> invalid"  "$(bec $B $UC n@x.com n0@u.test tok-wrong 3600)" "invalid"
check "carol reserves newc@x.com"             "$(bec $A $UC newc@x.com nc@u.test tok-c1 3600)" "reserved"
check "signup of the reserved address records nothing" "$(signup_req $A newc@x.com nc@u.test c0000000-0000-4000-8000-000000000092 91)$(sq "select count(*) from zsite_auth.signups where email_norm='newc@x.com'")" "0"
check "claim on B -> invalid"                 "$(claim $B tok-c1)" "invalid:"
check "claim on A -> ok"                      "$(claim $A tok-c1)" "ok:newc@x.com"
CID=$(sq "select id from zsite_auth.email_changes where token_sha256='tok-c1'")
check "commit"                                "$(bq "select old_email_norm||'>'||new_email_norm from zsite_auth.commit_email_change('$CID')")" "carol@x.com>newc@x.com"
check "commit bumps carol's sessions"         "$(sq "select count(*) from zsite_auth.session_epochs where user_id='$UC'")" "1"
check "reused token -> used"                  "$(claim $A tok-c1)" "used:"
check "identity_by_user_v2 carries the epoch" "$(bq "select site_id||'|'||email_norm||'|'||state||'|'||(sessions_valid_after is not null) from zsite_auth.identity_by_user_v2('$UC')")" "$A|newc@x.com|active|true"

su_q <<SQL >/dev/null
insert into zsite.records (site_id, collection, id, owner_id, data) values
 ('$A','notes',gen_random_uuid(),'$UC','{"t":"c1"}'), ('$A','notes',gen_random_uuid(),'$UC','{"t":"c2"}'),
 ('$B','notes',gen_random_uuid(),'$UB','{"t":"aliceB"}');
insert into storage.buckets (id, name) values ('site-files','site-files') on conflict do nothing;
insert into storage.objects (bucket_id, name, owner_id) values
 ('site-files', '$A/avatars/c.png', '$UC'), ('site-files', '$B/avatars/c-spoof.png', '$UC');
SQL
check "begin deletion on the wrong site refused" "$(bq "select zsite_auth.begin_deletion('$B','$UC')")" "f"
check "begin deletion"                        "$(bq "select zsite_auth.begin_deletion('$A','$UC')")" "t"
check "deletion audits self_delete"           "$(sq "select count(*) from zsite_auth.member_audit where action='self_delete' and target_id='$UC'")" "1"
check "own objects in own site only"          "$(bq "select string_agg(n, ',') from zsite_auth.user_object_names('$A','$UC', 100) n")" "$A/avatars/c.png"
check "delete data"                           "$(bq "select zsite_auth.delete_account_data('$A','$UC')")" "2"
check "identity + membership gone"            "$(sq "select (select count(*) from zsite.identities where auth_user_id='$UC')||'/'||(select count(*) from zsite.members where user_id='$UC')")" "0/0"
check "finish deletion"                       "$(bq "select zsite_auth.finish_deletion('$UC')")" "t"
check "resume after finish returns false (no tombstone)" "$(bq "select zsite_auth.begin_deletion('$A','$UC')")" "f"

UD=c0000000-0000-4000-8000-0000000000d1
signup_req $A dee@x.com dee@u.test $UD 95 >/dev/null; begin_c $A 95 >/dev/null; finish_c $A 95 >/dev/null
su_q -c "insert into zsite.records (site_id, collection, id, owner_id, data) values ('$A','notes','d0000000-0000-4000-8000-0000000000a1','$UD','{\"t\":\"res1\"}'), ('$A','notes','d0000000-0000-4000-8000-0000000000a2','$UD','{\"t\":\"res2\"}')" >/dev/null
bq "select zsite_auth.begin_deletion('$A','$UD')" >/dev/null
HAS_K=$(sq "select to_regprocedure('zsite.k_platform_delete_record(uuid,text,uuid)') is not null")
if [ "$HAS_K" = "f" ]; then
  su_q -c "update zsite.site_contracts set schema_version = 2, actions = '{\"reserve_slot\":{}}' where site_id='$A'" >/dev/null 2>&1 || true
  if [ "$(sq "select count(*) from zsite.site_contracts where site_id='$A' and actions::text <> '[]' and actions::text <> '{}'")" = "1" ]; then
    check_err "no kernel helper + declared actions -> refuse, nothing erased" "$(bq "select zsite_auth.delete_account_data('$A','$UD')")" "kernel_delete_unavailable"
    check "refused erase leaves the records"    "$(sq "select count(*) from zsite.records where owner_id='$UD'")" "2"
  fi
  su_q <<'SQL' >/dev/null
create table ztest_capacity (slot text primary key, booked integer not null);
insert into ztest_capacity values ('slot1', 2);
create function zsite.k_platform_delete_record(p_site uuid, p_collection text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $f$
begin
  if exists (select 1 from zsite.records r where r.id = p_id and r.data->>'t' = 'poison') then
    raise exception 'kernel_bookkeeping_failed' using errcode = '55000';
  end if;
  update public.ztest_capacity set booked = booked - 1 where slot = 'slot1';
  delete from zsite.records r where r.site_id = p_site and r.collection = p_collection and r.id = p_id;
end $f$;
SQL
  su_q -c "update zsite.records set data = '{\"t\":\"poison\"}' where id = 'd0000000-0000-4000-8000-0000000000a2'" >/dev/null
  check_err "a bookkeeping failure aborts the erase"   "$(bq "select zsite_auth.delete_account_data('$A','$UD')")" "kernel_bookkeeping_failed"
  check "both intact after the failure (records, counter, identity)" "$(sq "select count(*) from zsite.records where owner_id='$UD'")/$(sq "select booked from ztest_capacity")/$(sq "select count(*) from zsite.identities where auth_user_id='$UD'")" "2/2/1"
  su_q -c "update zsite.records set data = '{\"t\":\"res2\"}' where id = 'd0000000-0000-4000-8000-0000000000a2'" >/dev/null
  check "erase deletes through the kernel: capacity returned" "$(bq "select zsite_auth.delete_account_data('$A','$UD')")/$(sq "select booked from ztest_capacity")/$(sq "select count(*) from zsite.records where owner_id='$UD'")" "2/0/0"
  su_q -c "drop function zsite.k_platform_delete_record(uuid, text, uuid); drop table ztest_capacity" >/dev/null
else
  check "erase through the real kernel helper"  "$(bq "select zsite_auth.delete_account_data('$A','$UD')")/$(sq "select count(*) from zsite.records where owner_id='$UD'")" "2/0"
fi

check "rate: 3 allowed then denied"           "$(bq "select string_agg(zsite_auth.rate_take('k1', 60, 3)::text, ',') from generate_series(1,5)")" "true,true,true,false,false"
check "nonce: first claim wins, replay refused" "$(bq "select zsite_auth.claim_nonce('req-12345678', 300)::text || ',' || zsite_auth.claim_nonce('req-12345678', 300)::text")" "true,false"
check_err "anon cannot claim nonces"          "$(as_role anon "select zsite_auth.claim_nonce('req-87654321', 300)")" "permission denied"
check_err "service_role cannot run broker fns" "$(as_role service_role "select zsite_auth.revoke_sessions('$A','$UA')")" "permission denied"
check_err "anon cannot run the hook"          "$(as_role anon "select zsite_auth.custom_access_token_hook('{}')")" "permission denied"
check_err "broker cannot run the hook"        "$(bq "select zsite_auth.custom_access_token_hook('{}')")" "permission denied"
check_err "broker cannot read zsite tables"   "$(bq "select count(*) from zsite.identities")" "permission denied"

su_q <<SQL >/dev/null
insert into zsite.collections (site_id, name, rules, schema) values
 ('$A', 'contact', '{"create":["anyone"],"list":["admin"],"get":["admin"],"delete":["admin"]}',
  '{"type":"object","required":["name"],"properties":{"name":{"type":"string","maxLength":200}}}')
on conflict do nothing;
delete from zsite_auth.form_notify_outbox;
SQL
ANON_A="{\"role\":\"anon\",\"site_id\":\"$A\"}"
fcreate() { req anon "$ANON_A" "select api.create_record('contact', '{\"name\":\"$1\"}', '$2')->>'replayed'"; }
noutbox() { sq "select count(*) from zsite_auth.form_notify_outbox where site_id='$A'"; }
check "anon form submission is saved"                  "$(fcreate Ann form-key-000000000001)" "false"
check "...and enqueues one owner notification"         "$(noutbox)" "1"
check "double submit (same key) replays, no 2nd notice" "$(fcreate Ann form-key-000000000001)/$(noutbox)" "true/1"
check "a second submission enqueues a second notice"   "$(fcreate Bob form-key-000000000002)/$(noutbox)" "false/2"
fcreate "zavi-smoke-0123456789abcdef" form-key-000000000003 >/dev/null
check "submitted text never suppresses the notice (no content scan)" "$(noutbox)" "3"
su_q -c "delete from zsite_auth.form_notify_outbox where record_id in (select id from zsite.records where data->>'name' like 'zavi-smoke-%'); delete from zsite.records where data->>'name' like 'zavi-smoke-%'" >/dev/null
check "a signed-in-only collection never notifies"     "$(req authenticated "$(claims $UA $A $NEWSTART)" "select (api.create_record('notes', '{\"t\":\"n\"}')->>'replayed')")/$(sq "select count(*) from zsite_auth.form_notify_outbox where collection='notes'")" "false/0"
su_q -c "insert into zsite.records (site_id, collection, id, data) values ('$A', 'contact', gen_random_uuid(), '{\"name\":\"import\"}')" >/dev/null
check "a platform write (no request claim) never notifies" "$(noutbox)" "2"
check "claim returns the record values, leased"        "$(bq "select string_agg(data->>'name', ',' order by id) from zsite_auth.form_notify_claim(10, 60)")" "Ann,Bob"
check "a second claim finds them leased"               "$(bq "select count(*) from zsite_auth.form_notify_claim(10, 60)")" "0"
FN1=$(sq "select min(id) from zsite_auth.form_notify_outbox"); FN2=$(sq "select max(id) from zsite_auth.form_notify_outbox")
lease() { sq "select jsonb_build_array(jsonb_build_object('id', id::text, 'token', lease_token)) from zsite_auth.form_notify_outbox where id=$1"; }
L1=$(lease $FN1); L2=$(lease $FN2)
STALE="[{\"id\": $FN1, \"token\": \"00000000-0000-4000-8000-000000000000\"}]"
check "a stale lease token cannot complete the row"    "$(bq "select zsite_auth.form_notify_done('$STALE'::jsonb)")/$(noutbox)" "0/2"
check "defer keeps the row and refunds the attempt"    "$(bq "select zsite_auth.form_notify_defer('$L2'::jsonb, 900)")/$(sq "select attempts from zsite_auth.form_notify_outbox where id=$FN2")" "1/0"
check "done deletes (current lease holder)"            "$(bq "select zsite_auth.form_notify_done('$L1'::jsonb)")/$(noutbox)" "1/1"
check "a deferred row's old lease cannot complete it"  "$(bq "select zsite_auth.form_notify_done('$L2'::jsonb)")/$(noutbox)" "0/1"
su_q -c "delete from zsite.records where site_id='$A' and collection='contact' and data->>'name'='Bob'" >/dev/null
su_q -c "update zsite_auth.form_notify_outbox set lease_until = null" >/dev/null
check "a deleted record's notice is never leased"     "$(bq "select count(*) from zsite_auth.form_notify_claim(10, 60)")/$(noutbox)" "0/1"
check "...and the purge removes it and SAYS why"       "$(bq "select string_agg(reason || ':' || n, ',') from zsite_auth.form_notify_purge(100)")/$(noutbox)" "record_deleted:1/0"
fcreate Cat form-key-000000000005 >/dev/null; fcreate Dan form-key-000000000006 >/dev/null; fcreate Eve form-key-000000000007 >/dev/null
su_q -c "update zsite_auth.form_notify_outbox set attempts = 8 where record_id = (select id from zsite.records where data->>'name'='Cat'); update zsite_auth.form_notify_outbox set created_at = now() - interval '4 days' where record_id = (select id from zsite.records where data->>'name'='Dan'); update zsite_auth.form_notify_outbox set created_at = now() - interval '2 hours' where record_id = (select id from zsite.records where data->>'name'='Eve')" >/dev/null
check "backlog reports pending rows and the oldest age" "$(bq "select pending || '/' || (oldest_age_s > 3 * 86400) from zsite_auth.form_notify_backlog()")" "3/true"
check "exhausted and expired rows are purged and counted" "$(bq "select string_agg(reason || ':' || n, ',' order by reason) from zsite_auth.form_notify_purge(100)")/$(noutbox)" "exhausted:1,expired:1/1"
fcreate Fay form-key-000000000008 >/dev/null
su_q -c "update zsite.sites set status = 'suspended' where site_id = '$A'" >/dev/null
check "a SUSPENDED site's notices are kept (reversible, e.g. graduation)" "$(bq "select count(*) from zsite_auth.form_notify_purge(100)")/$(noutbox)" "0/2"
su_q -c "update zsite.sites set status = 'deleting' where site_id = '$A'" >/dev/null
check "a site being deleted: its notices are purged as site_gone (counted)" "$(bq "select string_agg(reason || ':' || n, ',') from zsite_auth.form_notify_purge(100)")/$(noutbox)" "site_gone:2/0"
su_q -c "update zsite.sites set status = 'active' where site_id = '$A'" >/dev/null
check "a purge with nothing to purge reports nothing"  "$(bq "select count(*) from zsite_auth.form_notify_purge(100)")" "0"
su_q -c "delete from zsite_auth.form_notify_outbox" >/dev/null
su_q <<SQL >/dev/null
insert into zsite.collections (site_id, name, rules, schema) values
 ('$B', 'contact', '{"create":["anyone"],"list":["admin"],"get":["admin"]}',
  '{"type":"object","required":["name"],"properties":{"name":{"type":"string","maxLength":200}}}')
on conflict do nothing;
update zsite.quotas set max_writes_per_min = 1000 where site_id in ('$A', '$B');
SQL
for i in $(seq 10 34); do fcreate "Flood$i" "flood-key-0000000000$i" >/dev/null; done
req anon "{\"role\":\"anon\",\"site_id\":\"$B\"}" "select api.create_record('contact', '{\"name\":\"Quiet\"}', 'quiet-key-000000000001')" >/dev/null
check "a flooded site cannot starve the shard: 20 per site per claim" "$(bq "select string_agg(site_id::text || ':' || n, ',' order by site_id) from (select site_id, count(*) n from zsite_auth.form_notify_claim(200, 60) group by site_id) x")" "$A:20,$B:1"
check_err "anon cannot read the outbox"                "$(as_role anon "select count(*) from zsite_auth.form_notify_outbox")" "permission denied"
check_err "anon cannot purge notices"                  "$(as_role anon "select * from zsite_auth.form_notify_purge(1)")" "permission denied"
check_err "anon cannot claim notices"                  "$(as_role anon "select * from zsite_auth.form_notify_claim(1, 60)")" "permission denied"
check_err "broker cannot read the outbox directly"     "$(bq "select count(*) from zsite_auth.form_notify_outbox")" "permission denied"

C=cccccccc-0000-4000-8000-00000000000c; D=dddddddd-0000-4000-8000-00000000000d
su_q <<SQL >/dev/null
set session_replication_role = replica;
insert into zsite.sites (site_id) values ('$C'), ('$D');
insert into zsite.collections (site_id, name, rules, schema, archived_at) values
 ('$C', 'enquiries', '{"create":["anyone"],"list":["admin"]}', '{"type":"object","properties":{"name":{"type":"string","maxLength":80}}}', null),
 ('$C', 'notes', '{"create":["signed_in"],"list":["owner"]}', '{"type":"object","properties":{"name":{"type":"string","maxLength":80}}}', null),
 ('$C', 'bookings', '{"create":[],"list":["owner","admin"]}', '{"type":"object","properties":{"name":{"type":"string","maxLength":80}}}', null),
 ('$C', 'staff_log', '{"create":[],"list":["admin"]}', '{"type":"object","properties":{"name":{"type":"string","maxLength":80}}}', null),
 ('$C', 'old_form', '{"create":["anyone"]}', '{"type":"object","properties":{"name":{"type":"string","maxLength":80}}}', now()),
 ('$D', 'enquiries', '{"create":["anyone"]}', '{"type":"object","properties":{"name":{"type":"string","maxLength":80}}}', null);
insert into zsite.site_contracts (site_id, schema_version, actions) values ('$C', 2,
 '{"reserve":{"creates":{"collection":"bookings"},"principals":["signed_in"]},"log":{"creates":{"collection":"staff_log"},"principals":["admin"]}}');
insert into zsite.records (site_id, collection, id, data, created_at)
select '$C', c, gen_random_uuid(), '{}', now() - t::interval from (values
  ('enquiries', '1 hour'), ('enquiries', '2 hours'), ('enquiries', '3 days'), ('enquiries', '10 days'), ('enquiries', '40 days'),
  ('bookings', '2 hours'), ('notes', '1 hour'), ('staff_log', '1 hour'), ('old_form', '1 hour')) v(c, t);
insert into zsite.records (site_id, collection, id, data, created_at) values
 ('$D', 'enquiries', gen_random_uuid(), '{}', now()),
 ('$C', 'enquiries', gen_random_uuid(), '{}', '2026-01-02 03:00+00');
SQL
stats() { bq "select string_agg(collection || ':' || via_action || ':' || coalesce(prev_n, -1) || ':' || coalesce(total_n, -1), ',' order by collection) from zsite_auth.site_submission_stats('$C', $1, $2, $3, '${4:-UTC}') where day is null"; }
days() { bq "select string_agg(collection || ':' || n, ',' order by collection) from (select collection, sum(n) n from zsite_auth.site_submission_stats('$C', $1, $2, $3, '${4:-UTC}') where day is not null group by collection) x"; }
check "public forms and public-action collections count; signed-in, admin-action, archived do not" "$(stats "now() - interval '7 days'" "now() + interval '1 minute'" "now() - interval '14 days'")" "bookings:true:0:1,enquiries:false:1:6"
check "per-day rows add up to the window's count"        "$(days "now() - interval '7 days'" "now() + interval '1 minute'" "now() - interval '14 days'")" "bookings:1,enquiries:3"
check "another site's records never count"               "$(bq "select coalesce(sum(n), 0) from zsite_auth.site_submission_stats('$D', now() - interval '1 day', now() + interval '1 minute', now() - interval '2 days', 'UTC') where day is not null")" "1"
check "days are the founder's calendar days"            "$(bq "select day from zsite_auth.site_submission_stats('$C', '2026-01-01', '2026-01-03', '2025-12-30', 'America/Los_Angeles') where day is not null")" "2026-01-01"
check "...and UTC's when asked"                         "$(bq "select day from zsite_auth.site_submission_stats('$C', '2026-01-01', '2026-01-03', '2025-12-30', 'UTC') where day is not null")" "2026-01-02"
check_err "an unknown time zone is refused"             "$(bq "select count(*) from zsite_auth.site_submission_stats('$C', now() - interval '7 days', now(), now() - interval '14 days', 'Mars/Olympus')")" "invalid_timezone"
check_err "an inverted window is refused"               "$(bq "select count(*) from zsite_auth.site_submission_stats('$C', now(), now() - interval '7 days', now() - interval '14 days', 'UTC')")" "invalid"
check_err "a window over 800 days is refused"           "$(bq "select count(*) from zsite_auth.site_submission_stats('$C', now() - interval '500 days', now(), now() - interval '1000 days', 'UTC')")" "invalid"
check_err "anon cannot read submission counts"          "$(as_role anon "select count(*) from zsite_auth.site_submission_stats('$C', now() - interval '7 days', now(), now() - interval '14 days', 'UTC')")" "permission denied"
check_err "service_role cannot read submission counts"  "$(as_role service_role "select count(*) from zsite_auth.site_submission_stats('$C', now() - interval '7 days', now(), now() - interval '14 days', 'UTC')")" "permission denied"
check_err "the broker still cannot read records"        "$(bq "select count(*) from zsite.records")" "permission denied"

echo
echo "SQL auth tests: $PASSN passed, $FAILN failed"
[ "$FAILN" -eq 0 ]
