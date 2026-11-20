#!/usr/bin/env bash
set -uo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
PORT="${PORT:-55461}"
SITES="${SITES:-2000}"
RECS="${RECS:-1000}"
CALLS="${CALLS:-500}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../migrations"
DIR="$(mktemp -d -t site-shard-perf)"
OUT="${OUT:-}"

cleanup() {
  if [ -n "${KEEP:-}" ]; then echo "KEEP: $DIR"; return; fi
  "$PGBIN/pg_ctl" -D "$DIR/data" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DIR/data" -U postgres -A trust >/dev/null
"$PGBIN/pg_ctl" -D "$DIR/data" -l "$DIR/log" -w start -o "-p $PORT -k $DIR -c listen_addresses='' \
  -c shared_buffers=512MB -c max_wal_size=8GB -c maintenance_work_mem=1GB -c work_mem=16MB \
  -c max_connections=60 -c shared_preload_libraries=auto_explain \
  -c auto_explain.log_min_duration=-1 -c auto_explain.log_nested_statements=on \
  -c auto_explain.log_analyze=on -c auto_explain.log_buffers=on -c auto_explain.log_timing=on" >/dev/null

PSQL=("$PGBIN/psql" -h "$DIR" -p "$PORT" -d postgres -X -v ON_ERROR_STOP=1 -qAt)
su_q() { PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -U postgres "$@"; }
REPORT="$DIR/report.txt"; : > "$REPORT"
say() { echo "$*"; echo "$*" >> "$REPORT"; }

su_q <<'SQL'
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean not null default false,
  file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id),
  name text not null, owner uuid, owner_id text, metadata jsonb, created_at timestamptz default now(),
  updated_at timestamptz default now(), unique (bucket_id, name));
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
SQL
for m in 0001_core 0002_api 0003_storage 0004_membership_slots_perf 0005_contracts_archive_reindex \
         0006_contract_v2 0007_relational_slots_rls 0008_relational_api; do
  su_q -f "$MIG/$m.sql" >/dev/null || { echo "migration $m failed"; exit 1; }
done

T0=$(date +%s)
su_q <<SQL
create function pg_temp.sid(i int) returns uuid language sql immutable as \$\$ select md5('site' || i)::uuid \$\$;
create function pg_temp.uid(i int, j int) returns uuid language sql immutable as \$\$ select md5('u' || i || '-' || j)::uuid \$\$;

insert into zsite.sites (site_id) select pg_temp.sid(i) from generate_series(0, $SITES - 1) i;
update zsite.quotas set max_records = 100000000, max_bytes = 100000000000, max_writes_per_min = 1000000;
insert into zsite.identities (site_id, email_norm, auth_user_id, alias)
select pg_temp.sid(i), 'u' || j || '@s' || i || '.test', pg_temp.uid(i, j), md5('a' || i || '-' || j) || '@u.zavisite.invalid'
from generate_series(0, $SITES - 1) i, generate_series(0, 20) j;
insert into zsite.members (site_id, user_id, role)
select pg_temp.sid(i), pg_temp.uid(i, j), case when j = 0 then 'admin' else 'user' end
from generate_series(0, $SITES - 1) i, generate_series(0, 20) j;

