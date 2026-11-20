#!/usr/bin/env bash
set -uo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
PORT="${PORT:-55461}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../migrations"
DIR="$(mktemp -d -t site-shard-pg17)"
RESULTS="${RESULTS:-}"

cleanup() {
  if [ -n "${KEEP:-}" ]; then echo "KEEP: cluster left at $DIR (port $PORT)"; return; fi
  "$PGBIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DIR/data" -U postgres -A trust >/dev/null
"$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses='' -c max_connections=100 -c log_lock_waits=on -c track_functions=pl" \
  -l "$DIR/log" -w start >/dev/null

PSQL=("$PGBIN/psql" -h "$DIR" -p "$PORT" -d postgres -X -v ON_ERROR_STOP=1 -qAt)
su_q() { PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -U postgres "$@"; }

A=aaaaaaaa-0000-4000-8000-00000000000a
B=bbbbbbbb-0000-4000-8000-00000000000b
C=cccccccc-0000-4000-8000-00000000000c   # concurrency: max_records = 10
D=dddddddd-0000-4000-8000-00000000000d   # concurrency: max_writes_per_min = 5
S=eeeeeeee-0000-4000-8000-00000000000e   # suspended site
A_ADMIN=a0000000-0000-4000-8000-000000000001
A_U1=a0000000-0000-4000-8000-000000000002
A_U2=a0000000-0000-4000-8000-000000000003
B_ADMIN=b0000000-0000-4000-8000-000000000001
B_U1=b0000000-0000-4000-8000-000000000002

anonA="{\"role\":\"anon\",\"site_id\":\"$A\"}"
anonC="{\"role\":\"anon\",\"site_id\":\"$C\"}"
anonD="{\"role\":\"anon\",\"site_id\":\"$D\"}"
adminA="{\"role\":\"authenticated\",\"site_id\":\"$A\",\"sub\":\"$A_ADMIN\",\"site_role\":\"admin\"}"
u1A="{\"role\":\"authenticated\",\"site_id\":\"$A\",\"sub\":\"$A_U1\",\"site_role\":\"user\"}"
u2A="{\"role\":\"authenticated\",\"site_id\":\"$A\",\"sub\":\"$A_U2\",\"site_role\":\"user\"}"
anonS="{\"role\":\"anon\",\"site_id\":\"$S\"}"
svcClaimA="{\"role\":\"service_role\",\"site_id\":\"$A\"}"
adminB="{\"role\":\"authenticated\",\"site_id\":\"$B\",\"sub\":\"$B_ADMIN\",\"site_role\":\"admin\"}"

su_q <<SQL
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;

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

for m in 0001_core 0002_api 0003_storage; do
  su_q -f "$MIG/$m.sql" >"$DIR/mig.log" 2>&1 || { echo "migration $m failed"; cat "$DIR/mig.log"; exit 1; }
done
for m in 0001_core 0002_api 0003_storage; do
  su_q -f "$MIG/$m.sql" >/dev/null || { echo "migration $m re-apply failed"; exit 1; }
done
L=ffffffff-0000-4000-8000-00000000000f
su_q <<SQL
set role service_role;
insert into zsite.sites (site_id) values ('$L');
insert into zsite.collections (site_id, name, rules, schema, indexes) values ('$L', 'legacy',
  '{"list":["anyone"],"get":["anyone"]}',
  '{"type":"object","properties":{"category":{"type":"string","maxLength":20},"n":{"type":"integer"}}}',
  '{"category":"s1","n":"s2"}');
insert into zsite.records (site_id, collection, id, data) values ('$L', 'legacy', gen_random_uuid(), '{"category":"cars","n":7}');
insert into zsite.identities (site_id, email_norm, auth_user_id, alias, state)
values ('$L', 'old@l.test', 'f0000000-0000-4000-8000-000000000001', 'hl@u.zavisite.invalid', 'pending');
insert into zsite.collections (site_id, name, rules, schema, indexes) values
  ('$L', 'legacy_fits', '{"list":["anyone"]}', '{"type":"object","properties":{"slug":{"type":"string","maxLength":1000}}}', '{"slug":"s1"}'),
  ('$L', 'legacy_long', '{"list":["anyone"]}', '{"type":"object","properties":{"slug":{"type":"string","maxLength":1000}}}', '{"slug":"s1"}');
insert into zsite.records (site_id, collection, id, data) values
  ('$L', 'legacy_fits', gen_random_uuid(), '{"slug":"short"}'),
  ('$L', 'legacy_long', gen_random_uuid(), jsonb_build_object('slug', repeat('x', 600)));
SQL
for m in 0004_membership_slots_perf 0004_membership_slots_perf 0005_contracts_archive_reindex 0005_contracts_archive_reindex \
         0006_contract_v2 0007_relational_slots_rls 0008_relational_api 0009_recipient_cap_quota 0010_release_on_delete \
         0006_contract_v2 0007_relational_slots_rls 0008_relational_api 0009_recipient_cap_quota 0010_release_on_delete \
         0013_transition_expect_set 0013_transition_expect_set 0080_function_callers 0080_function_callers; do
  su_q -f "$MIG/$m.sql" >"$DIR/mig.log" 2>&1 || { echo "migration $m failed"; cat "$DIR/mig.log"; exit 1; }
done

su_q <<'SQL'
create schema ztest;
create function ztest.run(p text) returns text language plpgsql security definer set search_path = '' as $$
declare r text; begin execute p into r; return r; end $$;
alter function ztest.run(text) owner to zsite_facade;
grant usage on schema ztest to anon, authenticated, zsite_facade;
grant execute on function ztest.run(text) to anon, authenticated;
SQL

reindex() { su_q 2>&1 <<SQL
set role service_role;
call zsite.reindex_collection('$1', '$2', ${3:-2000});
SQL
}

q() {
  local out rc
  out=$("${PSQL[@]}" -U authenticator 2>&1 <<SQL
\set VERBOSITY terse
begin;
set local role $1;
set local "request.jwt.claims" = '$2';
$3;
commit;
SQL
  ); rc=$?
  if [ $rc -ne 0 ]; then
    echo "ERR: $(echo "$out" | grep -m1 -E 'ERROR' | sed -E 's/^.*ERROR: +//')"
  else
    echo "$out"
  fi
}

PASSN=0; FAILN=0
LOG="$DIR/results.txt"; : > "$LOG"
say() { echo "$*"; echo "$*" >> "$LOG"; }
check() {     # name got expected
  if [ "$2" = "$3" ]; then PASSN=$((PASSN+1)); say "PASS  $1  [$2]";
  else FAILN=$((FAILN+1)); say "FAIL  $1: expected [$3], got [$2]"; fi
}
check_err() { # name got substring-of-error
  if [[ -n "$3" && "$2" == ERR:* && "$2" == *"$3"* ]]; then PASSN=$((PASSN+1)); say "PASS  $1  [denied: ${2#ERR: }]";
  else FAILN=$((FAILN+1)); say "FAIL  $1: expected error containing [$3], got [$2]"; fi
}

CATALOG_RULES='{"list":["anyone"],"get":["anyone"],"create":["admin"],"update":["admin"],"delete":["admin"]}'
CATALOG_SCHEMA='{"type":"object","required":["name","price"],"properties":{
  "name":{"type":"string","maxLength":80},
  "price":{"type":"number","minimum":0},
  "seats":{"type":"integer","minimum":1,"maximum":12},
  "category":{"type":"string","maxLength":20,"enum":["cars","vans"]},
  "cost":{"type":"number"},
  "tags":{"type":"array","maxItems":5,"items":{"type":"string","maxLength":20}}}}'
CATALOG_FIELDS='{"cost":{"read":["admin"],"write":["admin"]}}'
BOOK_RULES='{"list":["owner","admin"],"get":["owner","admin"],"create":["anyone"],"update":["owner","admin"],"delete":["admin"]}'
BOOK_SCHEMA='{"type":"object","required":["name","email","date"],"properties":{
  "name":{"type":"string","maxLength":80},
  "email":{"type":"string","maxLength":200,"format":"email"},
  "date":{"type":"string","maxLength":10,"format":"date"},
  "notes":{"type":"string","maxLength":500},
  "status":{"type":"string","maxLength":20,"enum":["pending","confirmed","cancelled"]}}}'
BOOK_FIELDS='{"status":{"write":["admin"]}}'
FILES_RULES='{"list":["anyone"],"get":["anyone"],"create":["admin"],"update":["admin"],"delete":["admin"]}'

su_q <<SQL
set role service_role;
insert into zsite.sites (site_id) values ('$A'), ('$B'), ('$C'), ('$D');
insert into zsite.sites (site_id, status) values ('$S', 'suspended');
update zsite.quotas set max_records = 10 where site_id = '$C';
update zsite.quotas set max_writes_per_min = 5 where site_id = '$D';
update zsite.quotas set max_record_bytes = 2000 where site_id = '$A';

insert into zsite.identities (site_id, email_norm, auth_user_id, alias) values
  ('$A', 'admin@a.test', '$A_ADMIN', 'h1@u.zavisite.invalid'),
  ('$A', 'u1@a.test',    '$A_U1',    'h2@u.zavisite.invalid'),
  ('$A', 'u2@a.test',    '$A_U2',    'h3@u.zavisite.invalid'),
  ('$B', 'admin@b.test', '$B_ADMIN', 'h4@u.zavisite.invalid'),
  ('$B', 'u1@b.test',    '$B_U1',    'h5@u.zavisite.invalid');
insert into zsite.members (site_id, user_id, role) values
  ('$A', '$A_ADMIN', 'admin'), ('$A', '$A_U1', 'user'), ('$A', '$A_U2', 'user'),
  ('$B', '$B_ADMIN', 'admin'), ('$B', '$B_U1', 'user');

insert into zsite.collections (site_id, name, rules, schema, fields, indexes)
select s, 'catalog', '$CATALOG_RULES', '$CATALOG_SCHEMA', '$CATALOG_FIELDS', '{"category":{"type":"text","ops":["eq"]},"cost":{"type":"number","ops":["eq","range"]}}'
from unnest(array['$A','$B']::uuid[]) s;
insert into zsite.collections (site_id, name, rules, schema, fields, indexes)
select s, 'bookings', '$BOOK_RULES', '$BOOK_SCHEMA', '$BOOK_FIELDS', '{"status":{"type":"text","ops":["eq"]}}'
from unnest(array['$A','$B','$C','$D']::uuid[]) s;
insert into zsite.collections (site_id, name, rules, schema) values
  ('$B', 'secret_notes', '{"list":["anyone"],"get":["anyone"],"create":["admin"]}',
   '{"type":"object","properties":{"text":{"type":"string","maxLength":200}}}');
insert into zsite.collections (site_id, name, kind, rules)
select s, 'images', 'files', '$FILES_RULES' from unnest(array['$A','$B']::uuid[]) s;

insert into zsite.records (site_id, collection, id, owner_id, data) values
  ('$B', 'catalog',  'b1000000-0000-4000-8000-000000000001', null, '{"name":"B-sedan","price":50,"category":"cars","cost":30}'),
  ('$B', 'bookings', 'b2000000-0000-4000-8000-000000000001', '$B_U1', '{"name":"B guest","email":"g@b.test","date":"2026-10-10","notes":"b-private"}'),
  ('$B', 'secret_notes', 'b3000000-0000-4000-8000-000000000001', null, '{"text":"B secret"}');
