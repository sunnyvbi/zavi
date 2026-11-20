
say ""
say "== v2 kernel: seed (two v2 sites) =="
R=f2000000-0000-4000-8000-0000000000f2
R2=f3000000-0000-4000-8000-0000000000f3
R_ADMIN=f2000000-0000-4000-8000-000000000001
R_SELLER=f2000000-0000-4000-8000-000000000002
R_BUYER=f2000000-0000-4000-8000-000000000003
R_BUYER2=f2000000-0000-4000-8000-000000000004
R_MOD=f2000000-0000-4000-8000-000000000005
R_SELLER2=f2000000-0000-4000-8000-000000000006
R2_ADMIN=f3000000-0000-4000-8000-000000000001
R2_U=f3000000-0000-4000-8000-000000000002
cl() { echo "{\"role\":\"authenticated\",\"site_id\":\"$1\",\"sub\":\"$2\",\"site_role\":\"$3\"}"; }
adminR=$(cl $R $R_ADMIN admin); sellerR=$(cl $R $R_SELLER seller); buyerR=$(cl $R $R_BUYER user)
buyer2R=$(cl $R $R_BUYER2 user); modR=$(cl $R $R_MOD moderator); seller2R=$(cl $R $R_SELLER2 seller)
buyerForged=$(cl $R $R_BUYER admin)
adminR2=$(cl $R2 $R2_ADMIN admin); uR2=$(cl $R2 $R2_U user)
anonR="{\"role\":\"anon\",\"site_id\":\"$R\"}"

LISTINGS_SCHEMA='{"type":"object","required":["title","status"],"properties":{"title":{"type":"string","maxLength":120},"status":{"type":"string","maxLength":9,"enum":["draft","published","archived"]},"price":{"type":"integer","minimum":0},"cost":{"type":"integer"}}}'
LISTINGS_RULES='{"list":["anyone"],"get":["anyone"],"create":["admin","role:seller"],"update":["owner","admin"],"delete":["owner","admin"]}'
LISTINGS_STATES='{"field":"status","values":["draft","published","archived"],"initial":"draft","read":{"draft":["owner","admin"],"published":["anyone"],"archived":["owner","admin"]},"transitions":[{"from":"draft","to":"published","principals":["owner","admin"]},{"from":"published","to":"archived","principals":["owner","admin"]}]}'
LISTINGS_IDX='{"price":{"type":"number","ops":["eq","range"],"sort":true},"cost":{"type":"number","ops":["eq"]}}'
REQ_SCHEMA='{"type":"object","required":["listing_id","message","status"],"properties":{"listing_id":{"type":"string","maxLength":36,"format":"uuid"},"message":{"type":"string","maxLength":1000},"status":{"type":"string","maxLength":9,"enum":["pending","accepted","declined","cancelled"]}}}'
REQ_RULES='{"list":["owner","recipient","admin"],"get":["owner","recipient","admin"],"create":["signed_in"],"update":["admin"],"delete":["owner","admin"]}'
REQ_STATES='{"field":"status","values":["pending","accepted","declined","cancelled"],"initial":"pending","read":{"pending":["owner","recipient","admin"],"accepted":["owner","recipient","admin"],"declined":["owner","recipient","admin"],"cancelled":["owner","recipient","admin"]},"transitions":[{"from":"pending","to":"accepted","principals":["recipient","admin"]},{"from":"pending","to":"declined","principals":["recipient","admin"]},{"from":"pending","to":"cancelled","principals":["owner","admin"]}]}'
SLOTS_SCHEMA='{"type":"object","required":["listing_id","starts_at","capacity","booked_count"],"properties":{"listing_id":{"type":"string","maxLength":36,"format":"uuid"},"starts_at":{"type":"string","maxLength":40,"format":"date-time"},"capacity":{"type":"integer","minimum":1,"maximum":100},"booked_count":{"type":"integer","minimum":0,"maximum":100}}}'
SLOTS_RULES='{"list":["anyone"],"get":["anyone"],"create":["admin","role:seller"],"update":["owner","admin"],"delete":["owner","admin"]}'
BOOK2_SCHEMA='{"type":"object","required":["slot_id","status"],"properties":{"slot_id":{"type":"string","maxLength":36,"format":"uuid"},"note":{"type":"string","maxLength":500},"status":{"type":"string","maxLength":9,"enum":["booked","cancelled"]}}}'
BOOK2_RULES='{"list":["owner","admin"],"get":["owner","admin"],"create":[],"update":[],"delete":[]}'
BOOK2_STATES='{"field":"status","values":["booked","cancelled"],"initial":"booked","transitions":[{"from":"booked","to":"cancelled","principals":["owner","admin"]}]}'
NOTES_SCHEMA='{"type":"object","required":["listing_id","text"],"properties":{"listing_id":{"type":"string","maxLength":36,"format":"uuid"},"text":{"type":"string","maxLength":200}}}'
OPEN_RULES='{"list":["anyone"],"get":["anyone"],"create":["signed_in"],"update":["owner","admin"],"delete":["owner","admin"]}'
TAGS_SCHEMA='{"type":"object","required":["label"],"properties":{"listing_id":{"type":"string","maxLength":36,"format":"uuid"},"label":{"type":"string","maxLength":40}}}'
HANDLES_SCHEMA='{"type":"object","properties":{"handle":{"type":"string","maxLength":30},"email2":{"type":"string","maxLength":100},"n":{"type":"integer"}}}'
ACTIONS='{"reserve_slot":{"target":{"collection":"slots","counter":"booked_count"},"delta":1,"initial":0,"bounds":{"min":0,"maxField":"capacity"},"creates":{"collection":"bookings","targetField":"slot_id"},"principals":["signed_in"],"idempotency":"required","inverse":{"name":"cancel_slot","delta":-1,"transition":{"from":"booked","to":"cancelled"},"principals":["owner","admin"],"idempotency":"required"}}}'
AGGS='{"booking_count":{"collection":"bookings","fn":"count","filters":["slot_id","status"],"principals":["admin"]},"listing_count":{"collection":"listings","fn":"count","filters":["status"],"principals":["admin","role:moderator"]},"price_sum":{"collection":"listings","fn":"sum","field":"price","principals":["role:moderator"]}}'

seed_out=$(su_q 2>&1 <<SQL
set role service_role;
insert into zsite.sites (site_id) values ('$R'), ('$R2');
update zsite.quotas set max_records = 100000, max_writes_per_min = 100000, max_deletes_per_min = 100000 where site_id in ('$R', '$R2');
insert into zsite.identities (site_id, email_norm, auth_user_id, alias) values
  ('$R', 'admin@r.test', '$R_ADMIN', 'hr1@u.zavisite.invalid'), ('$R', 'seller@r.test', '$R_SELLER', 'hr2@u.zavisite.invalid'),
  ('$R', 'buyer@r.test', '$R_BUYER', 'hr3@u.zavisite.invalid'), ('$R', 'buyer2@r.test', '$R_BUYER2', 'hr4@u.zavisite.invalid'),
  ('$R', 'mod@r.test', '$R_MOD', 'hr5@u.zavisite.invalid'), ('$R', 'seller2@r.test', '$R_SELLER2', 'hr6@u.zavisite.invalid'),
  ('$R2', 'admin@r2.test', '$R2_ADMIN', 'hs1@u.zavisite.invalid'), ('$R2', 'u@r2.test', '$R2_U', 'hs2@u.zavisite.invalid');
insert into zsite.members (site_id, user_id, role) values
  ('$R', '$R_ADMIN', 'admin'), ('$R', '$R_SELLER', 'seller'), ('$R', '$R_BUYER', 'user'), ('$R', '$R_BUYER2', 'user'),
  ('$R', '$R_MOD', 'moderator'), ('$R', '$R_SELLER2', 'seller'), ('$R2', '$R2_ADMIN', 'admin'), ('$R2', '$R2_U', 'user');
begin;
insert into zsite.site_contracts (site_id, schema_version, roles, actions, aggregates)
values ('$R', 2, '["seller","moderator","vip"]', '$ACTIONS', '$AGGS'),
       ('$R2', 2, '["seller"]', '$ACTIONS', '{}');
insert into zsite.collections (site_id, name, rules, schema, fields, indexes, recipient, uniques, states, "references")
select s, 'listings', '$LISTINGS_RULES'::jsonb, '$LISTINGS_SCHEMA'::jsonb, '{"cost":{"read":["owner","admin"]}}'::jsonb, '$LISTINGS_IDX'::jsonb,
       null::jsonb, '[]'::jsonb, '$LISTINGS_STATES'::jsonb, '{}'::jsonb from unnest(array['$R', '$R2']::uuid[]) s
union all
select '$R'::uuid, 'requests', '$REQ_RULES', '$REQ_SCHEMA', '{}', '{"listing_id":{"type":"text","ops":["eq"]}}',
       '{"reference":"listing_id"}', '[]', '$REQ_STATES', '{"listing_id":{"collection":"listings","on_delete":"restrict"}}'
union all
select s, 'slots', '$SLOTS_RULES', '$SLOTS_SCHEMA', '{}', '{"starts_at":{"type":"timestamp","ops":["range"],"sort":true}}',
       null, '[{"fields":["listing_id","starts_at"],"nulls":"not_distinct"}]', null,
       '{"listing_id":{"collection":"listings","on_delete":"restrict"}}' from unnest(array['$R', '$R2']::uuid[]) s
union all
select s, 'bookings', '$BOOK2_RULES', '$BOOK2_SCHEMA', '{}', '{"slot_id":{"type":"text","ops":["eq"]}}',
       null, '[]', '$BOOK2_STATES', '{"slot_id":{"collection":"slots","on_delete":"restrict"}}' from unnest(array['$R', '$R2']::uuid[]) s
union all
select s, 'notes', '$OPEN_RULES', '$NOTES_SCHEMA', '{}', '{}', null, '[]', null,
       '{"listing_id":{"collection":"listings","on_delete":"cascade"}}' from unnest(array['$R', '$R2']::uuid[]) s
union all
select '$R', 'tags', '$OPEN_RULES', '$TAGS_SCHEMA', '{}', '{}', null, '[]', null,
       '{"listing_id":{"collection":"listings","on_delete":"nullify"}}'
union all
select '$R', 'handles', '{"list":["owner","admin"],"get":["owner","admin"],"create":["signed_in"],"update":["owner"],"delete":["owner"]}',
       '$HANDLES_SCHEMA', '{}', '{}', null,
       '[{"fields":["handle"],"nulls":"distinct"},{"fields":["email2"],"nulls":"not_distinct"}]', null, '{}';
commit;
select 'ok';
SQL
)
check "K0 two v2 contracts + 7 collections commit through the deferred site validator" "$(echo "$seed_out" | tail -1)" "ok"
check "K0b slot assignment: uniques -> uk1, references -> ref1" \
  "$(su_q -c "select unique_slots::text || ' ' || reference_slots::text from zsite.collections where site_id = '$R' and name = 'slots'")" \
  '{"{\"nulls\": \"not_distinct\", \"fields\": [\"listing_id\", \"starts_at\"]}": "uk1"} {"listing_id": "ref1"}'