insert into zsite.collections (site_id, name, rules, schema, fields, indexes)
select pg_temp.sid(i), c.name, c.rules::jsonb, c.schema::jsonb, c.fields::jsonb, c.indexes::jsonb
from generate_series(0, $SITES - 1) i,
(values
 ('catalog', '{"list":["anyone"],"get":["anyone"],"create":["admin"],"update":["admin"],"delete":["admin"]}',
  '{"type":"object","required":["name"],"properties":{"name":{"type":"string","maxLength":80},"price":{"type":"number"},"category":{"type":"string","maxLength":20},"cost":{"type":"number"}}}',
  '{"cost":{"read":["admin"],"write":["admin"]}}',
  '{"category":{"type":"text","ops":["eq","in"]},"price":{"type":"number","ops":["eq","range"],"sort":true}}'),
 ('bookings', '{"list":["owner","admin"],"get":["owner","admin"],"create":["anyone"],"update":["owner","admin"],"delete":["admin"]}',
  '{"type":"object","required":["name"],"properties":{"name":{"type":"string","maxLength":80},"day":{"type":"string","maxLength":10,"format":"date"},"status":{"type":"string","maxLength":20}}}',
  '{"status":{"write":["admin"]}}',
  '{"status":{"type":"text","ops":["eq"]},"day":{"type":"timestamp","ops":["range"],"sort":true}}'),
 ('posts', '{"list":["anyone"],"get":["anyone"],"create":["admin"],"update":["admin"],"delete":["admin"]}',
  '{"type":"object","required":["title"],"properties":{"title":{"type":"string","maxLength":120},"body":{"type":"string","maxLength":2000}}}',
  '{}', '{}'),
 ('reviews', '{"list":["anyone"],"get":["anyone"],"create":["signed_in"],"update":["owner"],"delete":["owner","admin"]}',
  '{"type":"object","required":["stars"],"properties":{"stars":{"type":"integer","minimum":1,"maximum":5},"text":{"type":"string","maxLength":500}}}',
  '{}', '{"stars":{"type":"number","ops":["eq","range"],"sort":true}}'),
 ('messages', '{"list":["owner","admin"],"get":["owner","admin"],"create":["signed_in"],"update":["owner"],"delete":["admin"]}',
  '{"type":"object","required":["text"],"properties":{"text":{"type":"string","maxLength":1000}}}',
  '{}', '{}')
) as c(name, rules, schema, fields, indexes);

begin;
insert into zsite.site_contracts (site_id, schema_version, aggregates)
select pg_temp.sid(i), 2, '{"req_count":{"collection":"requests","fn":"count","filters":["status"],"principals":["admin"]}}'
from generate_series(0, $SITES - 1) i;
insert into zsite.collections (site_id, name, rules, schema, indexes, recipient, states, "references")
select pg_temp.sid(i), c.name, c.rules::jsonb, c.schema::jsonb, c.indexes::jsonb, c.recipient::jsonb, c.states::jsonb, c.refs::jsonb
from generate_series(0, $SITES - 1) i,
(values
 ('listings', '{"list":["anyone"],"get":["anyone"],"create":["admin","signed_in"],"update":["owner","admin"],"delete":["owner","admin"]}',
  '{"type":"object","required":["title","status"],"properties":{"title":{"type":"string","maxLength":120},"status":{"type":"string","maxLength":9,"enum":["draft","published","archived"]},"price":{"type":"integer"}}}',
  '{"price":{"type":"number","ops":["eq","range"],"sort":true}}', null,
  '{"field":"status","values":["draft","published","archived"],"initial":"draft","read":{"draft":["owner","admin"],"published":["anyone"],"archived":["owner","admin"]},"transitions":[{"from":"draft","to":"published","principals":["owner","admin"]}]}',
  '{}'),
 ('requests', '{"list":["owner","recipient","admin"],"get":["owner","recipient","admin"],"create":["signed_in"],"update":[],"delete":["owner","admin"]}',
  '{"type":"object","required":["listing_id","message","status"],"properties":{"listing_id":{"type":"string","maxLength":36,"format":"uuid"},"message":{"type":"string","maxLength":500},"status":{"type":"string","maxLength":9,"enum":["pending","accepted","declined"]}}}',
  '{"listing_id":{"type":"text","ops":["eq"]}}', '{"reference":"listing_id"}',
  '{"field":"status","values":["pending","accepted","declined"],"initial":"pending","transitions":[{"from":"pending","to":"accepted","principals":["recipient"]}]}',
  '{"listing_id":{"collection":"listings","on_delete":"restrict"}}')
) as c(name, rules, schema, indexes, recipient, states, refs);
commit;
SQL
say "seed: sites/identities/members/collections in $(( $(date +%s) - T0 ))s"

T0=$(date +%s)
su_q <<SQL
set synchronous_commit = off;
drop index zsite.records_list_idx, zsite.records_owner_idx, zsite.records_idem_uidx,
  zsite.records_t1_idx, zsite.records_t2_idx, zsite.records_t3_idx, zsite.records_n1_idx,
  zsite.records_n2_idx, zsite.records_d1_idx, zsite.records_d2_idx,
  zsite.records_rcpt_idx, zsite.records_state_idx, zsite.records_ref1_idx, zsite.records_ref2_idx,
  zsite.records_ref3_idx, zsite.records_ref4_idx, zsite.records_uk1_uidx, zsite.records_uk2_uidx,
  zsite.records_uk3_uidx, zsite.records_uk4_uidx;