SQL
B_CAT=b1000000-0000-4000-8000-000000000001
B_BK=b2000000-0000-4000-8000-000000000001
B_SECRET=b3000000-0000-4000-8000-000000000001

id_of() { echo "$1" | python3 -c 'import sys,json; print(json.loads(sys.stdin.read())["id"])' 2>/dev/null || echo "?"; }
A_CAT1=$(id_of "$(q authenticated "$adminA" "select api.create_record('catalog', '{\"name\":\"A-sedan\",\"price\":40,\"category\":\"cars\",\"cost\":20,\"seats\":5}')")")
A_CAT2=$(id_of "$(q authenticated "$adminA" "select api.create_record('catalog', '{\"name\":\"A-coupe\",\"price\":60,\"category\":\"cars\",\"cost\":35}')")")
A_CAT3=$(id_of "$(q authenticated "$adminA" "select api.create_record('catalog', '{\"name\":\"A-van\",\"price\":90,\"category\":\"vans\",\"cost\":70}')")")
U1_BK=$(id_of "$(q authenticated "$u1A" "select api.create_record('bookings', '{\"name\":\"U1\",\"email\":\"u1@a.test\",\"date\":\"2026-10-11\",\"notes\":\"u1 note\"}')")")
U1_BK2=$(id_of "$(q authenticated "$u1A" "select api.create_record('bookings', '{\"name\":\"U1 again\",\"email\":\"u1@a.test\",\"date\":\"2026-10-12\"}')")")
U2_BK=$(id_of "$(q authenticated "$u2A" "select api.create_record('bookings', '{\"name\":\"U2\",\"email\":\"u2@a.test\",\"date\":\"2026-10-13\"}')")")
say "seed: A catalog $A_CAT1 $A_CAT2 $A_CAT3; A bookings u1=$U1_BK,$U1_BK2 u2=$U2_BK"

storage_seed=$(q authenticated "$adminB" "insert into storage.objects (bucket_id, name, owner_id) values ('site-files', '$B/images/b.png', '$B_ADMIN'); select 'ok'")
check "seed: B admin uploads B/images/b.png" "$storage_seed" "ok"

LIST_NAMES="select string_agg(e->'data'->>'name', ',' order by e->'data'->>'name') from jsonb_array_elements"

say ""
say "== POSITIVE CASES =="
check "P1 anon lists A public catalog (A rows only)" \
  "$(q anon "$anonA" "$LIST_NAMES(api.list_records('catalog')->'items') e")" "A-coupe,A-sedan,A-van"
check "P1b anon catalog view hides admin-only field cost" \
  "$(q anon "$anonA" "select count(*) from jsonb_array_elements(api.list_records('catalog')->'items') e where e->'data' ? 'cost'")" "0"
check "P2 admin sees cost on catalog" \
  "$(q authenticated "$adminA" "select count(*) from jsonb_array_elements(api.list_records('catalog')->'items') e where e->'data' ? 'cost'")" "3"
check "P3 anon get catalog item" \
  "$(q anon "$anonA" "select api.get_record('catalog', '$A_CAT1')->'data'->>'name'")" "A-sedan"
ANON_BK=$(q anon "$anonA" "select api.create_record('bookings', '{\"name\":\"Walk-in\",\"email\":\"w@x.test\",\"date\":\"2026-10-20\"}', 'anon-booking-key-0001')")
ANON_BK_ID=$(id_of "$ANON_BK")
check "P4 anonymous booking create" "$(echo "$ANON_BK" | python3 -c 'import sys,json; print(json.load(sys.stdin)["replayed"])')" "False"
check "P4b anonymous booking has no owner (server-assigned)" \
  "$(su_q -c "select coalesce(owner_id::text,'null') from zsite.records where id = '$ANON_BK_ID'")" "null"
check "P4c idempotent replay returns the same id" \
  "$(q anon "$anonA" "select api.create_record('bookings', '{\"name\":\"Walk-in\",\"email\":\"w@x.test\",\"date\":\"2026-10-20\"}', 'anon-booking-key-0001')->>'id'")" "$ANON_BK_ID"
check_err "P4d same key, different payload -> conflict" \
  "$(q anon "$anonA" "select api.create_record('bookings', '{\"name\":\"Other\",\"email\":\"o@x.test\",\"date\":\"2026-10-21\"}', 'anon-booking-key-0001')")" "idempotency_conflict"
check_err "P4e anonymous create without idempotency key" \
  "$(q anon "$anonA" "select api.create_record('bookings', '{\"name\":\"W\",\"email\":\"w@x.test\",\"date\":\"2026-10-20\"}')")" "idempotency_key_required"
check "P4f anon cannot read the booking it created" \
  "$(q anon "$anonA" "select coalesce(api.get_record('bookings', '$ANON_BK_ID')::text, 'NULL')")" "NULL"
check "P5 admin sees all A bookings" \
  "$(q authenticated "$adminA" "select jsonb_array_length(api.list_records('bookings')->'items')")" "4"
check "P6 user sees only own bookings" \
  "$(q authenticated "$u1A" "$LIST_NAMES(api.list_records('bookings')->'items') e")" "U1,U1 again"
check "P6b every row in user list is mine" \
  "$(q authenticated "$u1A" "select bool_and((e->>'mine')::boolean) from jsonb_array_elements(api.list_records('bookings')->'items') e")" "t"
check "P7 user updates own booking notes" \
  "$(q authenticated "$u1A" "select api.update_record('bookings', '$U1_BK', '{\"notes\":\"changed\"}')->>'updated'")" "true"
check "P7b admin confirms booking (masked status field)" \
  "$(q authenticated "$adminA" "select api.update_record('bookings', '$U1_BK', '{\"status\":\"confirmed\"}')->>'updated'")" "true"
check "P7c user still owns it after admin edit" \
  "$(su_q -c "select owner_id from zsite.records where id = '$U1_BK'")" "$A_U1"
P1PAGE=$(q anon "$anonA" "select api.list_records('catalog', '{}', 2)")
CUR=$(echo "$P1PAGE" | python3 -c 'import sys,json; print(json.load(sys.stdin)["next_cursor"])')
check "P8 page 1 has 2 items + cursor" "$(echo "$P1PAGE" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d["items"]), d["next_cursor"] is not None)')" "2 True"
check "P8b page 2 has the last item, no cursor" \
  "$(q anon "$anonA" "select jsonb_array_length(r->'items') || ' ' || coalesce(r->>'next_cursor','none') from api.list_records('catalog', '{}', 2, '$CUR') r")" "1 none"
check "P9 equality filter on declared index" \
  "$(q anon "$anonA" "$LIST_NAMES(api.list_records('catalog', '{\"category\":\"vans\"}')->'items') e")" "A-van"
check "P10 limit is clamped (0 -> 1)" \
  "$(q anon "$anonA" "select jsonb_array_length(api.list_records('catalog', '{}', 0)->'items')")" "1"
check "P11 admin deletes a booking" \
  "$(q authenticated "$adminA" "select api.delete_record('bookings', '$ANON_BK_ID')->>'deleted'")" "true"

say ""
say "== F site-function callers (0080): fn:<name> matches only its own grants =="
su_q -c "insert into zsite.collections (site_id, name, rules, schema) values ('$A', 'orders', '{\"list\":[\"admin\",\"fn:stripe-hook\"],\"get\":[\"admin\",\"fn:stripe-hook\"],\"create\":[\"signed_in\",\"fn:stripe-hook\"],\"update\":[\"fn:stripe-hook\"],\"delete\":[\"admin\"]}', '{\"type\":\"object\",\"properties\":{\"total\":{\"type\":\"integer\"},\"paid\":{\"type\":\"boolean\"}}}')" >/dev/null
FN_SUB=f1000000-0000-4000-8000-000000000001
fnA="{\"role\":\"authenticated\",\"site_id\":\"$A\",\"sub\":\"$FN_SUB\",\"zfn\":\"stripe-hook\"}"
fnOtherA="{\"role\":\"authenticated\",\"site_id\":\"$A\",\"sub\":\"$FN_SUB\",\"zfn\":\"other\"}"
fnAdminA="{\"role\":\"authenticated\",\"site_id\":\"$A\",\"sub\":\"$FN_SUB\",\"zfn\":\"other\",\"zfn_admin\":true}"
fnAsAdminSub="{\"role\":\"authenticated\",\"site_id\":\"$A\",\"sub\":\"$A_ADMIN\",\"zfn\":\"other\"}"
fnOnB="{\"role\":\"authenticated\",\"site_id\":\"$B\",\"sub\":\"$FN_SUB\",\"zfn\":\"stripe-hook\"}"
FN_ORDER=$(id_of "$(q authenticated "$fnA" "select api.create_record('orders', '{\"total\":500}', 'fn-order-key-000001')")")
check "F1 fn:stripe-hook creates an order; it owns nothing" \
  "$(su_q -c "select coalesce(owner_id::text,'null') from zsite.records where id = '$FN_ORDER'")" "null"
check "F2 fn:stripe-hook lists orders" "$(q authenticated "$fnA" "select jsonb_array_length(api.list_records('orders')->'items')")" "1"
check "F3 fn:stripe-hook updates an order (update names it)" \
  "$(q authenticated "$fnA" "select api.update_record('orders', '$FN_ORDER', '{\"paid\":true}')->>'updated'")$(su_q -c "select data->>'paid' from zsite.records where id = '$FN_ORDER'")" "truetrue"
check "F4 another function sees no orders" "$(q authenticated "$fnOtherA" "select jsonb_array_length(coalesce(api.list_records('orders')->'items','[]'::jsonb))" | sed 's/^ERR:.*/0/')" "0"
check "F5 a function does NOT match anyone (public catalog closed to it)" \
  "$(q authenticated "$fnOtherA" "select jsonb_array_length(coalesce(api.list_records('catalog')->'items','[]'::jsonb))" | sed 's/^ERR:.*/0/')" "0"
check_err "F6 another function cannot update the order" \
  "$(q authenticated "$fnOtherA" "select api.update_record('orders', '$FN_ORDER', '{\"paid\":false}')")" "not_found"
check "F7 an asAdmin function matches admin" "$(q authenticated "$fnAdminA" "select jsonb_array_length(api.list_records('orders')->'items')")" "1"
check "F8 a function token is never a member, even with an admin's sub" \
  "$(q authenticated "$fnAsAdminSub" "select jsonb_array_length(coalesce(api.list_records('orders')->'items','[]'::jsonb))" | sed 's/^ERR:.*/0/')" "0"
check "F8b ...and cannot create where only signed_in members may (it is not signed_in)" \
  "$(q authenticated "$fnOtherA" "select api.create_record('orders', '{\"total\":1}', 'fn-order-key-000002')" | sed 's/^ERR:.*/denied/')" "denied"
check "F9 zfn under the anon DB role is not a function caller" \
  "$(q anon "{\"role\":\"anon\",\"site_id\":\"$A\",\"zfn\":\"stripe-hook\"}" "select jsonb_array_length(coalesce(api.list_records('orders')->'items','[]'::jsonb))" | sed 's/^ERR:.*/denied/')" "denied"
check "F10 a site-B function token sees nothing of site A" \
  "$(q authenticated "$fnOnB" "select jsonb_array_length(coalesce(api.list_records('orders')->'items','[]'::jsonb))" | sed 's/^ERR:.*/denied/')" "denied"