say ""
say "== v2 kernel: contract validation (each a separate transaction; must fail at COMMIT) =="
commit_err() { q service_role '{}' "$1"; }
check_err "KC1 undeclared role:ghost in a rule" \
  "$(commit_err "update zsite.collections set rules = rules || '{\"update\":[\"role:ghost\"]}' where site_id = '$R' and name = 'listings'")" \
  "invalid_contract: undeclared role ghost"
check_err "KC1b undeclared role in an action principal" \
  "$(commit_err "update zsite.site_contracts set actions = jsonb_set(actions, '{reserve_slot,principals}', '[\"role:ghost\"]') where site_id = '$R'")" \
  "invalid_contract: undeclared role ghost"
check_err "KC2 reference cycle listings -> tags -> listings" \
  "$(commit_err "update zsite.collections set schema = jsonb_set(schema, '{properties,tag_id}', '{\"type\":\"string\",\"maxLength\":36,\"format\":\"uuid\"}'), \"references\" = '{\"tag_id\":{\"collection\":\"tags\",\"on_delete\":\"nullify\"}}' where site_id = '$R' and name = 'listings'")" \
  "acyclic"
CHAIN_SCHEMA='{"type":"object","properties":{"p":{"type":"string","maxLength":36,"format":"uuid"}}}'
check_err "KC3 reference chain of depth 5 (c1 -> ... -> c6)" \
  "$(commit_err "insert into zsite.collections (site_id, name, rules, schema, \"references\") select '$R', 'c' || g, '{}', '$CHAIN_SCHEMA', case when g < 6 then jsonb_build_object('p', jsonb_build_object('collection', 'c' || (g + 1), 'on_delete', 'cascade')) else '{}'::jsonb end from generate_series(1, 6) g")" \
  "depth <= 4"
check "KC3b ...while depth 4 (c1 -> ... -> c5) is accepted" \
  "$(q service_role '{}' "insert into zsite.collections (site_id, name, rules, schema, \"references\") select '$R', 'd' || g, '{}', '$CHAIN_SCHEMA', case when g < 5 then jsonb_build_object('p', jsonb_build_object('collection', 'd' || (g + 1), 'on_delete', 'cascade')) else '{}'::jsonb end from generate_series(1, 5) g; select 'ok'")" "ok"
check_err "KC3c self-reference is a cycle" \
  "$(commit_err "update zsite.collections set \"references\" = '{\"p\":{\"collection\":\"d5\",\"on_delete\":\"cascade\"}}' where site_id = '$R' and name = 'd5'")" "acyclic"
check_err "KC3d reference to a collection that does not exist" \
  "$(commit_err "update zsite.collections set \"references\" = '{\"p\":{\"collection\":\"nope\",\"on_delete\":\"cascade\"}}' where site_id = '$R' and name = 'd5'")" "unknown collection"
check_err "KC4 aggregate over a field the principal cannot read (cost: owner/admin)" \
  "$(commit_err "update zsite.site_contracts set aggregates = aggregates || '{\"cost_sum\":{\"collection\":\"listings\",\"fn\":\"sum\",\"field\":\"cost\",\"principals\":[\"role:moderator\"]}}' where site_id = '$R'")" \
  "cannot read cost"
check_err "KC4b aggregate principal other than admin/role" \
  "$(commit_err "update zsite.site_contracts set aggregates = aggregates || '{\"x\":{\"collection\":\"listings\",\"fn\":\"count\",\"principals\":[\"signed_in\"]}}' where site_id = '$R'")" \
  "admin or roles"
check_err "KC4c sum over a non-indexed field" \
  "$(commit_err "update zsite.site_contracts set aggregates = aggregates || '{\"x\":{\"collection\":\"bookings\",\"fn\":\"sum\",\"field\":\"note\",\"principals\":[\"admin\"]}}' where site_id = '$R'")" \
  "numeric indexed field"
q service_role '{}' "update zsite.members set role = 'vip' where site_id = '$R' and user_id = '$R_BUYER2'" >/dev/null
check_err "KC5 removing a role a member still holds" \
  "$(commit_err "update zsite.site_contracts set roles = '[\"seller\",\"moderator\"]' where site_id = '$R'")" "role_in_use"
q service_role '{}' "update zsite.members set role = 'user' where site_id = '$R' and user_id = '$R_BUYER2'" >/dev/null
check_err "KC6 roles may not include admin" \
  "$(commit_err "update zsite.site_contracts set roles = '[\"admin\",\"seller\",\"moderator\",\"vip\"]' where site_id = '$R'")" "invalid_contract: roles"
check_err "KC7 unknown capability" \
  "$(commit_err "update zsite.site_contracts set capabilities = '[\"teleport\"]' where site_id = '$R'")" "capabilities"
check_err "KC8 v2 feature (states) on a v1 site" \
  "$(commit_err "insert into zsite.collections (site_id, name, rules, schema, states) values ('$A', 'v1states', '{}', '{\"type\":\"object\",\"required\":[\"s\"],\"properties\":{\"s\":{\"type\":\"string\",\"maxLength\":3,\"enum\":[\"a\",\"b\"]}}}', '{\"field\":\"s\",\"values\":[\"a\",\"b\"],\"initial\":\"a\",\"transitions\":[]}')")" \
  "need schemaVersion 2"
check_err "KC9 recipient principal on a collection without recipient" \
  "$(commit_err "update zsite.collections set rules = rules || '{\"get\":[\"recipient\"]}' where site_id = '$R' and name = 'notes'")" "collections_v2_valid"
check_err "KC10 recipient principal on create" \
  "$(commit_err "update zsite.collections set rules = rules || '{\"create\":[\"recipient\"]}' where site_id = '$R' and name = 'requests'")" "collections_v2_valid"
check_err "KC11 state field enum must equal the values" \
  "$(commit_err "update zsite.collections set states = jsonb_set(states, '{values}', '[\"draft\",\"published\"]') where site_id = '$R' and name = 'listings'")" "collections_v2_valid"
check_err "KC12 counter must be an integer field" \
  "$(commit_err "update zsite.site_contracts set actions = jsonb_set(actions, '{reserve_slot,target,counter}', '\"starts_at\"') where site_id = '$R'")" "integer field"
check_err "KC13 nullify on a required field" \
  "$(commit_err "update zsite.collections set \"references\" = '{\"listing_id\":{\"collection\":\"listings\",\"on_delete\":\"nullify\"}}' where site_id = '$R' and name = 'notes'")" "collections_v2_valid"
check "KC14 the prior contract is still live after every refused change" \
  "$(su_q -c "select (select roles::text from zsite.site_contracts where site_id = '$R') || ' ' || (select count(*) from zsite.collections where site_id = '$R' and name like 'c%')")" \
  '["seller", "moderator", "vip"] 0'

say ""
say "== v2 kernel: states (moderation) =="
L1=$(id_of "$(q authenticated "$sellerR" "select api.create_record('listings', '{\"title\":\"Bike\",\"price\":100,\"cost\":60}')")")
L2=$(id_of "$(q authenticated "$sellerR" "select api.create_record('listings', '{\"title\":\"Draft only\",\"price\":5}')")")
L4=$(id_of "$(q authenticated "$sellerR" "select api.create_record('listings', '{\"title\":\"Shelf\",\"price\":30}')")")
L5=$(id_of "$(q authenticated "$seller2R" "select api.create_record('listings', '{\"title\":\"Desk\",\"price\":70}')")")
check "ST1 generic create injects the initial state" \
  "$(q authenticated "$sellerR" "select api.get_record('listings', '$L1')->'data'->>'status'")" "draft"
check "ST2 anon sees no drafts" "$(q anon "$anonR" "select jsonb_array_length(api.list_records('listings')->'items')")" "0"
check "ST3 the owner sees its own drafts (state read: owner)" \
  "$(q authenticated "$sellerR" "select jsonb_array_length(api.list_records('listings')->'items')")" "3"
check "ST4 owner publishes L1" \
  "$(q authenticated "$sellerR" "select api.transition_record('listings', '$L1', 'published')::text")" \
  "{\"id\": \"$L1\", \"to\": \"published\", \"from\": \"draft\", \"transitioned\": true}"
for l in $L4 $L5; do
  who=$sellerR; [ "$l" = "$L5" ] && who=$seller2R
  q authenticated "$who" "select api.transition_record('listings', '$l', 'published')" >/dev/null
done
check "ST5 anon now lists the 3 published listings only" \
  "$(q anon "$anonR" "select jsonb_array_length(api.list_records('listings')->'items')")" "3"
check "ST5b anon get of a draft -> null" \
  "$(q anon "$anonR" "select coalesce(api.get_record('listings', '$L2')::text, 'NULL')")" "NULL"
check "ST5c another seller cannot read the draft either" \
  "$(q authenticated "$seller2R" "select coalesce(api.get_record('listings', '$L2')::text, 'NULL')")" "NULL"
check "ST6 same-state transition is a no-op" \
  "$(q authenticated "$sellerR" "select api.transition_record('listings', '$L1', 'published')->>'transitioned'")" "false"
check_err "ST7 illegal transition: no edge into 'draft' at all -> not_found" \
  "$(q authenticated "$sellerR" "select api.transition_record('listings', '$L1', 'draft')")" "not_found"
check_err "ST8 illegal transition for an authorized caller (draft -> archived) -> transition_conflict" \
  "$(q authenticated "$sellerR" "select api.transition_record('listings', '$L2', 'archived')")" "transition_conflict"