alter table zsite.records drop constraint records_pkey;
set session_replication_role = replica;
insert into zsite.records (site_id, collection, id, owner_id, data, t1, t2, t3, n1, n2, d1, d2, bytes, created_at, updated_at)
select s.site_id, x.collection, gen_random_uuid(), x.owner_id, x.data,
       x.t1, null, null, x.n1, null, x.d1, null, octet_length(x.data::text), x.ts, x.ts
from (select md5('site' || i)::uuid as site_id, i from generate_series(0, $SITES - 1) i) s
cross join lateral (
  select c.collection,
         case when c.collection in ('bookings', 'messages', 'reviews') then md5('u' || s.i || '-' || (1 + (k % 20)))::uuid end as owner_id,
         case c.collection
           when 'catalog'  then jsonb_build_object('name', 'item ' || k, 'price', (k * 7) % 500, 'category', (array['cars','vans','bikes','boats'])[k % 4 + 1], 'cost', k % 300)
           when 'bookings' then jsonb_build_object('name', 'guest ' || k, 'day', to_char(date '2026-01-01' + (k % 365), 'YYYY-MM-DD'), 'status', (array['pending','confirmed','cancelled'])[k % 3 + 1])
           when 'posts'    then jsonb_build_object('title', 'post ' || k, 'body', repeat('lorem ipsum ', 10))
           when 'reviews'  then jsonb_build_object('stars', k % 5 + 1, 'text', 'review ' || k)
           else jsonb_build_object('text', 'message ' || k) end as data,
         case c.collection when 'catalog' then (array['cars','vans','bikes','boats'])[k % 4 + 1]
                           when 'bookings' then (array['pending','confirmed','cancelled'])[k % 3 + 1] end as t1,
         case c.collection when 'catalog' then ((k * 7) % 500)::numeric when 'reviews' then (k % 5 + 1)::numeric end as n1,
         case c.collection when 'bookings' then ((date '2026-01-01' + (k % 365))::timestamp at time zone 'UTC') end as d1,
         timestamptz '2026-09-30' - (k * interval '7 minutes') as ts
  from unnest(array['catalog','bookings','posts','reviews','messages']) c(collection), generate_series(1, $RECS) k
) x;
insert into zsite.records (site_id, collection, id, owner_id, data, bytes, created_at, updated_at)
select md5('site0')::uuid, 'posts', gen_random_uuid(), null, x.data, octet_length(x.data::text), x.ts, x.ts
from (select jsonb_build_object('title', 'big ' || k, 'body', 'x') as data,
             timestamptz '2026-09-30' - (k * interval '7 minutes') as ts
      from generate_series($RECS + 1, 100000) k) x;
insert into zsite.records (site_id, collection, id, owner_id, data, state, n1, bytes, created_at, updated_at)
select md5('site' || i)::uuid, 'listings', md5('l' || i || '-' || k)::uuid, md5('u' || i || '-' || (1 + k % 20))::uuid,
       d.data, d.data->>'status', (k % 500)::numeric, octet_length(d.data::text),
       timestamptz '2026-09-30' - (k * interval '7 minutes'), timestamptz '2026-09-30' - (k * interval '7 minutes')
from generate_series(0, $SITES - 1) i, generate_series(1, $RECS) k,
     lateral (select jsonb_build_object('title', 'listing ' || k, 'status', case when k % 10 < 7 then 'published' else 'draft' end,
                                        'price', k % 500) as data) d;
insert into zsite.records (site_id, collection, id, owner_id, data, state, recipient_u1, ref1, t1, bytes, created_at, updated_at)
select md5('site' || i)::uuid, 'requests', gen_random_uuid(), md5('u' || i || '-' || (1 + (7 * k) % 20))::uuid,
       d.data, 'pending', md5('u' || i || '-' || (1 + lk % 20))::uuid, md5('l' || i || '-' || lk)::uuid,
       md5('l' || i || '-' || lk)::uuid::text, octet_length(d.data::text),
       timestamptz '2026-09-30' - (k * interval '7 minutes'), timestamptz '2026-09-30' - (k * interval '7 minutes')