check_err "F11 malformed fn principals are refused by the contract" \
  "$(su_q -c "insert into zsite.collections (site_id, name, rules, schema) values ('$A', 'bad_fn', '{\"list\":[\"fn:Bad_Name\"]}', '{\"type\":\"object\",\"properties\":{}}')" 2>&1 | sed 's/^/ERR: /' | head -1)" "violates"

say "== M1 token for site A against site B's records =="
check "M1a A token never lists B catalog rows" \
  "$(q authenticated "$adminA" "select count(*) from jsonb_array_elements(api.list_records('catalog')->'items') e where e->'data'->>'name' like 'B-%'")" "0"
check "M1b A admin get B booking -> null" \
  "$(q authenticated "$adminA" "select coalesce(api.get_record('bookings', '$B_BK')::text, 'NULL')")" "NULL"
check_err "M1c A admin update B booking" \
  "$(q authenticated "$adminA" "select api.update_record('bookings', '$B_BK', '{\"notes\":\"pwned\"}')")" "not_found"
check_err "M1d A admin delete B booking" \
  "$(q authenticated "$adminA" "select api.delete_record('bookings', '$B_BK')")" "not_found"
check "M1e [via facade] A admin direct table read of B rows" \
  "$(q authenticated "$adminA" "select ztest.run(\$x\$select count(*) from zsite.records where site_id = '$B'\$x\$)")" "0"
check "M1f [via facade] A admin direct table update of B row" \
  "$(q authenticated "$adminA" "select ztest.run(\$x\$with u as (update zsite.records set data = data || '{\"notes\":\"pwned\"}' where id = '$B_BK' returning 1) select count(*) from u\$x\$)")" "0"
check "M1g [via facade] A admin direct table delete of B row" \
  "$(q authenticated "$adminA" "select ztest.run(\$x\$with d as (delete from zsite.records where id = '$B_BK' returning 1) select count(*) from d\$x\$)")" "0"
check "M1h B booking untouched" \
  "$(su_q -c "select data->>'notes' from zsite.records where id = '$B_BK'")" "b-private"

check_err "M1i end users hold no privilege on zsite.records (anon read)" \
  "$(q anon "$anonA" "select count(*) from zsite.records")" "permission denied for table records"
check_err "M1j ...nor authenticated read (no raw documents past list rule / read masks)" \
  "$(q authenticated "$adminA" "select data from zsite.records limit 1")" "permission denied for table records"
check_err "M1k ...nor authenticated insert (idempotency_hash cannot be forged)" \
  "$(q authenticated "$adminA" "insert into zsite.records (site_id, collection, id, data, idempotency_key, idempotency_hash) values ('$A', 'bookings', gen_random_uuid(), '{}', 'forged-hash-key-0001', 'x')")" "permission denied for table records"
check_err "M1l the PostgREST login role cannot switch into the facade role" \
  "$(q zsite_facade "$adminA" "select 1")" "permission denied to set role"
check "M1l2 facade holds no INSERT/UPDATE on idempotency_hash, owner_id, site_id (update)" \
  "$(su_q -c "select has_column_privilege('zsite_facade','zsite.records','idempotency_hash','INSERT') or has_column_privilege('zsite_facade','zsite.records','owner_id','INSERT') or has_column_privilege('zsite_facade','zsite.records','site_id','UPDATE') or has_column_privilege('zsite_facade','zsite.records','owner_id','UPDATE')")" "f"
q anon "$anonA" "select api.create_record('bookings', '{\"name\":\"H\",\"email\":\"h@x.test\",\"date\":\"2026-10-10\"}', 'hash-check-key-00001')" >/dev/null
check "M1m stored hash is server-computed" \
  "$(su_q -c "select idempotency_hash = encode(sha256(convert_to('anon:bookings:' || data::text, 'UTF8')), 'hex') from zsite.records where idempotency_key = 'hash-check-key-00001'")" "t"

say ""
say "== M2 forged site_id in the body =="
check_err "M2a site_id inside data is rejected" \
  "$(q anon "$anonA" "select api.create_record('bookings', '{\"site_id\":\"$B\",\"name\":\"x\",\"email\":\"x@x.test\",\"date\":\"2026-10-10\"}', 'forged-site-key-0001')")" "unknown field site_id"
check_err "M2b [via facade] anon direct insert with site_id = B" \
  "$(q anon "$anonA" "select ztest.run(\$x\$insert into zsite.records (site_id, collection, id, data) values ('$B', 'bookings', gen_random_uuid(), '{\"name\":\"x\",\"email\":\"x@x.test\",\"date\":\"2026-10-10\"}')\$x\$)")" "site_mismatch"
check_err "M2c [via facade] user direct insert with site_id = B" \
  "$(q authenticated "$u1A" "select ztest.run(\$x\$insert into zsite.records (site_id, collection, id, data) values ('$B', 'catalog', gen_random_uuid(), '{\"name\":\"x\",\"price\":1}')\$x\$)")" "site_mismatch"
check "M2d B row count unchanged" "$(su_q -c "select count(*) from zsite.records where site_id = '$B'")" "3"

say ""
say "== M3 anonymous update / delete =="
check_err "M3a anon update_record" \
  "$(q anon "$anonA" "select api.update_record('catalog', '$A_CAT1', '{\"price\":1}')")" "anonymous_write_forbidden"
check_err "M3b anon delete_record" \
  "$(q anon "$anonA" "select api.delete_record('catalog', '$A_CAT1')")" "anonymous_write_forbidden"
check_err "M3c anon direct table update" \
  "$(q anon "$anonA" "update zsite.records set data = '{}' where id = '$A_CAT1'")" "permission denied"
check_err "M3d anon direct table delete" \
  "$(q anon "$anonA" "delete from zsite.records where id = '$A_CAT1'")" "permission denied"
check_err "M3e platform cannot grant 'anyone' on update" \
  "$(q service_role '{}' "update zsite.collections set rules = rules || '{\"update\":[\"anyone\"]}' where site_id = '$A' and name = 'catalog'")" "collections_valid"
check_err "M3f anon DB role carrying an authenticated claim + admin sub" \
  "$(q anon "$adminA" "select api.update_record('catalog', '$A_CAT1', '{\"price\":1}')")" "anonymous_write_forbidden"

check "M3g [via facade] anon update matches no row even inside the facade" \
  "$(q anon "$anonA" "select ztest.run(\$x\$with u as (update zsite.records set data = data where id = '$A_CAT1' returning 1) select count(*) from u\$x\$)")" "0"
check "M3h [via facade] anon delete matches no row even inside the facade" \
  "$(q anon "$anonA" "select ztest.run(\$x\$with d as (delete from zsite.records where id = '$A_CAT1' returning 1) select count(*) from d\$x\$)")" "0"
say ""
say "== M4 non-owner editing an owner-only record =="
check_err "M4a u2 updates u1's booking" \
  "$(q authenticated "$u2A" "select api.update_record('bookings', '$U1_BK', '{\"notes\":\"u2 was here\"}')")" "not_found"
check "M4b u2 get u1's booking -> null" \
  "$(q authenticated "$u2A" "select coalesce(api.get_record('bookings', '$U1_BK')::text, 'NULL')")" "NULL"
check "M4c [via facade] u2 direct table update of u1's booking" \
  "$(q authenticated "$u2A" "select ztest.run(\$x\$with u as (update zsite.records set data = data || '{\"notes\":\"x\"}' where id = '$U1_BK' returning 1) select count(*) from u\$x\$)")" "0"
check_err "M4d u1 deletes own booking (delete is admin-only)" \
  "$(q authenticated "$u1A" "select api.delete_record('bookings', '$U1_BK')")" "not_found"
check "M4e u1 booking notes intact" "$(su_q -c "select data->>'notes' from zsite.records where id = '$U1_BK'")" "changed"

say ""
say "== M5 member of A acting as admin on B =="
AonB="{\"role\":\"authenticated\",\"site_id\":\"$B\",\"sub\":\"$A_ADMIN\",\"site_role\":\"admin\"}"
check "M5a A admin re-pointed at B lists no B bookings" \
  "$(q authenticated "$AonB" "select jsonb_array_length(api.list_records('bookings')->'items')")" "0"
check_err "M5b A admin re-pointed at B creates B catalog" \
  "$(q authenticated "$AonB" "select api.create_record('catalog', '{\"name\":\"B-hacked\",\"price\":1}', 'escalation-key-00001')")" "row-level security"
check_err "M5c A admin re-pointed at B updates B catalog" \
  "$(q authenticated "$AonB" "select api.update_record('catalog', '$B_CAT', '{\"price\":1}')")" "not_found"
U1forged="{\"role\":\"authenticated\",\"site_id\":\"$A\",\"sub\":\"$A_U1\",\"site_role\":\"admin\"}"
check "M5d A user with forged site_role=admin still sees only own bookings" \
  "$(q authenticated "$U1forged" "$LIST_NAMES(api.list_records('bookings')->'items') e")" "U1,U1 again"
check_err "M5e A user with forged site_role=admin creates catalog" \
  "$(q authenticated "$U1forged" "select api.create_record('catalog', '{\"name\":\"x\",\"price\":1}')")" "row-level security"
check_err "M5f an A account can never become a member of B" \
  "$(q service_role '{}' "insert into zsite.members (site_id, user_id, role) values ('$B', '$A_ADMIN', 'admin')")" "foreign key"

say ""
say "== M6 writing system fields / owner_id =="
check_err "M6a owner_id inside data" \
  "$(q authenticated "$u1A" "select api.create_record('bookings', '{\"owner_id\":\"$A_U2\",\"name\":\"x\",\"email\":\"x@x.test\",\"date\":\"2026-10-10\"}')")" "unknown field owner_id"
check_err "M6b direct insert with owner_id of another user" \
  "$(q authenticated "$u1A" "insert into zsite.records (site_id, collection, id, owner_id, data) values ('$A', 'bookings', gen_random_uuid(), '$A_U2', '{\"name\":\"x\",\"email\":\"x@x.test\",\"date\":\"2026-10-10\"}')")" "permission denied"
check_err "M6c direct update of owner_id" \
  "$(q authenticated "$u1A" "update zsite.records set owner_id = '$A_U2' where id = '$U1_BK'")" "permission denied"
check_err "M6d direct update of created_at" \
  "$(q authenticated "$adminA" "update zsite.records set created_at = '2000-01-01' where id = '$U1_BK'")" "permission denied"
check_err "M6e direct update of site_id" \
  "$(q authenticated "$adminA" "update zsite.records set site_id = '$B' where id = '$U1_BK'")" "permission denied"
check_err "M6f user sets admin-only status on own booking" \
  "$(q authenticated "$u1A" "select api.update_record('bookings', '$U1_BK2', '{\"status\":\"confirmed\"}')")" "field_not_writable: status"
check_err "M6g anon creates a booking with status preset" \
  "$(q anon "$anonA" "select api.create_record('bookings', '{\"name\":\"x\",\"email\":\"x@x.test\",\"date\":\"2026-10-10\",\"status\":\"confirmed\"}', 'status-preset-key-01')")" "field_not_writable: status"
check_err "M6h idempotency hash column is not writable" \
  "$(q authenticated "$adminA" "update zsite.records set idempotency_hash = 'x' where id = '$U1_BK'")" "permission denied"

say ""
say "== M8 guessed collection name from another site =="
check_err "M8a A lists B-only collection" \
  "$(q anon "$anonA" "select api.list_records('secret_notes')")" "unknown_collection"