check_err "ST9 unauthorized transition (buyer archives the seller's listing) -> not_found" \
  "$(q authenticated "$buyerR" "select api.transition_record('listings', '$L1', 'archived')")" "not_found"
check_err "ST10 transition of a hidden draft by a non-owner -> not_found (no existence oracle)" \
  "$(q authenticated "$seller2R" "select api.transition_record('listings', '$L2', 'published')")" "not_found"
check_err "ST11 transition of a missing id -> not_found" \
  "$(q authenticated "$sellerR" "select api.transition_record('listings', gen_random_uuid(), 'published')")" "not_found"
check_err "ST12 anonymous transition" \
  "$(q anon "$anonR" "select api.transition_record('listings', '$L1', 'archived')")" "permission denied"
check_err "ST13 generic update cannot change the state" \
  "$(q authenticated "$sellerR" "select api.update_record('listings', '$L2', '{\"status\":\"published\"}')")" "field_not_writable: status"
check_err "ST13b ...nor remove it" \
  "$(q authenticated "$sellerR" "select api.update_record('listings', '$L2', '{\"status\":null}')")" "field_not_writable: status"
check_err "ST14 generic create cannot pick a non-initial state" \
  "$(q authenticated "$sellerR" "select api.create_record('listings', '{\"title\":\"x\",\"status\":\"published\"}')")" "field_not_writable: status"
check_err "ST15 [via facade] direct write of the state column" \
  "$(q authenticated "$sellerR" "select ztest.run(\$x\$update zsite.records set state = 'published' where id = '$L2' returning 1\$x\$)")" "permission denied"
check "ST16 the draft is still a draft" \
  "$(su_q -c "select state || ' ' || (data->>'status') from zsite.records where id = '$L2'")" "draft draft"
check "ST17 field read mask (cost: owner/admin) applies on a published listing" \
  "$(q anon "$anonR" "select (api.get_record('listings', '$L1')->'data' ? 'cost')::text")$(q authenticated "$sellerR" "select (api.get_record('listings', '$L1')->'data' ? 'cost')::text")" "falsetrue"

say ""
say "== v2 kernel: derived recipient =="
RQ1=$(id_of "$(q authenticated "$buyerR" "select api.create_record('requests', '{\"listing_id\":\"$L1\",\"message\":\"Is it available?\"}')")")
RQ2=$(id_of "$(q authenticated "$buyerR" "select api.create_record('requests', '{\"listing_id\":\"$L1\",\"message\":\"Second\"}')")")
check "RC1 recipient = owner of the referenced listing, copied by the server" \
  "$(su_q -c "select recipient_u1 || ' ' || state || ' ' || ref1 from zsite.records where id = '$RQ1'")" "$R_SELLER pending $L1"
check "RC2 the recipient (seller) lists the requests addressed to it" \
  "$(q authenticated "$sellerR" "select jsonb_array_length(api.list_records('requests')->'items')")" "2"
check "RC2b the owner (buyer) lists its own" \
  "$(q authenticated "$buyerR" "select jsonb_array_length(api.list_records('requests')->'items')")" "2"
check "RC2c a bystander (buyer2, seller2) lists none" \
  "$(q authenticated "$buyer2R" "select jsonb_array_length(api.list_records('requests')->'items')")$(q authenticated "$seller2R" "select jsonb_array_length(api.list_records('requests')->'items')")" "00"
check "RC2d recipient get works; bystander get -> null" \
  "$(q authenticated "$sellerR" "select api.get_record('requests', '$RQ1')->>'id'") $(q authenticated "$buyer2R" "select coalesce(api.get_record('requests', '$RQ1')::text, 'NULL')")" "$RQ1 NULL"
check "RC3 reading by naming the listing: buyer2 filters listing_id = L1 -> nothing" \
  "$(q authenticated "$buyer2R" "select jsonb_array_length(api.list_records('requests', '{\"listing_id\":\"$L1\"}')->'items')")" "0"
check_err "RC3b reading by naming yourself: filter on a recipient key is refused" \
  "$(q authenticated "$buyer2R" "select api.list_records('requests', '{\"recipient\":\"$R_BUYER2\"}')")" "filter_not_allowed"
check_err "RC3c ...nor on the derived column name" \
  "$(q authenticated "$buyer2R" "select api.list_records('requests', '{\"recipient_u1\":\"$R_BUYER2\"}')")" "filter_not_allowed"
check_err "RC4 recipient spoofing: a raw user id as the reference" \
  "$(q authenticated "$buyerR" "select api.create_record('requests', '{\"listing_id\":\"$R_BUYER2\",\"message\":\"x\"}')")" "invalid_reference"
check_err "RC4b recipient spoofing: an explicit recipient field" \
  "$(q authenticated "$buyerR" "select api.create_record('requests', '{\"listing_id\":\"$L1\",\"message\":\"x\",\"recipient\":\"$R_BUYER2\"}')")" "unknown field recipient"
check_err "RC4c [via facade] direct insert naming recipient_u1" \
  "$(q authenticated "$buyerR" "select ztest.run(\$x\$insert into zsite.records (site_id, collection, id, data, recipient_u1) values ('$R', 'requests', gen_random_uuid(), '{\"listing_id\":\"$L1\",\"message\":\"x\"}', '$R_BUYER2') returning 1\$x\$)")" \
  "permission denied"
check_err "RC4d [via facade] direct update of recipient_u1" \
  "$(q authenticated "$adminR" "select ztest.run(\$x\$update zsite.records set recipient_u1 = '$R_BUYER2' where id = '$RQ1' returning 1\$x\$)")" "permission denied"
check_err "RC4e [via facade] direct update of a reference slot / unique slot" \
  "$(q authenticated "$adminR" "select ztest.run(\$x\$update zsite.records set ref1 = gen_random_uuid(), uk1 = null where id = '$RQ1' returning 1\$x\$)")" "permission denied"
L_NOOWNER=$(su_q -c "set role service_role; insert into zsite.records (site_id, collection, id, data) values ('$R', 'listings', gen_random_uuid(), '{\"title\":\"ownerless\",\"status\":\"published\"}') returning id" | head -1)
LR2=$(id_of "$(q authenticated "$adminR2" "select api.create_record('listings', '{\"title\":\"R2 item\"}')")")
q authenticated "$adminR2" "select api.transition_record('listings', '$LR2', 'published')" >/dev/null
ERRS=""
for tgt in "$L2" "$LR2" "$(uuidgen | tr 'A-Z' 'a-z')" "$L_NOOWNER"; do
  ERRS="$ERRS|$(q authenticated "$buyerR" "select api.create_record('requests', '{\"listing_id\":\"$tgt\",\"message\":\"x\"}')")"
done
q service_role '{}' "update zsite.collections set archived_at = now() where site_id = '$R' and name = 'listings'" >/dev/null
ERRS="$ERRS|$(q authenticated "$buyerR" "select api.create_record('requests', '{\"listing_id\":\"$L1\",\"message\":\"x\"}')")"
q service_role '{}' "update zsite.collections set archived_at = null where site_id = '$R' and name = 'listings'" >/dev/null
check "RC5 hidden (draft), cross-site, missing, ownerless and archived targets: one identical error" \
  "$(echo "$ERRS" | tr '|' '\n' | grep -v '^$' | sort | uniq -c | sed 's/^ *//')" "5 ERR: invalid_reference"
check_err "RC5b platform insert on R2 referencing an R listing (cross-site target)" \
  "$(q service_role '{}' "insert into zsite.records (site_id, collection, id, data) values ('$R2', 'notes', gen_random_uuid(), '{\"listing_id\":\"$L1\",\"text\":\"x\"}')")" "invalid_reference"
check_err "RC6 source reference is immutable (admin may update requests, not listing_id)" \
  "$(q authenticated "$adminR" "select api.update_record('requests', '$RQ1', '{\"listing_id\":\"$L4\"}')")" "field_not_writable: listing_id"
check "RC6b admin may update other fields; recipient unchanged" \
  "$(q authenticated "$adminR" "select api.update_record('requests', '$RQ1', '{\"message\":\"edited\"}')->>'updated'") $(su_q -c "select recipient_u1 from zsite.records where id = '$RQ1'")" "true $R_SELLER"
check_err "RC7 the owner cannot accept its own request (recipient/admin only) -> not_found" \
  "$(q authenticated "$buyerR" "select api.transition_record('requests', '$RQ1', 'accepted')")" "not_found"
check "RC8 the recipient accepts" \
  "$(q authenticated "$sellerR" "select api.transition_record('requests', '$RQ1', 'accepted')->>'transitioned'")" "true"
check_err "RC8b ...and cannot then decline it (no edge from accepted)" \
  "$(q authenticated "$sellerR" "select api.transition_record('requests', '$RQ1', 'declined')")" "transition_conflict"
check_err "RC8c a non-recipient seller cannot touch it (not_found)" \
  "$(q authenticated "$seller2R" "select api.transition_record('requests', '$RQ2', 'accepted')")" "not_found"
check_err "RC8d cross-site token (R2 user) on an R request -> not_found" \
  "$(q authenticated "$uR2" "select api.transition_record('requests', '$RQ2', 'accepted')")" "not_found"
check "RC8e the owner cancels its other request" \
  "$(q authenticated "$buyerR" "select api.transition_record('requests', '$RQ2', 'cancelled')->>'transitioned'")" "true"
su_q -c "insert into zsite.recipient_windows values ('$R', 'requests', '$R_SELLER2', date_trunc('minute', now()) + interval '1 hour', 0)" >/dev/null
RATE_OK=0
for i in $(seq 1 30); do
  out=$(q authenticated "$buyer2R" "select api.create_record('requests', '{\"listing_id\":\"$L5\",\"message\":\"spam $i\"}')->>'replayed'")
  [ "$out" = "false" ] && RATE_OK=$((RATE_OK+1))
done
check "RC9 30 requests to one recipient within the minute succeed" "$RATE_OK" "30"
check_err "RC9b the 31st is recipient_rate_limited" \
  "$(q authenticated "$buyer2R" "select api.create_record('requests', '{\"listing_id\":\"$L5\",\"message\":\"spam 31\"}')")" "recipient_rate_limited"
check "RC9c ...and nothing was written for it (30 rows)" \
  "$(su_q -c "select count(*) from zsite.records where site_id = '$R' and collection = 'requests' and ref1 = '$L5'")" "30"