from generate_series(0, $SITES - 1) i, generate_series(1, $RECS) k,
     lateral (select (k * 13) % $RECS + 1 as lk) l,
     lateral (select jsonb_build_object('listing_id', md5('l' || i || '-' || l.lk)::uuid::text, 'message', 'hello ' || k,
                                        'status', 'pending') as data) d;
set session_replication_role = origin;
SQL
say "bulk load: $(( SITES * 7 * RECS )) records in $(( $(date +%s) - T0 ))s"
T0=$(date +%s)
su_q <<'SQL'
set maintenance_work_mem = '1GB';
set max_parallel_maintenance_workers = 4;
alter table zsite.records add primary key (site_id, collection, id);
create index records_list_idx on zsite.records (site_id, collection, created_at desc, id desc);
create index records_owner_idx on zsite.records (site_id, collection, owner_id, created_at desc, id desc) where owner_id is not null;
create unique index records_idem_uidx on zsite.records (site_id, collection, idempotency_key) where idempotency_key is not null;
create index records_t1_idx on zsite.records (site_id, collection, t1, created_at desc, id desc) where t1 is not null;
create index records_t2_idx on zsite.records (site_id, collection, t2, created_at desc, id desc) where t2 is not null;
create index records_t3_idx on zsite.records (site_id, collection, t3, created_at desc, id desc) where t3 is not null;
create index records_n1_idx on zsite.records (site_id, collection, n1, created_at desc, id desc) where n1 is not null;
create index records_n2_idx on zsite.records (site_id, collection, n2, created_at desc, id desc) where n2 is not null;
create index records_d1_idx on zsite.records (site_id, collection, d1, created_at desc, id desc) where d1 is not null;
create index records_d2_idx on zsite.records (site_id, collection, d2, created_at desc, id desc) where d2 is not null;
create index records_rcpt_idx on zsite.records (site_id, collection, recipient_u1, created_at desc, id desc) where recipient_u1 is not null;
create index records_state_idx on zsite.records (site_id, collection, state, created_at desc, id desc) where state is not null;
create index records_ref1_idx on zsite.records (site_id, collection, ref1) where ref1 is not null;
create index records_ref2_idx on zsite.records (site_id, collection, ref2) where ref2 is not null;
create index records_ref3_idx on zsite.records (site_id, collection, ref3) where ref3 is not null;
create index records_ref4_idx on zsite.records (site_id, collection, ref4) where ref4 is not null;
create unique index records_uk1_uidx on zsite.records (site_id, collection, uk1) where uk1 is not null;
create unique index records_uk2_uidx on zsite.records (site_id, collection, uk2) where uk2 is not null;
create unique index records_uk3_uidx on zsite.records (site_id, collection, uk3) where uk3 is not null;
create unique index records_uk4_uidx on zsite.records (site_id, collection, uk4) where uk4 is not null;
update zsite.usage u set records = x.n, bytes = x.b
from (select site_id, count(*) n, sum(bytes) b from zsite.records group by site_id) x where x.site_id = u.site_id;
vacuum analyze;
SQL
say "indexes + vacuum analyze: $(( $(date +%s) - T0 ))s"
say "size: $(su_q -c "select pg_size_pretty(pg_total_relation_size('zsite.records')) || ' records table+indexes, ' || (select count(*) from zsite.records) || ' rows'")"