check "M8b A get B secret by id -> null" \
  "$(q anon "$anonA" "select coalesce(api.get_record('secret_notes', '$B_SECRET')::text, 'NULL')")" "NULL"
check_err "M8c A creates into B-only collection" \
  "$(q authenticated "$adminA" "select api.create_record('secret_notes', '{\"text\":\"x\"}')")" "unknown_collection"
check "M8d [via facade] A direct select of the B collection" \
  "$(q anon "$anonA" "select ztest.run(\$x\$select count(*) from zsite.records where collection = 'secret_notes'\$x\$)")" "0"
check "M8e A cannot see B's collection definitions" \
  "$(q anon "$anonA" "select count(*) from zsite.collections where site_id = '$B'")" "0"

say ""
say "== M9 no / bad site claim =="
check_err "M9a list without a site claim" \
  "$(q anon '{"role":"anon"}' "select api.list_records('catalog')")" "no_site"
check "M9b [via facade] direct read without a site claim" \
  "$(q anon '{"role":"anon"}' "select ztest.run(\$x\$select count(*) from zsite.records\$x\$)")" "0"
check_err "M9c site from a spoofed header is ignored" \
  "$(q anon '{"role":"anon"}' "set local \"request.headers\" = '{\"x-zavi-site\":\"$A\",\"host\":\"a.example\"}'; select api.list_records('catalog')")" "no_site"
check_err "M9d empty claims" "$(q anon '' "select api.list_records('catalog')")" "no_site"
check_err "M9e non-uuid site claim" \
  "$(q anon '{"role":"anon","site_id":"aaaaaaaa-0000-4000-8000-00000000000a OR 1=1"}' "select api.list_records('catalog')")" "no_site"
check_err "M9f suspended site" \
  "$(q anon "$anonS" "select api.list_records('catalog')")" "no_site"
check_err "M9g claim role other than anon/authenticated" \
  "$(q anon "$svcClaimA" "select api.list_records('catalog')")" "no_site"
check_err "M9h malformed claims JSON" "$(q anon '{not json' "select api.list_records('catalog')")" "ERR"
check "M9i members table invisible to anon" \
  "$(q anon "$anonA" "select count(*) from zsite.members")" "0"
check "M9j user sees only its own member row" \
  "$(q authenticated "$u1A" "select count(*) from zsite.members")" "1"
check_err "M9k identities are not readable by end users" \
  "$(q authenticated "$adminA" "select email_norm from zsite.identities")" "permission denied"
check_err "M9l quotas/usage are not readable by end users" \
  "$(q authenticated "$adminA" "select count(*) from zsite.usage")" "permission denied"
check_err "M9m end users cannot reset usage counters" \
  "$(q authenticated "$adminA" "update zsite.usage set records = 0")" "permission denied"

say ""
say "== M10 SQL injection via filter / cursor / names =="
check "M10a quote injection in filter value" \
  "$(q anon "$anonA" "select jsonb_array_length(api.list_records('catalog', '{\"category\":\"cars'' or ''1''=''1\"}')->'items')")" "0"
check_err "M10b injection in filter key" \
  "$(q anon "$anonA" "select api.list_records('catalog', '{\"category; drop table zsite.records; --\":\"x\"}')")" "filter_not_allowed"
check_err "M10c injection in cursor" \
  "$(q anon "$anonA" "select api.list_records('catalog', '{}', 10, '1:x''; drop table zsite.records; --')")" "invalid_cursor"
check_err "M10d injection in collection name" \
  "$(q anon "$anonA" "select api.list_records('catalog'' or ''1''=''1')")" "unknown_collection"
check_err "M10e filter on an undeclared field" \
  "$(q anon "$anonA" "select api.list_records('catalog', '{\"price\":40}')")" "filter_not_allowed"
check_err "M10f operator object as filter value" \
  "$(q anon "$anonA" "select api.list_records('catalog', '{\"category\":{\"\$ne\":null}}')")" "filter_not_allowed"
check_err "M10i filter on a field the caller cannot read (value oracle)" \
  "$(q anon "$anonA" "select api.list_records('catalog', '{\"cost\":20}')")" "filter_not_allowed"
check "M10j admin may filter on the masked field" \
  "$(q authenticated "$adminA" "$LIST_NAMES(api.list_records('catalog', '{\"cost\":20}')->'items') e")" "A-sedan"
check "M10g records table still intact" "$(su_q -c "select count(*) > 0 from zsite.records")" "t"
check "M10h huge limit is clamped to 100" \
  "$(q anon "$anonA" "select jsonb_array_length(api.list_records('catalog', '{}', 1000000)->'items') <= 100")" "t"

say ""
say "== M11 JSON schema bypass =="
check_err "M11a number sent as string" \
  "$(q authenticated "$adminA" "select api.create_record('catalog', '{\"name\":\"x\",\"price\":\"10\"}')")" "price must be a number"
check_err "M11b missing required field" \
  "$(q anon "$anonA" "select api.create_record('bookings', '{\"name\":\"x\",\"date\":\"2026-10-10\"}', 'schema-required-key1')")" "email is required"
check_err "M11c maxLength exceeded" \
  "$(q anon "$anonA" "select api.create_record('bookings', jsonb_build_object('name', repeat('x', 81), 'email', 'x@x.test', 'date', '2026-10-10'), 'schema-maxlen-key-01')")" "name is longer"
check_err "M11d enum violated" \
  "$(q authenticated "$adminA" "select api.create_record('catalog', '{\"name\":\"x\",\"price\":1,\"category\":\"trucks\"}')")" "not an allowed value"
check_err "M11e unknown extra field" \
  "$(q anon "$anonA" "select api.create_record('bookings', '{\"name\":\"x\",\"email\":\"x@x.test\",\"date\":\"2026-10-10\",\"is_admin\":true}', 'schema-extra-key-001')")" "unknown field is_admin"
check_err "M11f object smuggled into a string field" \
  "$(q anon "$anonA" "select api.create_record('bookings', '{\"name\":{\"\$gt\":\"\"},\"email\":\"x@x.test\",\"date\":\"2026-10-10\"}', 'schema-object-key-01')")" "name must be a string"
check_err "M11g bad email format" \
  "$(q anon "$anonA" "select api.create_record('bookings', '{\"name\":\"x\",\"email\":\"not-an-email\",\"date\":\"2026-10-10\"}', 'schema-email-key-001')")" "not an email"
check_err "M11h [via facade] direct table insert bypassing the RPC" \
  "$(q anon "$anonA" "select ztest.run(\$x\$insert into zsite.records (site_id, collection, id, data) values ('$A', 'bookings', gen_random_uuid(), '{\"name\":1}')\$x\$)")" "schema_violation"
check_err "M11i update that removes a required field" \
  "$(q authenticated "$u1A" "select api.update_record('bookings', '$U1_BK2', '{\"email\":null}')")" "email is required"
check_err "M11j [via facade] admin direct table update with invalid data" \
  "$(q authenticated "$adminA" "select ztest.run(\$x\$update zsite.records set data = '{\"name\":\"x\",\"price\":-5}' where id = '$A_CAT1'\$x\$)")" "below the minimum"
check_err "M11k document is not an object" \
  "$(q authenticated "$adminA" "select api.create_record('catalog', '[1,2]')")" "document must be an object"
check_err "M11l integer field given a fraction" \
  "$(q authenticated "$adminA" "select api.create_record('catalog', '{\"name\":\"x\",\"price\":1,\"seats\":2.5}')")" "seats must be an integer"
check_err "M11m array item too long" \
  "$(q authenticated "$adminA" "select api.create_record('catalog', jsonb_build_object('name','x','price',1,'tags', jsonb_build_array(repeat('t', 21))))")" "tags[] is longer"
check_err "M11q impossible calendar date" \
  "$(q anon "$anonA" "select api.create_record('bookings', '{\"name\":\"x\",\"email\":\"x@x.test\",\"date\":\"2026-02-30\"}', 'schema-baddate-key01')")" "is not a date"
check_err "M11n platform insert is validated too" \
  "$(q service_role '{}' "insert into zsite.records (site_id, collection, id, data) values ('$A', 'catalog', gen_random_uuid(), '{\"name\":\"x\"}')")" "price is required"
check_err "M11p record over max_record_bytes (byte quota)" \
  "$(q service_role '{}' "update zsite.quotas set max_record_bytes = 100 where site_id = '$A'; set local role anon; set local \"request.jwt.claims\" = '$anonA'; select api.create_record('bookings', jsonb_build_object('name', repeat('y', 80), 'email','x@x.test','date','2026-10-10'), 'byte-cap-key-0000001')")" "quota_exceeded"

say ""
say "== STORAGE (mimic of storage.objects; not the real Storage service) =="
check_err "S1 anon uploads into admin-only area" \
  "$(q anon "$anonA" "insert into storage.objects (bucket_id, name) values ('site-files', '$A/images/a.png')")" "row-level security"
check "S2 A admin uploads to A" \
  "$(q authenticated "$adminA" "insert into storage.objects (bucket_id, name, owner_id) values ('site-files', '$A/images/a.png', '$A_ADMIN'); select 'ok'")" "ok"
check_err "S3 A admin uploads under B's prefix" \
  "$(q authenticated "$adminA" "insert into storage.objects (bucket_id, name, owner_id) values ('site-files', '$B/images/x.png', '$A_ADMIN')")" "row-level security"
check_err "S4a path traversal A/../B" \
  "$(q authenticated "$adminA" "insert into storage.objects (bucket_id, name, owner_id) values ('site-files', '$A/../$B/images/x.png', '$A_ADMIN')")" "row-level security"
check_err "S4b dot-dot file name" \
  "$(q authenticated "$adminA" "insert into storage.objects (bucket_id, name, owner_id) values ('site-files', '$A/images/..', '$A_ADMIN')")" "row-level security"
check_err "S4c extra path depth" \
  "$(q authenticated "$adminA" "insert into storage.objects (bucket_id, name, owner_id) values ('site-files', '$A/images/sub/x.png', '$A_ADMIN')")" "row-level security"
check_err "S4d undeclared area" \
  "$(q authenticated "$adminA" "insert into storage.objects (bucket_id, name, owner_id) values ('site-files', '$A/secrets/x.png', '$A_ADMIN')")" "row-level security"
check_err "S5 forged owner_id on upload" \
  "$(q authenticated "$adminA" "insert into storage.objects (bucket_id, name, owner_id) values ('site-files', '$A/images/f.png', '$A_U1')")" "row-level security"
check "S6 anon reads A public file" \
  "$(q anon "$anonA" "select count(*) from storage.objects where name = '$A/images/a.png'")" "1"
check "S7 A token cannot see B's file" \
  "$(q anon "$anonA" "select count(*) from storage.objects where name like '$B/%'")" "0"
check "S8 anon delete does nothing" \
  "$(q anon "$anonA" "with d as (delete from storage.objects where name = '$A/images/a.png' returning 1) select count(*) from d")" "0"
check "S9 non-admin user delete does nothing" \
  "$(q authenticated "$u1A" "with d as (delete from storage.objects where name = '$A/images/a.png' returning 1) select count(*) from d")" "0"
check "S10 A admin cannot delete B's file" \
  "$(q authenticated "$adminA" "with d as (delete from storage.objects where name like '$B/%' returning 1) select count(*) from d")" "0"