check "RC9d another recipient is unaffected" \
  "$(q authenticated "$buyer2R" "select api.create_record('requests', '{\"listing_id\":\"$L1\",\"message\":\"hi\"}')->>'replayed'")" "false"
check "RC10 the per-site cap defaults to 30 (0009 quota column)" \
  "$(su_q -c "select string_agg(distinct max_recipient_creates_per_min::text, ',') from zsite.quotas")" "30"
su_q -c "delete from zsite.recipient_windows where site_id = '$R' and recipient = '$R_SELLER'; insert into zsite.recipient_windows values ('$R', 'requests', '$R_SELLER', date_trunc('minute', now()) + interval '1 hour', 0)" >/dev/null
q service_role '{}' "update zsite.quotas set max_recipient_creates_per_min = 2 where site_id = '$R'" >/dev/null
check "RC10b a lowered cap applies at once: 2 creates pass" \
  "$(for i in 1 2; do q authenticated "$buyer2R" "select api.create_record('requests', '{\"listing_id\":\"$L1\",\"message\":\"cap $i\"}')->>'replayed'"; done | paste -sd, -)" "false,false"
check_err "RC10c ...and the 3rd is recipient_rate_limited" \
  "$(q authenticated "$buyer2R" "select api.create_record('requests', '{\"listing_id\":\"$L1\",\"message\":\"cap 3\"}')")" "recipient_rate_limited"
check "RC10d the per-site value never touches another site's quota" \
  "$(su_q -c "select string_agg(site_id::text || '=' || max_recipient_creates_per_min, ',' order by site_id) from zsite.quotas where site_id in ('$R', '$R2', '$A')")" "$A=30,$R=2,$R2=30"
check_err "RC10e the cap is bounded (0..10000)" \
  "$(q service_role '{}' "update zsite.quotas set max_recipient_creates_per_min = 10001 where site_id = '$R'")" "quotas_recipient_cap_range"
check_err "RC10f end users cannot read or set it" \
  "$(q authenticated "$adminR" "update zsite.quotas set max_recipient_creates_per_min = 1000")" "permission denied"
q service_role '{}' "update zsite.quotas set max_recipient_creates_per_min = 30 where site_id = '$R'" >/dev/null

say ""
say "== v2 kernel: uniques =="
S1=$(id_of "$(q authenticated "$sellerR" "select api.create_record('slots', '{\"listing_id\":\"$L1\",\"starts_at\":\"2026-11-01T10:00:00Z\",\"capacity\":10}')")")
check "U1 counter injected at its initial value" \
  "$(q anon "$anonR" "select api.get_record('slots', '$S1')->'data'->>'booked_count'")" "0"
check_err "U2 duplicate (listing, starts_at) written as a different representation of the same instant + upper-case uuid" \
  "$(q authenticated "$sellerR" "select api.create_record('slots', '{\"listing_id\":\"$(echo $L1 | tr a-f A-F)\",\"starts_at\":\"2026-11-01T12:00:00+02:00\",\"capacity\":3}')")" "unique_conflict"
check "U2b a different instant is fine" \
  "$(q authenticated "$sellerR" "select api.create_record('slots', '{\"listing_id\":\"$L1\",\"starts_at\":\"2026-11-02T10:00:00Z\",\"capacity\":10}')->>'replayed'")" "false"
S1B=$(su_q -c "select id from zsite.records where site_id = '$R' and collection = 'slots' and data->>'starts_at' = '2026-11-02T10:00:00Z'")
check_err "U2c an update that collides is unique_conflict too" \
  "$(q authenticated "$sellerR" "select api.update_record('slots', '$S1B', '{\"starts_at\":\"2026-11-01T10:00:00.000Z\"}')")" "unique_conflict"
"${PSQL[@]}" -U postgres -c "select pg_advisory_lock(4545), pg_sleep(3)" >/dev/null &
sleep 0.5
for i in $(seq 1 10); do
  ( q authenticated "$sellerR" "select pg_advisory_lock_shared(4545); select api.create_record('slots', '{\"listing_id\":\"$L1\",\"starts_at\":\"2026-12-01T10:00:00Z\",\"capacity\":5}')->>'replayed'" \
      > "$DIR/u$i.out" ) &
done
wait
check "U3 duplicate under concurrency: 10 racing creates -> exactly 1 row" \
  "$(cat "$DIR"/u*.out | grep -c '^false$') $(cat "$DIR"/u*.out | grep -c 'unique_conflict') $(su_q -c "select count(*) from zsite.records where site_id = '$R' and collection = 'slots' and data->>'starts_at' = '2026-12-01T10:00:00Z'")" \
  "1 9 1"
H() { q authenticated "$buyerR" "select api.create_record('handles', '$1')->>'replayed'"; }
check "U4 distinct: two rows without the handle are fine" "$(H '{"email2":"x@x.test"}')$(H '{"email2":"y@x.test"}')" "falsefalse"
check "U4b distinct: a handle once is fine" "$(H '{"handle":"neo","email2":"n1@x.test"}')" "false"
check_err "U4c distinct: same handle twice conflicts" "$(H '{"handle":"neo","email2":"n2@x.test"}')" "unique_conflict"
check "U5 not_distinct: one row without email2 is fine" "$(H '{"n":1}')" "false"
check_err "U5b not_distinct: a second row without email2 conflicts (absent == absent)" "$(H '{"n":2}')" "unique_conflict"
check "U6 same tuple on another site does not conflict (per-site scope)" \
  "$(q authenticated "$adminR2" "select api.create_record('slots', jsonb_build_object('listing_id','$LR2','starts_at','2026-11-01T10:00:00Z','capacity',2))->>'replayed'")" "false"
su_q -c "set role service_role; insert into zsite.records (site_id, collection, id, owner_id, data) values ('$R', 'tags', gen_random_uuid(), '$R_BUYER', '{\"label\":\"dup\"}'), ('$R', 'tags', gen_random_uuid(), '$R_BUYER', '{\"label\":\"dup\"}')" >/dev/null
check_err "U7 adding a unique over existing duplicates fails the manifest change" \
  "$(q service_role '{}' "update zsite.collections set uniques = '[{\"fields\":[\"label\"],\"nulls\":\"distinct\"}]' where site_id = '$R' and name = 'tags'")" "unique_conflict"
check "U7b ...and the prior definition is still live" \
  "$(su_q -c "select uniques::text from zsite.collections where site_id = '$R' and name = 'tags'")" "[]"

say ""
say "== v2 kernel: declared actions =="
S2=$(id_of "$(q authenticated "$sellerR" "select api.create_record('slots', '{\"listing_id\":\"$L1\",\"starts_at\":\"2026-11-05T10:00:00Z\",\"capacity\":10}')")")
check_err "AC1 generic write of the counter (no raw increment)" \
  "$(q authenticated "$sellerR" "select api.update_record('slots', '$S2', '{\"booked_count\":3}')")" "field_not_writable: booked_count"
check_err "AC1b generic create cannot preset the counter" \
  "$(q authenticated "$sellerR" "select api.create_record('slots', '{\"listing_id\":\"$L1\",\"starts_at\":\"2026-11-06T10:00:00Z\",\"capacity\":10,\"booked_count\":4}')")" "field_not_writable: booked_count"
check_err "AC1c generic create of the action's record is impossible (bookings create: [])" \
  "$(q authenticated "$buyerR" "select api.create_record('bookings', '{\"slot_id\":\"$S2\"}')")" "row-level security"
RUN1=$(q authenticated "$buyerR" "select api.run_action('reserve_slot', '$S2', null, '{\"note\":\"window seat\"}', 'reserve-key-000000001')")
B1=$(echo "$RUN1" | python3 -c 'import sys,json; print(json.load(sys.stdin)["record_id"])')
check "AC2 reserve: counter 1, booking created in the same transaction" \
  "$(echo "$RUN1" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["counter"], d["replayed"], d["target_id"])') $(su_q -c "select data->>'slot_id' || ' ' || state || ' ' || owner_id from zsite.records where id = '$B1'")" \
  "1 False $S2 $S2 booked $R_BUYER"
check "AC3 replay with the same key returns the same receipt" \
  "$(q authenticated "$buyerR" "select (r->>'record_id') || ' ' || (r->>'replayed') from api.run_action('reserve_slot', '$S2', null, '{\"note\":\"window seat\"}', 'reserve-key-000000001') r")" "$B1 true"
check_err "AC3b same key, different request -> idempotency_conflict" \
  "$(q authenticated "$buyerR" "select api.run_action('reserve_slot', '$S1', null, '{}', 'reserve-key-000000001')")" "idempotency_conflict"
check_err "AC3c same key, different caller -> idempotency_conflict" \
  "$(q authenticated "$buyer2R" "select api.run_action('reserve_slot', '$S2', null, '{\"note\":\"window seat\"}', 'reserve-key-000000001')")" "idempotency_conflict"
check_err "AC4 key required" \
  "$(q authenticated "$buyerR" "select api.run_action('reserve_slot', '$S2', null, '{}')")" "idempotency_key_required"
check_err "AC5 anonymous caller on a signed_in action" \
  "$(q anon "$anonR" "select api.run_action('reserve_slot', '$S2', null, '{}', 'reserve-key-anon00001')")" "action_not_allowed"
check_err "AC6 undeclared action" \
  "$(q authenticated "$buyerR" "select api.run_action('increment', '$S2', null, '{}', 'reserve-key-undecl001')")" "action_not_allowed"
check_err "AC7 the caller cannot set the created record's state" \
  "$(q authenticated "$buyerR" "select api.run_action('reserve_slot', '$S2', null, '{\"status\":\"cancelled\"}', 'reserve-key-state0001')")" "field_not_writable: status"
check_err "AC7b ...nor point targetField elsewhere" \
  "$(q authenticated "$buyerR" "select api.run_action('reserve_slot', '$S2', null, '{\"slot_id\":\"$S1\"}', 'reserve-key-tfield001')")" "invalid_action_input"
check_err "AC8 cross-site target uuid (R2 user, R slot) -> not_found" \
  "$(q authenticated "$uR2" "select api.run_action('reserve_slot', '$S2', null, '{}', 'reserve-key-xsite0001')")" "not_found"