time_scenario() { # name role claims-sql call-sql
  "${PSQL[@]}" -U authenticator 2>&1 <<SQL | sed -n -e "s/^.*NOTICE: *//p" -e "s/^.*ERROR: */ERROR: /p"
begin;
set local role $2;
do \$\$
declare t0 timestamptz; ms double precision[] := '{}'; i int; s int; n int := 0;
begin
  for i in 1 .. $CALLS + 50 loop
    s := floor(random() * $SITES)::int;
    perform set_config('request.jwt.claims', ($3)::text, true);
    t0 := clock_timestamp();
    perform jsonb_array_length(($4)->'items');
    if i > 50 then ms := ms || extract(epoch from clock_timestamp() - t0) * 1000; end if;
  end loop;
  raise notice '%', format('%-58s p50 %6s ms  p95 %6s ms  p99 %6s ms  max %6s ms  (n=%s)', '$1',
    round((select percentile_cont(0.5) within group (order by x) from unnest(ms) x)::numeric, 2),
    round((select percentile_cont(0.95) within group (order by x) from unnest(ms) x)::numeric, 2),
    round((select percentile_cont(0.99) within group (order by x) from unnest(ms) x)::numeric, 2),
    round((select max(x) from unnest(ms) x)::numeric, 2), array_length(ms, 1));
end \$\$;
commit;
SQL
}
ANON="json_build_object('role','anon','site_id', md5('site' || s)::uuid)"
USER="json_build_object('role','authenticated','site_id', md5('site' || s)::uuid, 'sub', md5('u' || s || '-' || (1 + s % 20))::uuid, 'site_role','user')"
ADMIN="json_build_object('role','authenticated','site_id', md5('site' || s)::uuid, 'sub', md5('u' || s || '-0')::uuid, 'site_role','admin')"
S1="api.list_records('catalog', '{}', 50)"
S2="api.list_records('catalog', '{\"category\":\"vans\"}', 50, null, '-price')"
S3="api.list_records('bookings', '{}', 50)"
S4="api.list_records('bookings', '{\"day\":{\"gte\":\"2026-03-01\",\"lt\":\"2026-06-01\"}}', 50, null, 'day')"
S5="api.list_records('reviews', '{\"stars\":{\"gte\":4}}', 50, null, '-stars')"
S6="api.get_record('catalog', (select id from zsite.records where site_id = md5('site' || s)::uuid and collection = 'catalog' limit 1))"

say ""
say "== list_records latency, 50-row pages, random site per call ($CALLS calls each, after 50 warm-up) =="
say "$(time_scenario "S1 anon: public catalog, newest first" anon "$ANON" "$S1")"
say "$(time_scenario "S2 anon: catalog category=vans sorted -price" anon "$ANON" "$S2")"
say "$(time_scenario "S3 user: own bookings (owner-only rule, ~50 of 1000)" authenticated "$USER" "$S3")"
say "$(time_scenario "S4 admin: bookings day range, sorted by day" authenticated "$ADMIN" "$S4")"
say "$(time_scenario "S5 anon: reviews stars>=4 sorted -stars" anon "$ANON" "$S5")"
ANON0="json_build_object('role','anon','site_id', md5('site0')::uuid)"
say "$(time_scenario "S7 anon: 100K-record collection, newest first" anon "$ANON0" "api.list_records('posts', '{}', 50)")"
S8="api.list_records('requests', '{}', 50)"
S9="api.list_records('listings', '{}', 50)"
S10="api.list_records('listings', '{}', 50, null, '-price')"
say "$(time_scenario "S8 user: requests it owns OR is the recipient of (v2)" authenticated "$USER" "$S8")"
say "$(time_scenario "S9 anon: moderated listings, published only (v2 states.read)" anon "$ANON" "$S9")"
say "$(time_scenario "S10 user: listings sorted -price (own drafts + published, RLS)" authenticated "$USER" "$S10")"
say "$(time_scenario "S11 admin: aggregate count of pending requests (v2)" authenticated "$ADMIN" "jsonb_build_object('items', jsonb_build_array(api.aggregate('req_count', '{\"status\":\"pending\"}')))")"