check_err "S11 A admin cannot rename its file into B" \
  "$(q authenticated "$adminA" "update storage.objects set name = '$B/images/moved.png' where name = '$A/images/a.png'")" "row-level security"
check "S11b A admin may rename within A (positive)" \
  "$(q authenticated "$adminA" "with u as (update storage.objects set name = '$A/images/a2.png' where name = '$A/images/a.png' returning 1) select count(*) from u")" "1"
q service_role '{}' "update zsite.collections set rules = '{\"list\":[\"anyone\"],\"get\":[\"anyone\"],\"create\":[\"anyone\"],\"update\":[\"admin\"],\"delete\":[\"admin\"]}' where site_id = '$A' and name = 'images'" >/dev/null
check "S11c anon upload into an anyone-create area" \
  "$(q anon "$anonA" "insert into storage.objects (bucket_id, name) values ('site-files', '$A/images/anon.png'); select 'ok'")" "ok"
check "S11d admin moderates (renames) the anonymous upload" \
  "$(q authenticated "$adminA" "with u as (update storage.objects set name = '$A/images/anon-ok.png' where name = '$A/images/anon.png' returning 1) select count(*) from u")" "1"
check "S11e anon update matches no row (no anon update policy)" \
  "$(q anon "$anonA" "with u as (update storage.objects set name = '$A/images/x.png' where name = '$A/images/anon-ok.png' returning 1) select count(*) from u")" "0"
check "S11f ...nothing renamed by anon" "$(su_q -c "select count(*) from storage.objects where name = '$A/images/anon-ok.png'")" "1"
check_err "S13 files area with list != get is rejected" \
  "$(q service_role '{}' "update zsite.collections set rules = '{\"list\":[],\"get\":[\"anyone\"]}' where site_id = '$A' and name = 'images'")" "collections_valid"
check "S12 B file intact" "$(su_q -c "select count(*) from storage.objects where name like '$B/%'")" "1"

say ""
say "== M7 quota under truly concurrent sessions =="
N=25
"${PSQL[@]}" -U postgres -c "select pg_advisory_lock(4242), pg_sleep(4)" >/dev/null &
HOLDER=$!
sleep 0.5
for i in $(seq 1 $N); do
  key=$(printf 'concurrent-key-%05d' "$i")
  ( q anon "$anonC" "select pg_advisory_lock_shared(4242); select api.create_record('bookings', jsonb_build_object('name','c$i','email','c@x.test','date','2026-10-10'), '$key')" \
      > "$DIR/c$i.out" ) &
done
MAXW=0
for _ in $(seq 1 30); do
  w=$(su_q -c "select count(*) from pg_locks where locktype = 'advisory' and objid = 4242 and not granted")
  [ "$w" -gt "$MAXW" ] && MAXW=$w
  sleep 0.1
done
wait
OKS=$(cat "$DIR"/c*.out | grep -c '"replayed": false' || true)
QX=$(cat "$DIR"/c*.out | grep -c 'quota_exceeded' || true)
say "      workers queued at the barrier: $MAXW of $N"
check "M7a all $N workers were blocked together before the race" "$MAXW" "$N"
check "M7b exactly max_records (10) creates succeed" "$OKS" "10"
check "M7c the other 15 get quota_exceeded" "$QX" "15"
check "M7d rows on site C" "$(su_q -c "select count(*) from zsite.records where site_id = '$C'")" "10"
check "M7e usage counter matches rows" "$(su_q -c "select records from zsite.usage where site_id = '$C'")" "10"

"${PSQL[@]}" -U postgres -c "select pg_advisory_lock(4343), pg_sleep(3)" >/dev/null &
sleep 0.5
for i in $(seq 1 12); do
  key=$(printf 'rate-key-%011d' "$i")
  ( q anon "$anonD" "select pg_advisory_lock_shared(4343); select api.create_record('bookings', jsonb_build_object('name','d$i','email','d@x.test','date','2026-10-10'), '$key')" \
      > "$DIR/d$i.out" ) &
done
wait
DOK=$(cat "$DIR"/d*.out | grep -c '"replayed": false' || true)
check "M7f writes/min cap (5) holds under 12 concurrent writers" "$DOK" "5"

"${PSQL[@]}" -U postgres -c "select pg_advisory_lock(4444), pg_sleep(3)" >/dev/null &
sleep 0.5
for i in $(seq 1 10); do
  ( q anon "$anonA" "select pg_advisory_lock_shared(4444); select api.create_record('bookings', '{\"name\":\"Same\",\"email\":\"s@x.test\",\"date\":\"2026-10-22\"}', 'same-key-concurrent-01')->>'id'" \
      > "$DIR/i$i.out" ) &
done
wait
check "M7g concurrent same-key creates -> one row" \
  "$(su_q -c "select count(*) from zsite.records where idempotency_key = 'same-key-concurrent-01'")" "1"
check "M7h ...and all 10 callers got the same id" "$(cat "$DIR"/i*.out | grep -v '^$' | sort -u | wc -l | tr -d ' ')" "1"

check "M7i usage counters equal real rows on every site" \
  "$(su_q -c "select count(*) from zsite.usage u where u.records <> (select count(*) from zsite.records r where r.site_id = u.site_id)")" "0"

say ""
say "== keyset pagination over rows sharing one created_at =="
su_q -c "set role service_role; insert into zsite.records (site_id, collection, id, data) select '$B', 'catalog', gen_random_uuid(), jsonb_build_object('name', 'B-bulk-' || g, 'price', g) from generate_series(1, 120) g" >/dev/null
anonB="{\"role\":\"anon\",\"site_id\":\"$B\"}"
SEEN="$DIR/seen.txt"; : > "$SEEN"; CUR=""; PAGES=0
while :; do
  if [ -z "$CUR" ]; then PAGE=$(q anon "$anonB" "select api.list_records('catalog', '{}', 50)")
  else PAGE=$(q anon "$anonB" "select api.list_records('catalog', '{}', 50, '$CUR')"); fi
  echo "$PAGE" | python3 -c 'import sys,json; [print(i["id"]) for i in json.load(sys.stdin)["items"]]' >> "$SEEN"
  CUR=$(echo "$PAGE" | python3 -c 'import sys,json; c=json.load(sys.stdin)["next_cursor"]; print(c or "")')
  PAGES=$((PAGES+1)); [ -z "$CUR" ] || [ $PAGES -gt 10 ] && break
done
check "K1 3 pages cover all 121 B catalog rows exactly once" \
  "$PAGES $(wc -l < "$SEEN" | tr -d ' ') $(sort -u "$SEEN" | wc -l | tr -d ' ')" "3 121 121"

say ""
say "== 0004: legacy index shape converted =="
check "L1 0001-shape indexes converted to the typed manifest" \
  "$(su_q -c "select indexes::text || ' ' || index_slots::text from zsite.collections where site_id = '$L' and name = 'legacy'")" \
  '{"n": {"ops": ["eq"], "sort": false, "type": "number"}, "category": {"ops": ["eq"], "sort": false, "type": "text"}} {"n": "n1", "category": "t1"}'
check "L2 existing record re-materialized into typed slots" \
  "$(su_q -c "select t1 || ' ' || n1 from zsite.records where site_id = '$L' and collection = 'legacy'")" "cars 7"
check "L4 legacy pending-with-auth-user identity became 'unverified' (grants nothing), with a notice" \
  "$(su_q -c "select (select state from zsite.identities where email_norm = 'old@l.test') || ' ' || (select count(*) from zsite.migration_notices where action = 'pending_with_auth_user_to_unverified')")" "unverified 1"
check "L5 legacy indexed string whose values fit: maxLength narrowed to 512, indexed, noticed" \
  "$(su_q -c "select (schema->'properties'->'slug'->>'maxLength') || ' ' || (index_slots->>'slug') || ' ' || (select count(*) from zsite.migration_notices n where n.collection = 'legacy_fits' and n.action = 'indexed_string_maxlength_narrowed') from zsite.collections where name = 'legacy_fits'")" "512 t1 1"
check "L6 legacy indexed string with a 600-char value: index dropped, noticed, data intact" \
  "$(su_q -c "select indexes::text || ' ' || (select count(*) from zsite.migration_notices n where n.collection = 'legacy_long' and n.action = 'index_dropped_value_too_long_for_text_slot') || ' ' || (select length(data->>'slug') from zsite.records where collection = 'legacy_long') from zsite.collections where name = 'legacy_long'")" "{} 1 600"
check "L3 0001 slot columns are gone" \
  "$(su_q -c "select count(*) from information_schema.columns where table_schema = 'zsite' and table_name = 'records' and column_name like 'idx_s%'")" "0"

say ""
say "== 0004: membership row is authoritative (same token) =="
ALL_A=$(q authenticated "$adminA" "select jsonb_array_length(api.list_records('bookings')->'items')")
su_q -c "update zsite.members set role = 'admin' where site_id = '$A' and user_id = '$A_U1'" >/dev/null
check "R1 promoted user (token still says site_role=user) sees all bookings at once" \
  "$(q authenticated "$u1A" "select jsonb_array_length(api.list_records('bookings')->'items')")" "$ALL_A"
check "R1b ...and may write admin-only fields" \
  "$(q authenticated "$u1A" "select api.update_record('bookings', '$U1_BK2', '{\"status\":\"confirmed\"}')->>'updated'")" "true"
su_q -c "update zsite.members set role = 'user' where site_id = '$A' and user_id = '$A_U1'" >/dev/null
check "R2 demoted again: own bookings only" \
  "$(q authenticated "$u1A" "$LIST_NAMES(api.list_records('bookings')->'items') e")" "U1,U1 again"
su_q -c "update zsite.members set role = 'user' where site_id = '$A' and user_id = '$A_ADMIN'" >/dev/null
check "R3 demoted admin (token still says site_role=admin) loses admin at once" \
  "$(q authenticated "$adminA" "select jsonb_array_length(api.list_records('bookings')->'items')")" "0"
check_err "R3b ...cannot create catalog items" \
  "$(q authenticated "$adminA" "select api.create_record('catalog', '{\"name\":\"x\",\"price\":1}')")" "row-level security"
su_q -c "update zsite.members set role = 'admin' where site_id = '$A' and user_id = '$A_ADMIN'" >/dev/null
check "R4 re-promoted admin works again with the same token" \
  "$(q authenticated "$adminA" "select jsonb_array_length(api.list_records('bookings')->'items')")" "$ALL_A"
su_q -c "update zsite.members set status = 'disabled' where site_id = '$A' and user_id = '$A_U1'" >/dev/null
check "R5 disabled member: nothing of its own" \
  "$(q authenticated "$u1A" "select jsonb_array_length(api.list_records('bookings')->'items')")" "0"
su_q -c "update zsite.members set status = 'active' where site_id = '$A' and user_id = '$A_U1'" >/dev/null

say ""
say "== 0004: pending identity reservations =="
check "I1 pending reservation without an auth user" \
  "$(q service_role '{}' "insert into zsite.identities (site_id, email_norm, alias, state) values ('$A', 'new@a.test', 'h9@u.zavisite.invalid', 'pending'); select 'ok'")" "ok"
check_err "I2 duplicate reservation for the same (site, email)" \
  "$(q service_role '{}' "insert into zsite.identities (site_id, email_norm, alias, state) values ('$A', 'new@a.test', 'h10@u.zavisite.invalid', 'pending')")" "duplicate key"