SR2=$(su_q -c "select id from zsite.records where site_id = '$R2' and collection = 'slots' limit 1")
check "AC8b cross-site receipt isolation: R's key on R2 is a fresh action, not a replay" \
  "$(q authenticated "$uR2" "select api.run_action('reserve_slot', '$SR2', null, '{\"note\":\"window seat\"}', 'reserve-key-000000001')->>'replayed'")" "false"
su_q -c "set role service_role; update zsite.site_contracts set actions = jsonb_set(actions, '{reserve_slot,principals}', '[\"anyone\"]') where site_id = '$R2'" >/dev/null
anonR2="{\"role\":\"anon\",\"site_id\":\"$R2\"}"
check "AC8c an action that declares anyone runs for an anonymous caller (record has no owner)" \
  "$(q anon "$anonR2" "select (api.run_action('reserve_slot', '$SR2', null, '{}', 'anon-reserve-0000001')->>'counter')") $(su_q -c "select count(*) from zsite.records where site_id = '$R2' and collection = 'bookings' and owner_id is null")" "2 1"
check_err "AC8d ...still capped by the bound (capacity 2)" \
  "$(q anon "$anonR2" "select api.run_action('reserve_slot', '$SR2', null, '{}', 'anon-reserve-0000002')")" "action_bound"
check "AG0 contract updated through the validator; R kept signed_in" \
  "$(su_q -c "select actions->'reserve_slot'->>'principals' from zsite.site_contracts where site_id = '$R'")" '["signed_in"]'
check "AC9 the booking owner cancels (inverse): counter back to 0, state cancelled" \
  "$(q authenticated "$buyerR" "select (r->>'counter') || ' ' || (r->>'target_id') from api.run_action('cancel_slot', null, '$B1', '{}', 'cancel-key-0000000001') r") $(su_q -c "select state from zsite.records where id = '$B1'")" \
  "0 $S2 cancelled"
check_err "AC9b the inverse executes once (new key -> transition_conflict)" \
  "$(q authenticated "$buyerR" "select api.run_action('cancel_slot', null, '$B1', '{}', 'cancel-key-0000000002')")" "transition_conflict"
check "AC9c ...and the counter did not move again" \
  "$(su_q -c "select data->>'booked_count' from zsite.records where id = '$S2'")" "0"
check_err "AC9d another user cannot cancel someone's booking (not visible) -> not_found" \
  "$(q authenticated "$buyer2R" "select api.run_action('cancel_slot', null, '$B1', '{}', 'cancel-key-0000000003')")" "not_found"
check_err "AC9e inverse input must be a record id only" \
  "$(q authenticated "$buyerR" "select api.run_action('cancel_slot', '$S2', null, '{}', 'cancel-key-0000000004')")" "invalid_action_input"

"${PSQL[@]}" -U postgres -c "select pg_advisory_lock(4646), pg_sleep(4)" >/dev/null &
sleep 0.5
for i in $(seq 1 25); do
  who=$buyerR; [ $((i % 2)) -eq 0 ] && who=$buyer2R
  key=$(printf 'race-reserve-%08d' "$i")
  ( q authenticated "$who" "select pg_advisory_lock_shared(4646); select api.run_action('reserve_slot', '$S2', null, '{}', '$key')->>'counter'" \
      > "$DIR/a$i.out" ) &
done
MAXW=0
for _ in $(seq 1 30); do
  w=$(su_q -c "select count(*) from pg_locks where locktype = 'advisory' and objid = 4646 and not granted")
  [ "$w" -gt "$MAXW" ] && MAXW=$w
  sleep 0.1
done
wait
check "AC10 all 25 writers were queued together before the race" "$MAXW" "25"
check "AC10b counter overshoot under 25 concurrent writers: exactly 10 succeed, 15 action_bound" \
  "$(cat "$DIR"/a*.out | grep -cE '^[0-9]+$') $(cat "$DIR"/a*.out | grep -c 'action_bound')" "10 15"
check "AC10c counter = 10 = live bookings on the slot, never above capacity" \
  "$(su_q -c "select (select data->>'booked_count' from zsite.records where id = '$S2') || ' ' || count(*) from zsite.records where site_id = '$R' and collection = 'bookings' and ref1 = '$S2' and state = 'booked'")" "10 10"
check "AC10d the successful counters are exactly 1..10 (serialized)" \
  "$(cat "$DIR"/a*.out | grep -E '^[0-9]+$' | sort -n | paste -sd, -)" "1,2,3,4,5,6,7,8,9,10"
B_RACE=$(su_q -c "select id from zsite.records where site_id = '$R' and collection = 'bookings' and ref1 = '$S2' and state = 'booked' order by id limit 1")
B_OWNER=$(su_q -c "select owner_id from zsite.records where id = '$B_RACE'")
B_WHO=$buyerR; [ "$B_OWNER" = "$R_BUYER2" ] && B_WHO=$buyer2R
"${PSQL[@]}" -U postgres -c "select pg_advisory_lock(4747), pg_sleep(3)" >/dev/null &
sleep 0.5
for i in $(seq 1 5); do
  ( q authenticated "$B_WHO" "select pg_advisory_lock_shared(4747); select api.run_action('cancel_slot', null, '$B_RACE', '{}', 'race-cancel-$(printf %08d $i)')->>'counter'" > "$DIR/v$i.out" ) &
done
wait
check "AC11 5 concurrent inverses on one booking: exactly 1 succeeds, 4 transition_conflict, counter 9" \
  "$(cat "$DIR"/v*.out | grep -cE '^[0-9]+$') $(cat "$DIR"/v*.out | grep -c 'transition_conflict') $(su_q -c "select data->>'booked_count' from zsite.records where id = '$S2'")" "1 4 9"
check_err "AC12 lowering capacity below the counter is action_bound" \
  "$(q authenticated "$sellerR" "select api.update_record('slots', '$S2', '{\"capacity\":5}')")" "action_bound"
check_err "AC12b restrict: a slot with bookings cannot be deleted" \
  "$(q authenticated "$sellerR" "select api.delete_record('slots', '$S2')")" "reference_restricted"

say ""
say "== v2 kernel: aggregates =="
check "AG1 admin counts booked bookings of the slot" \
  "$(q authenticated "$adminR" "select api.aggregate('booking_count', '{\"slot_id\":\"$S2\",\"status\":\"booked\"}')->>'value'")" "9"
check_err "AG2 a plain user is refused" \
  "$(q authenticated "$buyerR" "select api.aggregate('booking_count', '{}')")" "aggregate_not_allowed"
check_err "AG2b a forged site_role=admin token is refused (DB role is authoritative)" \
  "$(q authenticated "$buyerForged" "select api.aggregate('booking_count', '{}')")" "aggregate_not_allowed"
check_err "AG2c anonymous callers cannot call it at all" \
  "$(q anon "$anonR" "select api.aggregate('listing_count', '{}')")" "permission denied"
check_err "AG3 filter on an undeclared field" \
  "$(q authenticated "$adminR" "select api.aggregate('booking_count', '{\"note\":\"x\"}')")" "filter_not_allowed"
check_err "AG3b undeclared aggregate" \
  "$(q authenticated "$adminR" "select api.aggregate('everything', '{}')")" "aggregate_not_allowed"
check "AG4 row visibility: the moderator counts only listings it can read (published)" \
  "$(q authenticated "$modR" "select api.aggregate('listing_count')->>'value'") $(su_q -c "select count(*) from zsite.records where site_id = '$R' and collection = 'listings' and state = 'published'")" \
  "$(su_q -c "select count(*) from zsite.records where site_id = '$R' and collection = 'listings' and state = 'published'") $(su_q -c "select count(*) from zsite.records where site_id = '$R' and collection = 'listings' and state = 'published'")"
check "AG4b ...while the admin counts drafts too" \
  "$(q authenticated "$adminR" "select api.aggregate('listing_count')->>'value'")" \
  "$(su_q -c "select count(*) from zsite.records where site_id = '$R' and collection = 'listings'")"
check "AG5 moderator sum over a readable numeric field, visible rows only" \
  "$(q authenticated "$modR" "select api.aggregate('price_sum')->>'value'")" \
  "$(su_q -c "select coalesce(sum((data->>'price')::numeric), 0) from zsite.records where site_id = '$R' and collection = 'listings' and state = 'published'")"
su_q -c "set session_replication_role = replica; update zsite.site_contracts set aggregates = aggregates || '{\"cost_sum\":{\"collection\":\"listings\",\"fn\":\"sum\",\"field\":\"cost\",\"principals\":[\"role:moderator\"]}}' where site_id = '$R'" >/dev/null
check_err "AG6 aggregate over a masked field is refused at runtime too" \
  "$(q authenticated "$modR" "select api.aggregate('cost_sum')")" "aggregate_not_allowed"
check "AG6b ...while an admin (who reads cost) may" \
  "$(su_q -c "set session_replication_role = replica; update zsite.site_contracts set aggregates = jsonb_set(aggregates, '{cost_sum,principals}', '[\"admin\"]') where site_id = '$R'" >/dev/null; q authenticated "$adminR" "select api.aggregate('cost_sum')->>'value'")" "60"
su_q -c "set session_replication_role = replica; update zsite.site_contracts set aggregates = aggregates - 'cost_sum' where site_id = '$R'" >/dev/null

say ""
say "== v2 kernel: references on delete =="
for i in 1 2 3; do q authenticated "$buyerR" "select api.create_record('notes', '{\"listing_id\":\"$L4\",\"text\":\"n$i\"}')" >/dev/null; done
for i in 1 2; do q authenticated "$buyerR" "select api.create_record('tags', '{\"listing_id\":\"$L4\",\"label\":\"t$i\"}')" >/dev/null; done
su_q -c "set session_replication_role = replica; insert into zsite.records (site_id, collection, id, data, ref1) values ('$R2', 'notes', gen_random_uuid(), '{\"listing_id\":\"$L4\",\"text\":\"r2 decoy\"}', '$L4')" >/dev/null
check_err "RF1 restrict: a listing with requests cannot be deleted by its owner" \
  "$(q authenticated "$sellerR" "select api.delete_record('listings', '$L1')")" "reference_restricted"
check "RF2 cascade + nullify: the owner deletes L4" \
  "$(q authenticated "$sellerR" "select api.delete_record('listings', '$L4')->>'deleted'")" "true"
check "RF2b the buyer's notes on L4 were cascaded (deleted by the kernel, not the buyer)" \
  "$(su_q -c "select count(*) from zsite.records where site_id = '$R' and collection = 'notes' and ref1 = '$L4'")" "0"