say ""
say "== executed plans (auto_explain, nested; site 7) =="
plan() { # name role claims-json call
  : > "$DIR/log.mark"; local before; before=$(wc -l < "$DIR/log")
  "${PSQL[@]}" -U postgres >/dev/null 2>&1 <<SQL
set auto_explain.log_min_duration = 0;
begin;
set local role $2;
set local "request.jwt.claims" = '$3';
select $4;
commit;
SQL
  say "-- $1"
  tail -n +"$((before + 1))" "$DIR/log" \
    | awk '/^\tQuery Text: select array_agg/{p=1} p && /^[0-9][0-9][0-9][0-9]-/{p=0} p' | sed 's/^\t//' > "$DIR/plan.txt"
  cat "$DIR/plan.txt" >> "$REPORT"; cat "$DIR/plan.txt"
}
s=7
SID=$(su_q -c "select md5('site7')::uuid"); UID7=$(su_q -c "select md5('u7-8')::uuid"); ADM7=$(su_q -c "select md5('u7-0')::uuid")
plan "S1 anon public catalog" anon "{\"role\":\"anon\",\"site_id\":\"$SID\"}" "$S1"
plan "S3 user own bookings" authenticated "{\"role\":\"authenticated\",\"site_id\":\"$SID\",\"sub\":\"$UID7\",\"site_role\":\"user\"}" "$S3"
SID0=$(su_q -c "select md5('site0')::uuid")
plan "S7 anon 100K-record posts, newest first (first page)" anon "{\"role\":\"anon\",\"site_id\":\"$SID0\"}" "api.list_records('posts', '{}', 50)"
S7SCAN=$(grep -E "Index (Only )?Scan.* on records" "$DIR/plan.txt" | head -1)
S7IDX=$(echo "$S7SCAN" | grep -oE "using [a-z_0-9]+" | head -1)
S7ROWS=$(echo "$S7SCAN" | grep -oE "rows=[0-9]+ loops" | grep -oE "[0-9]+")
S7SORT=$(grep -c "Sort Key: r_1.created_at" "$DIR/plan.txt")
say "S7 check: collection rows = $(su_q -c "select count(*) from zsite.records where site_id = md5('site0')::uuid and collection = 'posts'"), scan $S7IDX, rows read by the scan = $S7ROWS, explicit sort nodes on created_at = $S7SORT"
plan "S8 user requests owned or addressed (v2)" authenticated "{\"role\":\"authenticated\",\"site_id\":\"$SID\",\"sub\":\"$UID7\",\"site_role\":\"user\"}" "$S8"
plan "S9 anon moderated listings (v2)" anon "{\"role\":\"anon\",\"site_id\":\"$SID\"}" "$S9"
plan "S4 admin bookings day range sorted" authenticated "{\"role\":\"authenticated\",\"site_id\":\"$SID\",\"sub\":\"$ADM7\",\"site_role\":\"admin\"}" "$S4"

say ""
say "== batched reindex: add a text index to the 100K-record collection, CALL zsite.reindex_collection (2,000-row batches) =="
su_q -c "set role service_role; update zsite.collections set schema = jsonb_set(schema, '{properties,title,maxLength}', '120'), indexes = '{\"title\":{\"type\":\"text\",\"ops\":[\"eq\",\"prefix\"]}}' where site_id = md5('site0')::uuid and name = 'posts'" >/dev/null
T0=$(python3 -c 'import time; print(time.time())')
su_q <<SQL >/dev/null
set role service_role;
call zsite.reindex_collection(md5('site0')::uuid, 'posts', 2000);
SQL
T1=$(python3 -c 'import time; print(time.time())')
RN=$(su_q -c "select count(*) from zsite.records where site_id = md5('site0')::uuid and collection = 'posts'")
say "reindex: $RN rows in $(python3 -c "print(round($T1-$T0, 2))")s = $(python3 -c "print(int($RN/($T1-$T0)))") rows/s; consistent: $(su_q -c "select count(*) = 0 from zsite.records where site_id = md5('site0')::uuid and collection = 'posts' and t1 is distinct from data->>'title'"); pending cleared: $(su_q -c "select not reindex_pending from zsite.collections where site_id = md5('site0')::uuid and name = 'posts'")"

cat > "$DIR/w.sql" <<'SQL'
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('role','authenticated','site_id', md5('site' || :site)::uuid, 'sub', md5('u' || :site || '-0')::uuid, 'site_role','admin')::text, true);
SELECT api.create_record('posts', '{"title":"bench","body":"x"}');
COMMIT;
SQL
{ echo '\set site 0'; cat "$DIR/w.sql"; } > "$DIR/one.sql"
{ echo '\set site :client_id'; cat "$DIR/w.sql"; } > "$DIR/many.sql"
bench() { "$PGBIN/pgbench" -h "$DIR" -p "$PORT" -U authenticator -n -c 20 -j 4 -T "${BENCH_SECS:-15}" -f "$1" postgres 2>&1 \
  | grep -E '^tps|latency average|failed' | tr '\n' ' '; }
say ""
say "== write throughput, 20 concurrent writers, ${BENCH_SECS:-15}s each (synchronous_commit=on, fsync=on) =="
say "one site   : $(bench "$DIR/one.sql")"
say "20 sites   : $(bench "$DIR/many.sql")"
say "counters ok: $(su_q -c "select count(*) = 0 from zsite.usage u where u.records <> (select count(*) from zsite.records r where r.site_id = u.site_id)")"

[ -n "$OUT" ] && cp "$REPORT" "$OUT"
exit 0