check_err "I3 pending row cannot carry an auth user" \
  "$(q service_role '{}' "insert into zsite.identities (site_id, email_norm, auth_user_id, alias, state) values ('$A', 'p2@a.test', gen_random_uuid(), 'h11@u.zavisite.invalid', 'pending')")" "identities_pending_no_user"
check_err "I4 active row must carry an auth user" \
  "$(q service_role '{}' "insert into zsite.identities (site_id, email_norm, alias, state) values ('$A', 'p3@a.test', 'h12@u.zavisite.invalid', 'active')")" "identities_pending_no_user"
check "I5 same email may be reserved on another site" \
  "$(q service_role '{}' "insert into zsite.identities (site_id, email_norm, alias, state) values ('$B', 'new@a.test', 'h13@u.zavisite.invalid', 'pending'); select 'ok'")" "ok"
su_q -c "update zsite.identities set state = 'deleting' where site_id = '$A' and auth_user_id = '$A_U2'" >/dev/null
check "I6 identity being deleted grants nothing (own list empty)" \
  "$(q authenticated "$u2A" "select jsonb_array_length(api.list_records('bookings')->'items')")" "0"
check "I6b ...nor get of its own booking" \
  "$(q authenticated "$u2A" "select coalesce(api.get_record('bookings', '$U2_BK')::text, 'NULL')")" "NULL"
su_q -c "update zsite.identities set state = 'active' where site_id = '$A' and auth_user_id = '$A_U2'" >/dev/null
check "I7 end users cannot read emails from identities" \
  "$(q authenticated "$u2A" "select email_norm from zsite.identities limit 1")" "ERR: permission denied for table identities"

say ""
say "== 0004: typed index slots =="
EV_SCHEMA='{"type":"object","required":["title"],"properties":{
  "title":{"type":"string","maxLength":100},
  "price":{"type":"number"},
  "city":{"type":"string","maxLength":50},
  "starts_at":{"type":"string","maxLength":40,"format":"date-time"},
  "day":{"type":"string","maxLength":10,"format":"date"}}}'
EV_IDX='{"city":{"type":"text","ops":["eq","in","prefix"],"sort":true},
  "price":{"type":"number","ops":["eq","in","range"],"sort":true},
  "starts_at":{"type":"timestamp","ops":["range"],"sort":true},
  "day":{"type":"timestamp","ops":["eq","range"]}}'
su_q <<SQL >/dev/null
set role service_role;
insert into zsite.collections (site_id, name, rules, schema, indexes) values ('$A', 'events',
  '{"list":["anyone"],"get":["anyone"],"create":["admin"],"update":["admin"],"delete":["admin"]}', '$EV_SCHEMA', '$EV_IDX');
insert into zsite.records (site_id, collection, id, data)
select '$A', 'events', gen_random_uuid(), jsonb_build_object('title', 'e' || g, 'price', g,
  'city', (array['Austin','Boston','Berlin'])[g % 3 + 1],
  'starts_at', '2026-11-' || lpad(g::text, 2, '0') || 'T10:00:00Z',
  'day', '2026-11-' || lpad(g::text, 2, '0'))
from generate_series(1, 30) g;
SQL
EVCOUNT="select jsonb_array_length(api.list_records('events', p_limit => 100, p_filter => "
check "T1 range filter price >= 10 and < 20" \
  "$(q anon "$anonA" "${EVCOUNT}'{\"price\":{\"gte\":10,\"lt\":20}}')->'items')")" "10"
check "T2 sort price asc: first is e1" \
  "$(q anon "$anonA" "select api.list_records('events', p_sort => 'price', p_limit => 1)->'items'->0->'data'->>'title'")" "e1"
check "T2b sort price desc: first is e30" \
  "$(q anon "$anonA" "select api.list_records('events', p_sort => '-price', p_limit => 1)->'items'->0->'data'->>'title'")" "e30"
SEEN="$DIR/sorted.txt"; : > "$SEEN"; CUR=""; PAGES=0
while :; do
  if [ -z "$CUR" ]; then PAGE=$(q anon "$anonA" "select api.list_records('events', p_sort => '-price', p_limit => 7)")
  else PAGE=$(q anon "$anonA" "select api.list_records('events', p_sort => '-price', p_limit => 7, p_cursor => '$CUR')"); fi
  echo "$PAGE" | python3 -c 'import sys,json; [print(i["data"]["price"]) for i in json.load(sys.stdin)["items"]]' >> "$SEEN"
  CUR=$(echo "$PAGE" | python3 -c 'import sys,json; c=json.load(sys.stdin)["next_cursor"]; print(c or "")')
  PAGES=$((PAGES+1)); [ -z "$CUR" ] || [ $PAGES -gt 10 ] && break
done
check "T3 sorted keyset pages: 5 pages, prices 30..1 in order, each once" \
  "$PAGES $(paste -sd, "$SEEN")" "5 $(seq 30 -1 1 | paste -sd, -)"
check "T4 timestamp range on starts_at" \
  "$(q anon "$anonA" "${EVCOUNT}'{\"starts_at\":{\"gte\":\"2026-11-05T00:00:00Z\",\"lt\":\"2026-11-08T00:00:00+00:00\"}}')->'items')")" "3"
check "T5 text prefix" \
  "$(q anon "$anonA" "select ${EVCOUNT#select }'{\"city\":{\"prefix\":\"B\"}}')->'items') || ',' || jsonb_array_length(api.list_records('events', p_limit => 100, p_filter => '{\"city\":{\"prefix\":\"Bo\"}}')->'items')")" "20,10"
check "T6 in-list" \
  "$(q anon "$anonA" "${EVCOUNT}'{\"city\":{\"in\":[\"Austin\",\"Berlin\"]}}')->'items')")" "20"
check "T7 date equality (midnight UTC)" \
  "$(q anon "$anonA" "${EVCOUNT}'{\"day\":\"2026-11-03\"}')->'items')")" "1"
check "T7b combined filters" \
  "$(q anon "$anonA" "${EVCOUNT}'{\"city\":\"Boston\",\"price\":{\"gt\":15}}')->'items')")" "5"
check_err "T8 undeclared op: prefix on a number" \
  "$(q anon "$anonA" "select api.list_records('events', '{\"price\":{\"prefix\":\"1\"}}')")" "filter_not_allowed"
check_err "T8b undeclared op: range on a text field declared eq/in/prefix" \
  "$(q anon "$anonA" "select api.list_records('events', '{\"city\":{\"gt\":\"A\"}}')")" "filter_not_allowed"
check_err "T8c undeclared op: eq on starts_at (range only)" \
  "$(q anon "$anonA" "select api.list_records('events', '{\"starts_at\":\"2026-11-05T10:00:00Z\"}')")" "filter_not_allowed"
check_err "T8d wrong value type (string for number)" \
  "$(q anon "$anonA" "select api.list_records('events', '{\"price\":\"10\"}')")" "invalid_filter"
check_err "T8e impossible date in a filter" \
  "$(q anon "$anonA" "select api.list_records('events', '{\"day\":\"2026-02-30\"}')")" "invalid_filter"
check_err "T8f in-list over 50 values" \
  "$(q anon "$anonA" "select api.list_records('events', jsonb_build_object('city', jsonb_build_object('in', (select jsonb_agg(g::text) from generate_series(1, 51) g))))")" "invalid_filter"
check_err "T9 sort on a field declared sort:false" \
  "$(q anon "$anonA" "select api.list_records('events', p_sort => 'day')")" "sort_not_allowed"
check_err "T9b sort on an undeclared field" \
  "$(q anon "$anonA" "select api.list_records('events', p_sort => 'title')")" "sort_not_allowed"
check_err "T10 filter on an undeclared field" \
  "$(q anon "$anonA" "select api.list_records('events', '{\"title\":\"e1\"}')")" "filter_not_allowed"
check_err "T11 budget overflow: 4 text indexes" \
  "$(q service_role '{}' "insert into zsite.collections (site_id, name, schema, indexes) values ('$A', 'overflow', '{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\",\"maxLength\":9},\"b\":{\"type\":\"string\",\"maxLength\":9},\"c\":{\"type\":\"string\",\"maxLength\":9},\"d\":{\"type\":\"string\",\"maxLength\":9}}}', '{\"a\":{\"type\":\"text\",\"ops\":[\"eq\"]},\"b\":{\"type\":\"text\",\"ops\":[\"eq\"]},\"c\":{\"type\":\"text\",\"ops\":[\"eq\"]},\"d\":{\"type\":\"text\",\"ops\":[\"eq\"]}}')")" "violates check constraint \"collections_"
check_err "T11b budget overflow: 3 number indexes" \
  "$(q service_role '{}' "insert into zsite.collections (site_id, name, schema, indexes) values ('$A', 'overflow', '{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"number\"},\"b\":{\"type\":\"number\"},\"c\":{\"type\":\"integer\"}}}', '{\"a\":{\"type\":\"number\",\"ops\":[\"eq\"]},\"b\":{\"type\":\"number\",\"ops\":[\"eq\"]},\"c\":{\"type\":\"number\",\"ops\":[\"eq\"]}}')")" "violates check constraint \"collections_"
check_err "T12 text index on an unbounded-ish string (maxLength 10000)" \
  "$(q service_role '{}' "insert into zsite.collections (site_id, name, schema, indexes) values ('$A', 'bigtext', '{\"type\":\"object\",\"properties\":{\"a\":{\"type\":\"string\",\"maxLength\":10000}}}', '{\"a\":{\"type\":\"text\",\"ops\":[\"eq\"]}}')")" "collections_valid"
check_err "T13 number index on a string field" \
  "$(q service_role '{}' "update zsite.collections set indexes = indexes || '{\"title\":{\"type\":\"number\",\"ops\":[\"eq\"]}}' where site_id = '$A' and name = 'events'")" "collections_valid"
check_err "T14 prefix declared on a number" \
  "$(q service_role '{}' "update zsite.collections set indexes = jsonb_set(indexes, '{price,ops}', '[\"prefix\"]') where site_id = '$A' and name = 'events'")" "collections_valid"
check_err "T14b unknown op" \
  "$(q service_role '{}' "update zsite.collections set indexes = jsonb_set(indexes, '{price,ops}', '[\"like\"]') where site_id = '$A' and name = 'events'")" "collections_valid"
CITY_SLOT=$(su_q -c "select index_slots->>'city' from zsite.collections where site_id = '$A' and name = 'events'")
q service_role '{}' "update zsite.collections set indexes = indexes || '{\"title\":{\"type\":\"text\",\"ops\":[\"eq\"]}}' where site_id = '$A' and name = 'events'" >/dev/null
check_err "T15 after an index change, filters wait for the reindex" \
  "$(q anon "$anonA" "${EVCOUNT}'{\"title\":\"e5\"}')->'items')")" "index_building"
check "T15a ...newest-first listing still works meanwhile" \
  "$(q anon "$anonA" "select jsonb_array_length(api.list_records('events', p_limit => 100)->'items')")" "30"
reindex "$A" events 7 >/dev/null
check "T15d after zsite.reindex_collection the new filter works" \
  "$(q anon "$anonA" "${EVCOUNT}'{\"title\":\"e5\"}')->'items')")" "1"
check "T15b existing slot assignment is stable" \
  "$(su_q -c "select index_slots->>'city' from zsite.collections where site_id = '$A' and name = 'events'")" "$CITY_SLOT"