check "RF2c the tags were nullified: key removed, slot cleared, rows kept" \
  "$(su_q -c "select count(*) || ' ' || count(*) filter (where data ? 'listing_id' or ref1 is not null) from zsite.records where site_id = '$R' and collection = 'tags' and data->>'label' in ('t1','t2')")" "2 0"
check "RF3 a cascade never crosses sites: R2's row with the same uuid survives" \
  "$(su_q -c "select count(*) from zsite.records where site_id = '$R2' and collection = 'notes' and ref1 = '$L4'")" "1"
su_q -c "set role service_role; insert into zsite.records (site_id, collection, id, owner_id, data) select '$R', 'notes', gen_random_uuid(), '$R_BUYER', jsonb_build_object('listing_id', '$L5', 'text', 'bulk ' || g) from generate_series(1, 1001) g" >/dev/null
su_q -c "set role service_role; delete from zsite.records where site_id = '$R' and collection = 'requests' and ref1 = '$L5'" >/dev/null
check_err "RF4 fan-out cap: an end-user delete touching 1,001 dependents is refused" \
  "$(q authenticated "$seller2R" "select api.delete_record('listings', '$L5')")" "cascade_too_large"
check "RF4b ...and nothing was deleted" \
  "$(su_q -c "select count(*) from zsite.records where site_id = '$R' and (id = '$L5' or ref1 = '$L5')")" "1002"
check "RF5 platform erasure is never stranded: restrict and the cap do not apply (L1 + its requests/slots/bookings)" \
  "$(su_q -c "set role service_role; delete from zsite.records where site_id = '$R' and id in ('$L5', '$L1')" >/dev/null; su_q -c "select count(*) from zsite.records where site_id = '$R' and (id in ('$L5', '$L1') or ref1 in ('$L5', '$L1'))")" "0"
check "RF5b ...bookings of the deleted slots went too (depth 2)" \
  "$(su_q -c "select count(*) from zsite.records where site_id = '$R' and collection = 'bookings' and ref1 = '$S2'")" "0"
check "RF6 usage counters still equal real rows on R (kernel cascades are charged)" \
  "$(su_q -c "select records = (select count(*) from zsite.records r where r.site_id = '$R') from zsite.usage where site_id = '$R'")" "t"

say ""
say "== v2 kernel: backfill + schemaVersion 1 =="
check "BF1 adding a state machine to a collection with rows injects the initial state" \
  "$(q service_role '{}' "update zsite.collections set schema = '{\"type\":\"object\",\"required\":[\"label\",\"st\"],\"properties\":{\"listing_id\":{\"type\":\"string\",\"maxLength\":36,\"format\":\"uuid\"},\"label\":{\"type\":\"string\",\"maxLength\":40},\"st\":{\"type\":\"string\",\"maxLength\":5,\"enum\":[\"new\",\"done\"]}}}', states = '{\"field\":\"st\",\"values\":[\"new\",\"done\"],\"initial\":\"new\",\"transitions\":[{\"from\":\"new\",\"to\":\"done\",\"principals\":[\"owner\"]}]}' where site_id = '$R' and name = 'tags'; select 'ok'" >/dev/null; su_q -c "select count(*) filter (where state = 'new' and data->>'st' = 'new') || '/' || count(*) from zsite.records where site_id = '$R' and collection = 'tags'")" \
  "$(su_q -c "select count(*) || '/' || count(*) from zsite.records where site_id = '$R' and collection = 'tags'")"
check "BF2 a v1 site has no contract row and its collections carry empty v2 fields" \
  "$(su_q -c "select (select count(*) from zsite.site_contracts where site_id = '$A') || ' ' || count(*) filter (where recipient is null and uniques = '[]' and states is null and \"references\" = '{}') || '/' || count(*) from zsite.collections where site_id = '$A'")" \
  "0 $(su_q -c "select count(*) || '/' || count(*) from zsite.collections where site_id = '$A'")"
check "BF3 v1 rows keep working through the new triggers (create/list on site A)" \
  "$(q authenticated "$adminA" "select api.create_record('catalog', '{\"name\":\"v1 still\",\"price\":1}')->>'replayed'") $(q anon "$anonA" "select count(*) from jsonb_array_elements(api.list_records('catalog', p_limit => 100)->'items') e where e->'data'->>'name' = 'v1 still'")" \
  "false 1"
check "BF4 v1 rows have no derived slots" \
  "$(su_q -c "select count(*) from zsite.records where site_id = '$A' and (state is not null or recipient_u1 is not null or ref1 is not null or uk1 is not null)")" "0"

say ""
say "== v2 kernel: aggregate cost limit =="
su_q -c "set role service_role; insert into zsite.records (site_id, collection, id, owner_id, data) select '$R', 'listings', gen_random_uuid(), '$R_SELLER', jsonb_build_object('title', 'bulk ' || g, 'status', 'published', 'price', 1) from generate_series(1, 10001) g" >/dev/null
check_err "AG7 an aggregate over more than 10,000 visible rows is aggregate_too_large" \
  "$(q authenticated "$adminR" "select api.aggregate('listing_count')")" "aggregate_too_large"
check "AG7b a filter that narrows below the limit still answers" \
  "$(q authenticated "$adminR" "select api.aggregate('listing_count', '{\"status\":\"draft\"}')->>'value'")" \
  "$(su_q -c "select count(*) from zsite.records where site_id = '$R' and collection = 'listings' and state = 'draft'")"

say ""
say "== v2 kernel: codex review regressions =="
LX=$(id_of "$(q authenticated "$sellerR" "select api.create_record('listings', '{\"title\":\"X\"}')")")
LY=$(id_of "$(q authenticated "$seller2R" "select api.create_record('listings', '{\"title\":\"Y\"}')")")
q authenticated "$sellerR" "select api.transition_record('listings', '$LX', 'published')" >/dev/null
q authenticated "$seller2R" "select api.transition_record('listings', '$LY', 'published')" >/dev/null
SX=$(id_of "$(q authenticated "$sellerR" "select api.create_record('slots', '{\"listing_id\":\"$LX\",\"starts_at\":\"2027-01-01T10:00:00Z\",\"capacity\":5}')")")
SX2=$(id_of "$(q authenticated "$sellerR" "select api.create_record('slots', '{\"listing_id\":\"$LX\",\"starts_at\":\"2027-01-02T10:00:00Z\",\"capacity\":5}')")")
BX=$(q authenticated "$buyerR" "select api.run_action('reserve_slot', '$SX', null, '{}', 'cx-reserve-00000001')->>'record_id'")
check_err "CX1 an action-inverse edge is not a generic transition (no counter bypass)" \
  "$(q authenticated "$buyerR" "select api.transition_record('bookings', '$BX', 'cancelled')")" "not_found"
check "CX1b ...booking still booked, counter still 1" \
  "$(su_q -c "select (select state from zsite.records where id = '$BX') || ' ' || (select data->>'booked_count' from zsite.records where id = '$SX')")" "booked 1"
su_q -c "set role service_role; update zsite.collections set rules = rules || '{\"update\":[\"owner\",\"admin\"]}' where site_id = '$R' and name = 'bookings'" >/dev/null
check_err "CX2 the action-created record cannot be repointed at another target" \
  "$(q authenticated "$buyerR" "select api.update_record('bookings', '$BX', '{\"slot_id\":\"$SX2\"}')")" "field_not_writable: slot_id"
check "CX2b ...other fields stay editable" \
  "$(q authenticated "$buyerR" "select api.update_record('bookings', '$BX', '{\"note\":\"aisle\"}')->>'updated'")" "true"
su_q -c "set role service_role; update zsite.collections set rules = rules || '{\"update\":[]}' where site_id = '$R' and name = 'bookings'" >/dev/null
check_err "CX3 [via facade] the recipient window cannot be charged outside the records trigger" \
  "$(q authenticated "$buyerR" "select ztest.run(\$x\$select 'x' from zsite.k_recipient_take('requests', '$R_SELLER') f\$x\$)")" "not_in_trigger"
LZ1=$(id_of "$(q authenticated "$seller2R" "select api.create_record('listings', '{\"title\":\"Z1\"}')")")
LZ2=$(id_of "$(q authenticated "$seller2R" "select api.create_record('listings', '{\"title\":\"Z2\"}')")")
su_q -c "set role service_role; insert into zsite.records (site_id, collection, id, owner_id, data) select '$R', 'notes', gen_random_uuid(), '$R_BUYER', jsonb_build_object('listing_id', l, 'text', 'n' || g) from unnest(array['$LZ1', '$LZ2']) l, generate_series(1, 600) g" >/dev/null
check_err "CX4 [via facade] one multi-row delete is capped across all its roots (2 x 600 dependents)" \
  "$(q authenticated "$seller2R" "select ztest.run(\$x\$with d as (delete from zsite.records where collection = 'listings' and id in ('$LZ1', '$LZ2') returning 1) select count(*) from d\$x\$)")" "cascade_too_large"
check "CX4b ...while one root with 600 dependents is fine" \
  "$(q authenticated "$seller2R" "select api.delete_record('listings', '$LZ1')->>'deleted'")" "true"
MSG_SCHEMA='{"type":"object","required":["listing_id","listing2_id","text"],"properties":{"listing_id":{"type":"string","maxLength":36,"format":"uuid"},"listing2_id":{"type":"string","maxLength":36,"format":"uuid"},"text":{"type":"string","maxLength":100}}}'
su_q -c "set role service_role; insert into zsite.collections (site_id, name, rules, schema, recipient, \"references\") values ('$R', 'msgs', '{\"list\":[\"owner\",\"recipient\",\"admin\"],\"get\":[\"owner\",\"recipient\",\"admin\"],\"create\":[\"signed_in\"]}', '$MSG_SCHEMA', '{\"reference\":\"listing_id\"}', '{\"listing_id\":{\"collection\":\"listings\",\"on_delete\":\"cascade\"},\"listing2_id\":{\"collection\":\"listings\",\"on_delete\":\"cascade\"}}')" >/dev/null
M() { q authenticated "$1" "select api.create_record('msgs', '{\"listing_id\":\"$2\",\"listing2_id\":\"$3\",\"text\":\"$4\"}')->>'replayed'" >/dev/null; }
for i in 1 2 3; do M "$buyerR" "$LX" "$LY" "b$i"; done
M "$sellerR" "$LY" "$LX" "s1"; M "$sellerR" "$LY" "$LX" "s2"; M "$sellerR" "$LX" "$LY" "self"
SEEN="$DIR/msgs.txt"; : > "$SEEN"; CUR=""; PAGES=0
while :; do
  if [ -z "$CUR" ]; then PAGE=$(q authenticated "$sellerR" "select api.list_records('msgs', '{}', 2)")
  else PAGE=$(q authenticated "$sellerR" "select api.list_records('msgs', '{}', 2, '$CUR')"); fi
  echo "$PAGE" | python3 -c 'import sys,json; [print(i["data"]["text"]) for i in json.load(sys.stdin)["items"]]' >> "$SEEN"
  CUR=$(echo "$PAGE" | python3 -c 'import sys,json; c=json.load(sys.stdin)["next_cursor"]; print(c or "")')
  PAGES=$((PAGES+1)); [ -z "$CUR" ] || [ $PAGES -gt 10 ] && break