check "T15c re-materialization is not charged as site writes" \
  "$(su_q -c "select count(*) from zsite.usage u where u.records <> (select count(*) from zsite.records r where r.site_id = u.site_id)")" "0"
BADCUR=$(printf '{"k":"-price","s":"x","t":"1","i":"%s"}' "$A_CAT1" | base64)
check_err "T16 cursor with a wrong-typed sort value" \
  "$(q anon "$anonA" "select api.list_records('events', p_sort => '-price', p_cursor => '$BADCUR')")" "invalid_cursor"
GOODCUR=$(q anon "$anonA" "select api.list_records('events', p_sort => '-price', p_limit => 2)->>'next_cursor'")
check_err "T16b cursor reused under a different sort" \
  "$(q anon "$anonA" "select api.list_records('events', p_sort => 'price', p_cursor => '$GOODCUR')")" "invalid_cursor"
check "T17 text sort asc: first city" \
  "$(q anon "$anonA" "select api.list_records('events', p_sort => 'city', p_limit => 1)->'items'->0->'data'->>'city'")" "Austin"
check "T18 masked field cannot be a sort key for anon" \
  "$(q anon "$anonA" "select api.list_records('catalog', p_sort => 'cost')" | sed -E 's/^ERR: (sort_not_allowed).*/\1/')" "sort_not_allowed"

say ""
say "== F3: manifest change vs in-flight insert (two real sessions) =="
su_q <<SQL >/dev/null
set role service_role;
insert into zsite.collections (site_id, name, rules, schema, indexes) values ('$A', 'race',
  '{"list":["anyone"],"get":["anyone"],"create":["admin"]}',
  '{"type":"object","properties":{"a":{"type":"string","maxLength":20},"b":{"type":"string","maxLength":20}}}',
  '{"a":{"type":"text","ops":["eq"]}}');
SQL
( q authenticated "$adminA" "select api.create_record('race', '{\"a\":\"AAA\",\"b\":\"BBB\"}'); select pg_sleep(2)" > "$DIR/race.out" ) &
sleep 0.7
T0=$(python3 -c 'import time; print(time.time())')
su_q -c "set role service_role; update zsite.collections set indexes = '{\"b\":{\"type\":\"text\",\"ops\":[\"eq\"]}}' where site_id = '$A' and name = 'race'" >/dev/null
T1=$(python3 -c 'import time; print(time.time())')
wait
check "F3a the insert committed" "$(grep -c '"id"' "$DIR/race.out")" "1"
check "F3b the manifest change waited for the in-flight insert (>1s)" "$(python3 -c "print($T1-$T0 > 1.0)")" "True"
check "F3e the manifest change marked the collection for reindex" \
  "$(su_q -c "select reindex_pending from zsite.collections where site_id = '$A' and name = 'race'")" "t"
reindex "$A" race >/dev/null
check "F3c every race row's slot matches the NEW manifest (t1 = b)" \
  "$(su_q -c "select string_agg(coalesce(t1, 'null'), ',') || ' ' || (select index_slots::text from zsite.collections where site_id = '$A' and name = 'race') from zsite.records where site_id = '$A' and collection = 'race'")" 'BBB {"b": "t1"}'
check "F3d filter on the new field finds the in-flight row" \
  "$(q anon "$anonA" "select jsonb_array_length(api.list_records('race', '{\"b\":\"BBB\"}')->'items')")" "1"

say ""
say "== deletes: free quota, separate end-user limit, erasure never limited =="
E=e1000000-0000-4000-8000-00000000000e
E_ADMIN=e1000000-0000-4000-8000-000000000001
E_U=e1000000-0000-4000-8000-000000000002
adminE="{\"role\":\"authenticated\",\"site_id\":\"$E\",\"sub\":\"$E_ADMIN\",\"site_role\":\"admin\"}"
su_q <<SQL >/dev/null
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'zsite_broker') then create role zsite_broker login noinherit; end if;
end \$\$;
alter role zsite_broker login;
grant usage on schema ztest to zsite_broker;
create function ztest.erase(p_site uuid, p_uid uuid) returns integer language plpgsql security definer set search_path = '' as \$\$
declare n integer; begin delete from zsite.records r where r.site_id = p_site and r.owner_id = p_uid; get diagnostics n = row_count; return n; end \$\$;
revoke all on function ztest.erase(uuid, uuid) from public;
grant execute on function ztest.erase(uuid, uuid) to zsite_broker;
set role service_role;
insert into zsite.sites (site_id) values ('$E');
update zsite.quotas set max_writes_per_min = 2, max_deletes_per_min = 3 where site_id = '$E';
insert into zsite.identities (site_id, email_norm, auth_user_id, alias) values
  ('$E', 'admin@e.test', '$E_ADMIN', 'he1@u.zavisite.invalid'), ('$E', 'u@e.test', '$E_U', 'he2@u.zavisite.invalid');
insert into zsite.members (site_id, user_id, role) values ('$E', '$E_ADMIN', 'admin'), ('$E', '$E_U', 'user');
insert into zsite.collections (site_id, name, rules, schema) values ('$E', 'notes',
  '{"list":["owner","admin"],"get":["owner","admin"],"create":["signed_in"],"update":["owner"],"delete":["owner","admin"]}',
  '{"type":"object","properties":{"t":{"type":"string","maxLength":50}}}');
insert into zsite.records (site_id, collection, id, owner_id, data)
select '$E', 'notes', gen_random_uuid(), case when g <= 12 then '$E_U'::uuid else '$E_ADMIN'::uuid end, jsonb_build_object('t', 'n' || g)
from generate_series(1, 20) g;
SQL
su_q -c "update zsite.usage set window_start = date_trunc('minute', now()) + interval '1 hour', window_writes = 0, del_window_start = date_trunc('minute', now()) + interval '1 hour', del_window_count = 0 where site_id = '$E'" >/dev/null
check "D0 20 platform inserts were not rate-limited (writes/min = 2)" \
  "$(su_q -c "select count(*) from zsite.records where site_id = '$E'")" "20"
ADMIN_IDS=($(su_q -c "select id from zsite.records where site_id = '$E' and owner_id = '$E_ADMIN' order by id"))
D1=""; for i in 0 1 2; do D1="$D1$(q authenticated "$adminE" "select api.delete_record('notes', '${ADMIN_IDS[$i]}')->>'deleted'")"; done
check "D1 end-user deletes beyond the write limit (2/min) succeed: 3 of 3" "$D1" "truetruetrue"
check_err "D2 the 4th end-user delete hits the separate delete limit (3/min)" \
  "$(q authenticated "$adminE" "select api.delete_record('notes', '${ADMIN_IDS[3]}')")" "delete rate"
check "D3 deletes did not consume the write window: 2 creates still allowed" \
  "$(q authenticated "$adminE" "select api.create_record('notes', '{\"t\":\"x\"}')->>'replayed'")$(q authenticated "$adminE" "select api.create_record('notes', '{\"t\":\"y\"}')->>'replayed'")" "falsefalse"
check_err "D3b ...and the 3rd create is rate-limited" \
  "$(q authenticated "$adminE" "select api.create_record('notes', '{\"t\":\"z\"}')")" "quota_exceeded"
check "D4 broker erasure deletes all 12 of the user's records despite both limits" \
  "$("${PSQL[@]}" -U zsite_broker -c "select ztest.erase('$E', '$E_U')" 2>&1)" "12"
check "D5 service_role bulk delete is never rate-limited" \
  "$(su_q -c "set role service_role; with d as (delete from zsite.records where site_id = '$E' returning 1) select count(*) from d")" "7"
check "D6 deletes freed records/bytes: usage equals real rows (0) and bytes 0" \
  "$(su_q -c "select records || ' ' || bytes from zsite.usage where site_id = '$E'")" "0 0"

say ""
say "== 0005: migration checksums =="
CK=""; for m in 0001_core 0002_api 0003_storage 0004_membership_slots_perf; do
  CK="$CK$( [ "$(su_q -c "select checksum from zsite.migrations where version = '$m'")" = "$(shasum -a 256 "$MIG/$m.sql" | cut -d' ' -f1)" ] && echo y || echo n)"
done
check "C1 0001-0004 back-filled with the sha256 of the file text (as S5 computes it)" "$CK" "yyyy"
SHA5=$(shasum -a 256 "$MIG/0005_contracts_archive_reindex.sql" | cut -d' ' -f1)
check "C2 runner records 0005's checksum (NULL filled)" \
  "$(q service_role '{}' "select zsite.record_migration('0005_contracts_archive_reindex', '$SHA5') = '$SHA5'")" "t"
check "C2b recording the same checksum again is idempotent" \
  "$(q service_role '{}' "select zsite.record_migration('0005_contracts_archive_reindex', '$SHA5') = '$SHA5'")" "t"
CK2=""; for m in 0006_contract_v2 0007_relational_slots_rls 0008_relational_api 0009_recipient_cap_quota 0010_release_on_delete 0013_transition_expect_set; do
  SHA=$(shasum -a 256 "$MIG/$m.sql" | cut -d' ' -f1)
  CK2="$CK2$( [ "$(q service_role '{}' "select zsite.record_migration('$m', '$SHA')")" = "$SHA" ] && echo y || echo n)"
done
check "C2c runner records the 0006-0013 checksums in the ledger" "$CK2" "yyyyyy"
check_err "C3 a different checksum for an applied version is refused" \
  "$(q service_role '{}' "select zsite.record_migration('0001_core', repeat('0', 64))")" "checksum_mismatch"
check_err "C3b malformed checksum refused" \
  "$(q service_role '{}' "select zsite.record_migration('0001_core', 'abc')")" "invalid_migration_record"
check_err "C4 end users cannot call it" \
  "$(q authenticated "$adminA" "select zsite.record_migration('9999_x', repeat('0', 64))")" "permission denied"

say ""
say "== 0005: S4 validator parity (collections CHECK vs the S4 manifest validator) =="
python3 - "$HERE/validator_cases.json" > "$DIR/vcases.txt" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for group in ("cases", "extra_null_paths"):
    for c in d[group]:
        print("\t".join([group, c["name"], "1" if c["accept"] else "0", c.get("kind", "records"),
                         json.dumps(c["rules"]), json.dumps(c.get("schema", {})), json.dumps(c.get("fields", {})),
                         json.dumps(c.get("indexes", {}))]))
PY
VAGREE=0; VTOTAL=0; XAGREE=0; XTOTAL=0
while IFS=$'\t' read -r grp name accept kind rules schema fields indexes; do
  if "${PSQL[@]}" -U postgres >/dev/null 2>&1 <<SQL
begin;
insert into zsite.collections (site_id, name, kind, rules, schema, fields, indexes)
values ('$A', 'v_$name', '$kind', \$j\$$rules\$j\$, \$j\$$schema\$j\$, \$j\$$fields\$j\$, \$j\$$indexes\$j\$);
rollback;
SQL
  then got=1; else got=0; fi
  if [ "$grp" = cases ]; then VTOTAL=$((VTOTAL+1)); [ "$got" = "$accept" ] && VAGREE=$((VAGREE+1)) || say "      MISMATCH $name: S4 says $accept, shard CHECK $got"
  else XTOTAL=$((XTOTAL+1)); [ "$got" = "$accept" ] && XAGREE=$((XAGREE+1)) || say "      MISMATCH $name: expected $accept, shard CHECK $got"; fi
done < "$DIR/vcases.txt"
check "V1 all 37 S4 validator cases agree with the shard CHECK (incl. the 5 former SQL gaps)" "$VAGREE/$VTOTAL" "37/37"
check "V2 extra NULL / non-integer paths (maxLength, minLength, maxItems, items, type, enum, minimum, index defs, masks) refused" "$XAGREE/$XTOTAL" "19/19"

say ""
say "== 0005: archived collections =="
su_q <<SQL >/dev/null
set role service_role;
insert into zsite.collections (site_id, name, rules, schema) values ('$A', 'arch',
  '{"list":["anyone"],"get":["anyone"],"create":["anyone"],"update":["admin"],"delete":["admin"]}',
  '{"type":"object","properties":{"t":{"type":"string","maxLength":20}}}');
insert into zsite.records (site_id, collection, id, data) values ('$A', 'arch', 'a7000000-0000-4000-8000-000000000001', '{"t":"kept"}');
update zsite.collections set archived_at = now() where site_id = '$A' and name = 'arch';
update zsite.collections set archived_at = now() where site_id = '$A' and name = 'images';
SQL
check_err "A1 archived: list refused" "$(q anon "$anonA" "select api.list_records('arch')")" "unknown_collection"
check "A2 archived: get returns null" \
  "$(q anon "$anonA" "select coalesce(api.get_record('arch', 'a7000000-0000-4000-8000-000000000001')::text, 'NULL')")" "NULL"
check_err "A3 archived: create refused" \
  "$(q anon "$anonA" "select api.create_record('arch', '{\"t\":\"x\"}', 'archived-create-key01')")" "unknown_collection"
check_err "A4 archived: admin update refused" \
  "$(q authenticated "$adminA" "select api.update_record('arch', 'a7000000-0000-4000-8000-000000000001', '{\"t\":\"y\"}')")" "not_found"
check_err "A5 archived: admin delete refused" \
  "$(q authenticated "$adminA" "select api.delete_record('arch', 'a7000000-0000-4000-8000-000000000001')")" "not_found"
check "A6 archived files area: files no longer readable" \
  "$(q anon "$anonA" "select count(*) from storage.objects where name like '$A/images/%'")" "0"
check "A7 archived data stays exportable by the platform" \
  "$(q service_role '{}' "select data->>'t' from zsite.records where site_id = '$A' and collection = 'arch'")" "kept"
su_q -c "set role service_role; update zsite.collections set archived_at = null where site_id = '$A' and name in ('arch', 'images')" >/dev/null
check "A8 restored by un-archiving: list works, rules intact" \
  "$(q anon "$anonA" "$LIST_NAMES(api.list_records('arch')->'items') e" | sed 's/^$/none/')$(q anon "$anonA" "select api.list_records('arch')->'items'->0->'data'->>'t'")" "nonekept"
check "A9 restored files area readable again" \
  "$(q anon "$anonA" "select count(*) > 0 from storage.objects where name like '$A/images/%'")" "t"

say ""
say "== 0005: batched reindex with concurrent writers =="
su_q <<SQL >/dev/null
set role service_role;
insert into zsite.collections (site_id, name, rules, schema, indexes) values ('$A', 'reidx',
  '{"list":["anyone"],"get":["anyone"],"create":["admin"],"update":["admin"],"delete":["admin"]}',
  '{"type":"object","properties":{"a":{"type":"string","maxLength":20},"b":{"type":"string","maxLength":20},"n":{"type":"number"}}}',
  '{"a":{"type":"text","ops":["eq"]}}');
insert into zsite.records (site_id, collection, id, data)
select '$A', 'reidx', gen_random_uuid(), jsonb_build_object('a', 'a' || g, 'b', 'b' || (g % 50), 'n', g)
from generate_series(1, 5000) g;
update zsite.quotas set max_writes_per_min = 100000 where site_id = '$A';
update zsite.collections set indexes = '{"b":{"type":"text","ops":["eq"]},"n":{"type":"number","ops":["range"],"sort":true}}'
 where site_id = '$A' and name = 'reidx';
SQL
check "X1 index change on a collection with records: pending, gen bumped" \
  "$(su_q -c "select reindex_pending || ' ' || slots_gen from zsite.collections where site_id = '$A' and name = 'reidx'")" "true 1"
UPD_IDS=($(su_q -c "select id from zsite.records where site_id = '$A' and collection = 'reidx' order by id desc limit 45"))
for w in 0 1 2; do
  ( for i in $(seq 0 14); do
      q authenticated "$adminA" "select api.create_record('reidx', jsonb_build_object('a','w$w-$i','b','wb$w','n', 900000 + $w * 100 + $i))" >/dev/null
      q authenticated "$adminA" "select api.update_record('reidx', '${UPD_IDS[$((w * 15 + i))]}', jsonb_build_object('b', 'upd$w-$i'))" >> "$DIR/reidx_upd.txt"
    done ) &
done
sleep 0.3
T0=$(python3 -c 'import time; print(time.time())')
reindex "$A" reidx 10 >/dev/null
T1=$(python3 -c 'import time; print(time.time())')
wait
check "X1b all 45 concurrent updates applied" "$(grep -c '"updated": true' "$DIR/reidx_upd.txt")" "45"
check "X1c writes overlapped the reindex (rows written by writers while it ran)" \
  "$(su_q -c "select count(*) > 0 from zsite.records where site_id = '$A' and collection = 'reidx' and updated_at between to_timestamp($T0) and to_timestamp($T1)")" "t"
reindex "$A" reidx 250 >/dev/null   # no-op if nothing moved; finishes any restart
check "X2 reindex done (pending cleared)" \
  "$(su_q -c "select reindex_pending from zsite.collections where site_id = '$A' and name = 'reidx'")" "f"
check "X3 every row consistent with the new manifest (t1 = b, n1 = n) after concurrent writes" \
  "$(su_q -c "select count(*) from zsite.records r, zsite.collections c where c.site_id = '$A' and c.name = 'reidx' and r.site_id = c.site_id and r.collection = c.name and (r.t1 is distinct from r.data->>(select key from jsonb_each_text(c.index_slots) where value = 't1') or r.n1 is distinct from (r.data->>(select key from jsonb_each_text(c.index_slots) where value = 'n1'))::numeric)")" "0"
check "X4 writers' rows all landed (5000 + 45)" \
  "$(su_q -c "select count(*) from zsite.records where site_id = '$A' and collection = 'reidx'")" "5045"
check "X5 filters work after the reindex" \
  "$(q anon "$anonA" "select jsonb_array_length(api.list_records('reidx', '{\"n\":{\"gte\":100,\"lt\":110}}', 100)->'items')")" "10"
check "X6 reindex charged no quota (usage = rows)" \
  "$(su_q -c "select count(*) from zsite.usage u where u.records <> (select count(*) from zsite.records r where r.site_id = u.site_id)")" "0"
say "      reindex of ~5,000 rows in 10-row batches with 3 concurrent writers: $(python3 -c "print(round($T1-$T0, 2))")s"
R1=$(q service_role '{}' "select zsite.reindex_batch('$A', 'reidx', null, null, 100)")
GEN=$(echo "$R1" | python3 -c 'import sys,json; print(json.load(sys.stdin)["gen"])')
su_q -c "set role service_role; update zsite.collections set indexes = '{\"a\":{\"type\":\"text\",\"ops\":[\"eq\"]}}' where site_id = '$A' and name = 'reidx'" >/dev/null
check "X7 a batch from the old generation is told to restart" \
  "$(q service_role '{}' "select zsite.reindex_batch('$A', 'reidx', null, $GEN, 100)->>'restart'")" "true"
reindex "$A" reidx 1000 >/dev/null
check "X8 after the restart pass: consistent and done" \
  "$(su_q -c "select (select reindex_pending from zsite.collections where site_id = '$A' and name = 'reidx') || ' ' || count(*) filter (where t1 is distinct from data->>'a') from zsite.records where site_id = '$A' and collection = 'reidx'")" "false 0"
check_err "X9 end users cannot run a reindex" \
  "$(q authenticated "$adminA" "select zsite.reindex_batch('$A', 'reidx', null, null, 10)")" "permission denied"

say ""
say "== quota change serializes with an in-flight write =="
su_q -c "update zsite.usage set window_writes = 0, window_start = '-infinity' where site_id = '$D'" >/dev/null
( q anon "$anonD" "select api.create_record('bookings', jsonb_build_object('name','w','email','w@x.test','date','2026-10-10'), 'inflight-key-0000001'); select pg_sleep(2)" > "$DIR/w.out" ) &
sleep 0.7
T0=$(python3 -c 'import time; print(time.time())')
su_q -c "set role service_role; update zsite.quotas set max_records = 0 where site_id = '$D'" >/dev/null
T1=$(python3 -c 'import time; print(time.time())')
wait
check "F4a quota update waited for the in-flight write (>1s)" "$(python3 -c "print($T1-$T0 > 1.0)")" "True"
check_err "F4b next write sees the lowered quota" \
  "$(q anon "$anonD" "select api.create_record('bookings', jsonb_build_object('name','w2','email','w@x.test','date','2026-10-10'), 'inflight-key-0000002')")" "quota_exceeded"

source "$HERE/kernel_v2.sh"

say ""
say "== privilege audit =="
check "Z1 SECURITY DEFINER = 8 api RPCs owned by zsite_facade + 6 kernel functions owned by zsite_kernel + 2 justified postgres-owned" \
  "$(su_q -c "select string_agg(p.proname || ':' || pg_get_userbyid(p.proowner), ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('zsite','api') and p.prosecdef")" "aggregate:zsite_facade,create_record:zsite_facade,delete_record:zsite_facade,get_record:zsite_facade,idempotent_replay:postgres,k_platform_delete_record:zsite_kernel,k_recipient_take:zsite_kernel,k_ref_delete:zsite_kernel,k_release_deleted:zsite_kernel,k_run_action:zsite_kernel,k_transition:zsite_kernel,list_records:zsite_facade,run_action:zsite_facade,tg_records_quota:postgres,transition_record:zsite_facade,update_record:zsite_facade"
check "Z1b zsite_facade: no login, no BYPASSRLS, not superuser, owns no table" \
  "$(su_q -c "select r.rolcanlogin or r.rolbypassrls or r.rolsuper or exists (select 1 from pg_class c where c.relowner = r.oid) from pg_roles r where r.rolname = 'zsite_facade'")" "f"
check "Z2 every zsite/api function pins search_path (except reindex_collection, which pins it per batch: COMMIT forbids a SET clause)" \
  "$(su_q -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('zsite','api') and p.proname <> 'reindex_collection' and not coalesce(array_to_string(p.proconfig, ',') like '%search_path=%', false)")" "0"
check "Z3 PUBLIC holds EXECUTE on no zsite/api function" \
  "$(su_q -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('zsite','api') and has_function_privilege('public', p.oid, 'execute')")" "0"
check "Z4 anon cannot execute the definer quota trigger fn directly" \
  "$(su_q -c "select has_function_privilege('anon', 'zsite.tg_records_quota()', 'execute')")" "f"
check "Z5 RLS enabled on every zsite table" \
  "$(su_q -c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'zsite' and c.relkind = 'r' and not c.relrowsecurity")" "0"
check "Z6 api exposes functions only (no tables/views)" \
  "$(su_q -c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'api'")" "0"

say ""
say "TOTAL: $PASSN passed, $FAILN failed"
[ -n "$RESULTS" ] && cp "$LOG" "$RESULTS"
[ "$FAILN" -eq 0 ]