done
check "CX6 owner-or-recipient pages: 6 rows, each once (the self-addressed row is not duplicated)" \
  "$(wc -l < "$SEEN" | tr -d ' ') $(sort -u "$SEEN" | wc -l | tr -d ' ') $(sort "$SEEN" | paste -sd, -)" "6 6 b1,b2,b3,s1,s2,self"
check "CX7 a changed recipient definition moves access to the new target's owner" \
  "$(q service_role '{}' "update zsite.collections set recipient = '{\"reference\":\"listing2_id\"}' where site_id = '$R' and name = 'msgs'; select 'ok'" >/dev/null; su_q -c "select string_agg(distinct recipient_u1::text, ',') from zsite.records where site_id = '$R' and collection = 'msgs' and data->>'text' like 'b%'")" "$R_SELLER2"
check "CX7b ...the old recipient (seller) no longer lists the buyer's msgs" \
  "$(q authenticated "$sellerR" "select count(*) from jsonb_array_elements(api.list_records('msgs', '{}', 100)->'items') e where e->'data'->>'text' like 'b%'")" "0"

say ""
say "== v2 kernel: deleting an action-created record releases its capacity (0010) =="
NEWSLOT() { id_of "$(q authenticated "$sellerR" "select api.create_record('slots', jsonb_build_object('listing_id','$LX','starts_at','$1','capacity',$2))")"; }
CNT() { su_q -c "select data->>'booked_count' from zsite.records where id = '$1'"; }
RES() { q authenticated "$1" "select api.run_action('reserve_slot', '$2', null, '{}', '$3')->>'record_id'"; }
SP=$(NEWSLOT 2027-02-01T10:00:00Z 2)
BP=$(RES "$buyerR" "$SP" pd-reserve-00000001)
check "PD1 reserve then platform-delete the reservation: counter 1 -> 0, record gone" \
  "$(CNT $SP) $(q service_role '{}' "select zsite.k_platform_delete_record('$R', 'bookings', '$BP')->>'deleted'") $(CNT $SP) $(su_q -c "select count(*) from zsite.records where id = '$BP'")" "1 true 0 0"
BP2=$(RES "$buyerR" "$SP" pd-reserve-00000002)
check "PD1b the broker role may call it (account erasure)" \
  "$("${PSQL[@]}" -U zsite_broker -c "select zsite.k_platform_delete_record('$R', 'bookings', '$BP2')->>'deleted'" 2>&1) $(CNT $SP)" "true 0"
BP3=$(RES "$buyerR" "$SP" pd-reserve-00000003)
check_err "PD2 an end user cannot call the helper" \
  "$(q authenticated "$adminR" "select zsite.k_platform_delete_record('$R', 'bookings', '$BP3')")" "permission denied"
check_err "PD2b ...nor anon" \
  "$(q anon "$anonR" "select zsite.k_platform_delete_record('$R', 'bookings', '$BP3')")" "permission denied"
check_err "PD2c [via facade] the platform-delete marker cannot be forged" \
  "$(q authenticated "$buyerR" "select ztest.run(\$x\$insert into zsite.platform_delete_tx values (txid_current(), '$R') returning 1\$x\$)")" "permission denied"
check_err "PD2d [via facade] the release helper refuses a direct call" \
  "$(q authenticated "$buyerR" "select ztest.run(\$x\$select 'x' from zsite.k_release_deleted('bookings', gen_random_uuid()) f\$x\$)")" "not_in_trigger"
check "PD3 inverse first, then delete: the counter moves once" \
  "$(q authenticated "$buyerR" "select api.run_action('cancel_slot', null, '$BP3', '{}', 'pd-cancel-000000001')->>'counter'") $(q service_role '{}' "select zsite.k_platform_delete_record('$R', 'bookings', '$BP3')->>'deleted'") $(CNT $SP)" "0 true 0"
su_q -c "set role service_role; update zsite.collections set rules = rules || '{\"delete\":[\"owner\",\"admin\"]}' where site_id = '$R' and name = 'bookings'" >/dev/null
BP4=$(RES "$buyerR" "$SP" pd-reserve-00000004)
check "PD4 an end-user delete (rules allow it) releases too" \
  "$(CNT $SP) $(q authenticated "$buyerR" "select api.delete_record('bookings', '$BP4')->>'deleted'") $(CNT $SP)" "1 true 0"
BP5=$(RES "$buyerR" "$SP" pd-reserve-00000005)
check "PD4b a plain platform delete (archive purge / erasure SQL) releases too" \
  "$(su_q -c "set role service_role; delete from zsite.records where id = '$BP5' returning 1") $(CNT $SP)" "1 0"
check_err "PD4c a released hold cannot be inverted again (receipt says released)" \
  "$(q authenticated "$buyerR" "select api.run_action('cancel_slot', null, '$BP5', '{}', 'pd-cancel-000000002')")" "not_found"
LC=$(id_of "$(q authenticated "$sellerR" "select api.create_record('listings', '{\"title\":\"C\"}')")")
q authenticated "$sellerR" "select api.transition_record('listings', '$LC', 'published')" >/dev/null
SC=$(id_of "$(q authenticated "$sellerR" "select api.create_record('slots', jsonb_build_object('listing_id','$LC','starts_at','2027-03-01T10:00:00Z','capacity',3))")")
RES "$buyerR" "$SC" pd-reserve-00000006 >/dev/null; RES "$buyer2R" "$SC" pd-reserve-00000007 >/dev/null
check "PD5 cascade from the parent listing: slot + both reservations gone, every receipt released, no error" \
  "$(q service_role '{}' "select zsite.k_platform_delete_record('$R', 'listings', '$LC')->>'deleted'") $(su_q -c "select count(*) from zsite.records where site_id = '$R' and (id = '$SC' or ref1 = '$SC')") $(su_q -c "select count(*) from zsite.action_receipts where site_id = '$R' and result->>'target_id' = '$SC' and not coalesce((result->>'released')::boolean, false)")" "true 0 0"
RES "$buyerR" "$SP" pd-reserve-0000000a >/dev/null
check_err "PD5b an end-user delete of a slot that holds reservations is still restricted" \
  "$(q authenticated "$sellerR" "select api.delete_record('slots', '$SP')")" "reference_restricted"
SQ=$(NEWSLOT 2027-04-01T10:00:00Z 2)
BQ1=$(RES "$buyerR" "$SQ" pd-reserve-00000008); BQ2=$(RES "$buyer2R" "$SQ" pd-reserve-00000009)
"${PSQL[@]}" -U postgres -c "select pg_advisory_lock(4848), pg_sleep(3)" >/dev/null &
sleep 0.5
( q service_role '{}' "select pg_advisory_lock_shared(4848); select zsite.k_platform_delete_record('$R', 'bookings', '$BQ1')->>'deleted'" > "$DIR/pd_d1.out" ) &
( q service_role '{}' "select pg_advisory_lock_shared(4848); select zsite.k_platform_delete_record('$R', 'bookings', '$BQ2')->>'deleted'" > "$DIR/pd_d2.out" ) &
for i in 1 2 3 4; do
  ( q authenticated "$buyerR" "select pg_advisory_lock_shared(4848); select api.run_action('reserve_slot', '$SQ', null, '{}', 'pd-race-0000000$i')->>'counter'" > "$DIR/pd_r$i.out" ) &
done
wait
check "PD6 concurrent reserves + deletes at capacity: counter = live reservations, never above 2" \
  "$(CNT $SQ) $(su_q -c "select count(*) from zsite.records where site_id = '$R' and collection = 'bookings' and ref1 = '$SQ' and state = 'booked'") $(cat "$DIR"/pd_d*.out | grep -v "^$" | paste -sd, -)" \
  "$(su_q -c "select count(*) from zsite.records where site_id = '$R' and collection = 'bookings' and ref1 = '$SQ' and state = 'booked'") $(su_q -c "select count(*) from zsite.records where site_id = '$R' and collection = 'bookings' and ref1 = '$SQ' and state = 'booked'") true,true"
check "PD6b ...and the counter is within capacity" "$(su_q -c "select (data->>'booked_count')::int <= 2 from zsite.records where id = '$SQ'")" "t"

say ""
say "== v2 kernel: transition compare-and-set (0013 expect / set) =="
L6=$(id_of "$(q authenticated "$sellerR" "select api.create_record('listings', '{\"title\":\"Lamp\",\"price\":30}')")")
check_err "CS1 expect that does not hold -> transition_conflict" \
  "$(q authenticated "$sellerR" "select api.transition_record('listings', '$L6', 'published', '{\"price\":31}')")" "transition_conflict"
check "CS1b ...and nothing changed" "$(su_q -c "select state || ' ' || (data->>'price') from zsite.records where id = '$L6'")" "draft 30"
check "CS2 expect holds: the state and the set fields change together" \
  "$(q authenticated "$sellerR" "select api.transition_record('listings', '$L6', 'published', '{\"price\":30}', '{\"price\":99,\"title\":\"Lamp 2\"}')->>'transitioned'")" "true"
check "CS2b stored" "$(su_q -c "select state || ' ' || (data->>'price') || ' ' || (data->>'title') from zsite.records where id = '$L6'")" "published 99 Lamp 2"
check_err "CS3 a CAS into the state the record is already in is a conflict, not a silent no-op" \
  "$(q authenticated "$sellerR" "select api.transition_record('listings', '$L6', 'published', null, '{\"price\":1}')")" "transition_conflict"
check "CS3b ...and the set was not applied" "$(su_q -c "select data->>'price' from zsite.records where id = '$L6'")" "99"
check_err "CS4 set may not touch the state field" \
  "$(q authenticated "$sellerR" "select api.transition_record('listings', '$L6', 'archived', null, '{\"status\":\"draft\"}')")" "field_not_writable: status"
check_err "CS5 set of an undeclared field" \
  "$(q authenticated "$sellerR" "select api.transition_record('listings', '$L6', 'archived', null, '{\"nope\":1}')")" "field_not_writable: nope"
check_err "CS6 set is validated like any write (price minimum 0)" \
  "$(q authenticated "$sellerR" "select api.transition_record('listings', '$L6', 'archived', null, '{\"price\":-5}')")" "schema_violation"
check_err "CS7 expect on an undeclared field" \
  "$(q authenticated "$sellerR" "select api.transition_record('listings', '$L6', 'archived', '{\"nope\":1}')")" "invalid_transition"
RQ9=$(id_of "$(q authenticated "$buyerR" "select api.create_record('requests', '{\"listing_id\":\"$L6\",\"message\":\"hi\"}')")")
check_err "CS8 set needs the update rule too (the recipient may accept a request but not edit it)" \
  "$(q authenticated "$sellerR" "select api.transition_record('requests', '$RQ9', 'declined', null, '{\"message\":\"x\"}')")" "forbidden"
check_err "CS9 set of a reference field" \
  "$(q authenticated "$adminR" "select api.transition_record('requests', '$RQ9', 'declined', null, '{\"listing_id\":\"$L6\"}')")" "field_not_writable: listing_id"
check_err "CS10 an empty or non-object expect/set is refused" \
  "$(q authenticated "$sellerR" "select api.transition_record('listings', '$L6', 'archived', '[]')")" "invalid_transition"
check_err "CS11 a stranger's CAS is not_found, as before" \
  "$(q authenticated "$buyerR" "select api.transition_record('listings', '$L6', 'archived', '{\"price\":99}')")" "not_found"
L7=$(id_of "$(q authenticated "$sellerR" "select api.create_record('listings', '{\"title\":\"Race\",\"price\":1}')")")
"${PSQL[@]}" -U postgres -c "select pg_advisory_lock(4949), pg_sleep(2)" >/dev/null &
sleep 0.5
for i in 1 2 3; do
  ( q authenticated "$sellerR" "select pg_advisory_lock_shared(4949); select api.transition_record('listings', '$L7', 'published', '{\"price\":1}', '{\"price\":$((i + 10))}')->>'transitioned'" > "$DIR/cs_r$i.out" 2>&1 ) &
done
wait
check "CS12 three racing CAS on one edge: exactly one wins" \
  "$(cat "$DIR"/cs_r*.out | grep -c '^true$') $(cat "$DIR"/cs_r*.out | grep -c 'transition_conflict')" "1 2"

say "== v2 kernel: a site function drives a payment state machine (0013 + 0080 fn:<name>) =="
PAY_SCHEMA='{"type":"object","required":["status"],"properties":{"status":{"type":"string","maxLength":10,"enum":["pending","open","paid"]},"session":{"type":"string","maxLength":80},"amount":{"type":"integer","minimum":0}}}'
PAY_STATES='{"field":"status","values":["pending","open","paid"],"initial":"pending","transitions":[{"from":"pending","to":"open","principals":["fn:checkout"]},{"from":"open","to":"pending","principals":["fn:checkout","fn:hook"]},{"from":"open","to":"paid","principals":["fn:hook"]},{"from":"paid","to":"pending","principals":["owner","admin"]}]}'
PAY_RULES='{"list":["owner","admin","fn:checkout","fn:hook"],"get":["owner","admin","fn:checkout","fn:hook"],"create":["signed_in"],"update":["fn:checkout"],"delete":["admin"]}'
su_q -c "set role service_role; insert into zsite.collections (site_id, name, rules, schema, states) values ('$R', 'payorders', '$PAY_RULES', '$PAY_SCHEMA', '$PAY_STATES')" >/dev/null
fnCheckoutR="{\"role\":\"authenticated\",\"site_id\":\"$R\",\"sub\":\"f2000000-0000-4000-8000-0000000000a1\",\"zfn\":\"checkout\"}"
fnHookR="{\"role\":\"authenticated\",\"site_id\":\"$R\",\"sub\":\"f2000000-0000-4000-8000-0000000000a2\",\"zfn\":\"hook\"}"
fnOtherR="{\"role\":\"authenticated\",\"site_id\":\"$R\",\"sub\":\"f2000000-0000-4000-8000-0000000000a3\",\"zfn\":\"other\"}"
fnHookR2="{\"role\":\"authenticated\",\"site_id\":\"$R2\",\"sub\":\"f2000000-0000-4000-8000-0000000000a2\",\"zfn\":\"hook\"}"
PO=$(id_of "$(q authenticated "$buyerR" "select api.create_record('payorders', '{\"amount\":500}')")")
check "FT1 fn:checkout claims the order with a CAS (pending -> open, writes the session)" \
  "$(q authenticated "$fnCheckoutR" "select api.transition_record('payorders', '$PO', 'open', '{\"session\":null}', '{\"session\":\"cs_1\"}')->>'transitioned'")" "true"
check_err "FT2 a second claim of the same order loses (already open)" \
  "$(q authenticated "$fnCheckoutR" "select api.transition_record('payorders', '$PO', 'open', '{\"session\":null}', '{\"session\":\"cs_2\"}')")" "transition_conflict"
check_err "FT3 fn:checkout may not take the paid edge (only fn:hook is named)" \
  "$(q authenticated "$fnCheckoutR" "select api.transition_record('payorders', '$PO', 'paid', '{\"session\":\"cs_1\"}')")" "not_found"
check_err "FT4 an unnamed function cannot transition at all" \
  "$(q authenticated "$fnOtherR" "select api.transition_record('payorders', '$PO', 'paid', '{\"session\":\"cs_1\"}')")" "not_found"
check_err "FT5 the buyer (owner) cannot mark it paid" \
  "$(q authenticated "$buyerR" "select api.transition_record('payorders', '$PO', 'paid')")" "not_found"
check_err "FT6 fn:hook with a stale session id -> transition_conflict" \
  "$(q authenticated "$fnHookR" "select api.transition_record('payorders', '$PO', 'paid', '{\"session\":\"cs_old\",\"amount\":500}')")" "transition_conflict"
check_err "FT7 fn:hook with the wrong amount -> transition_conflict" \
  "$(q authenticated "$fnHookR" "select api.transition_record('payorders', '$PO', 'paid', '{\"session\":\"cs_1\",\"amount\":1}')")" "transition_conflict"
check "FT8 fn:hook marks it paid when session and amount match" \
  "$(q authenticated "$fnHookR" "select api.transition_record('payorders', '$PO', 'paid', '{\"session\":\"cs_1\",\"amount\":500}')->>'transitioned'")" "true"
check_err "FT9 a replayed paid event is a conflict, never a second move" \
  "$(q authenticated "$fnHookR" "select api.transition_record('payorders', '$PO', 'paid', '{\"session\":\"cs_1\",\"amount\":500}')")" "transition_conflict"
check_err "FT10 fn:hook cannot write fields (no update rule names it)" \
  "$(q authenticated "$fnHookR" "select api.transition_record('payorders', '$PO', 'pending', null, '{\"session\":\"x\"}')")" "forbidden"
check_err "FT11 a function never takes an owner-only edge (paid -> pending names owner/admin, not fn:checkout)" \
  "$(q authenticated "$fnCheckoutR" "select api.transition_record('payorders', '$PO', 'pending')")" "transition_conflict"
check_err "FT12 site R2's fn:hook cannot touch site R's order" \
  "$(q authenticated "$fnHookR2" "select api.transition_record('payorders', '$PO', 'pending')")" "not_found"
check "FT14 a function sees who placed the order (owner_id)" \
  "$(q authenticated "$fnHookR" "select api.get_record('payorders', '$PO')->>'owner_id'")" "$R_BUYER"
check "FT14b ...a member never does (only mine)" \
  "$(q authenticated "$buyerR" "select (api.get_record('payorders', '$PO') ? 'owner_id')::text || ' ' || (api.get_record('payorders', '$PO')->>'mine')")" "false true"
check "FT14c ...and list items carry it for the function too" \
  "$(q authenticated "$fnHookR" "select api.list_records('payorders')->'items'->0->>'owner_id'")" "$R_BUYER"
check "FT13 final row: paid, cs_1, 500" "$(su_q -c "select state || ' ' || (data->>'session') || ' ' || (data->>'amount') from zsite.records where id = '$PO'")" "paid cs_1 500"

say ""
say "== v2 kernel: roles and grants =="
check "KR1 zsite_kernel: no login, no BYPASSRLS, not superuser, owns no table" \
  "$(su_q -c "select r.rolcanlogin or r.rolbypassrls or r.rolsuper or exists (select 1 from pg_class c where c.relowner = r.oid) from pg_roles r where r.rolname = 'zsite_kernel'")" "f"
check "KR2 end users cannot execute any kernel function directly" \
  "$(su_q -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'zsite' and p.proname like 'k\_%' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))")" "0"
check "KR3 the kernel holds no column privilege on any derived slot" \
  "$(su_q -c "select count(*) from unnest(array['recipient_u1','uk1','uk2','uk3','uk4','state','ref1','ref2','ref3','ref4','site_id','idempotency_hash']) c, unnest(array['INSERT','UPDATE']) p where has_column_privilege('zsite_kernel', 'zsite.records', c, p) and not (c = 'site_id' and p = 'INSERT')")" "0"
check_err "KR4 [via facade] a buggy facade cannot finish a delete of a live record through the kernel" \
  "$(q authenticated "$sellerR" "select ztest.run(\$x\$select 'x' from zsite.k_ref_delete('listings', '$L2') f\$x\$)")" "not_deleted"
check "KR5 receipts and recipient windows are invisible to end users" \
  "$(q authenticated "$adminR" "select count(*) from zsite.action_receipts" | sed -E 's/^ERR: (permission denied).*/\1/')" "permission denied"
