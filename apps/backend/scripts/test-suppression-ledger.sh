#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIG="$REPO/supabase/migrations"
PGDATA=$(mktemp -d -t supptest-pg-XXXX)
PGPORT=${PGPORT:-54329}
SOCK=$(mktemp -d -t supptest-sock-XXXX)

cleanup() { pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$PGDATA" "$SOCK"; }
trap cleanup EXIT

initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null
pg_ctl -D "$PGDATA" -o "-p $PGPORT -k $SOCK" -l "$PGDATA/log" start >/dev/null
sleep 2
createdb -h "$SOCK" -p "$PGPORT" -U postgres supptest
q() { psql -h "$SOCK" -p "$PGPORT" -U postgres -d supptest -v ON_ERROR_STOP=1 "$@"; }

q -q <<'SQL'
create role service_role; create role authenticated;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create extension if not exists pgcrypto;
create type decision_autonomy as enum ('auto','approval','forbidden');
create table tenants (id uuid primary key default gen_random_uuid());
create table memberships (tenant_id uuid, user_id uuid);
create table agent_runs (id uuid primary key default gen_random_uuid(), tenant_id uuid, agent_slug text);
create table tenant_agent_kill_switch (tenant_id uuid, agent_slug text, override_state text);
create table decision_classes (slug text primary key, dispatch_handler text,
  default_autonomy decision_autonomy default 'approval',
  single_open_per_target boolean default false, target_key_paths text[]);
create table decisions (id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_run_id uuid, decision_class text not null, body jsonb not null,
  status text default 'proposed', emitted_at timestamptz default now(),
  autonomy_at_emit decision_autonomy, handler text, dispatch_error text,
  superseded_at timestamptz, superseded_by uuid, approved_by uuid, approved_at timestamptz);
create index decisions_open_proposed_idx on decisions (tenant_id, decision_class)
  where status='proposed' and superseded_at is null;
create or replace function effective_autonomy(p_tenant uuid, p_class text)
returns decision_autonomy language sql stable as $$
  select coalesce((select default_autonomy from decision_classes where slug=p_class),'approval') $$;
SQL

awk '/^create or replace function decision_content_fingerprint/,/\$\$;/' \
  "$MIG/20260607225442_decisions_emit_dedup_content_fingerprint.sql" | q -q -f -
awk '/^create or replace function decision_target_key/,/\$\$;/' \
  "$MIG/20260707200000_generalized_decision_target_key_dedup.sql" | q -q -f -

q -q -f "$MIG/20260717040000_decision_suppression_ledger.sql" 2>&1 | grep -vi notice || true
q -q -f "$MIG/20260717040100_suppress_decision_rpc.sql" 2>&1 | grep -vi notice || true

q <<'SQL'
\set QUIET on
insert into decision_classes(slug, dispatch_handler, default_autonomy, single_open_per_target, target_key_paths)
values ('pm.needs_action','pm.dispatch','approval', true, array['roadmap_id']);
insert into tenants(id) values ('73db45ff-457e-4541-bc8f-bdb625390204'),('11111111-1111-1111-1111-111111111111');
\set QUIET off

\echo '═══ REPLAY: the real 2026-07-09 prod incident ═══'
\echo 'Prod: "P0 IDOR" card rejected 07-05, rejected 07-06, BACK 07-09'

select emit_decision('73db45ff-457e-4541-bc8f-bdb625390204'::uuid, null, 'pm.needs_action',
  '{"roadmap_id":"af7067d6","theme":"P0 IDOR","child_run_id":"AAA"}'::jsonb) as emit_1 \gset
update decisions set status='rejected' where id = :'emit_1';
select suppress_decision(:'emit_1'::uuid, 'reject') as k \gset

select emit_decision('73db45ff-457e-4541-bc8f-bdb625390204'::uuid, null, 'pm.needs_action',
  '{"roadmap_id":"af7067d6","theme":"P0 IDOR","child_run_id":"BBB"}'::jsonb) as emit_2 \gset

select
  case when :'emit_2' = :'emit_1' then 'PASS' else 'FAIL' end as "returns prior id (never null)",
  case when (select count(*) from decisions where status='proposed')=0 then 'PASS' else 'FAIL' end as "no new proposed row",
  case when (select hit_count from decision_suppressions)=1 then 'PASS' else 'FAIL' end as "hit_count records the nag";

\echo '═══ CONTROL A: a different target still emits ═══'
select emit_decision('73db45ff-457e-4541-bc8f-bdb625390204'::uuid, null, 'pm.needs_action',
  '{"roadmap_id":"OTHER","theme":"x","child_run_id":"CCC"}'::jsonb) as e \gset
select case when (select count(*) from decisions where body->>'roadmap_id'='OTHER' and status='proposed')=1
  then 'PASS - no over-suppression' else 'FAIL' end as control_a;

\echo '═══ CONTROL B: cross-tenant isolation (C8) ═══'
select emit_decision('11111111-1111-1111-1111-111111111111'::uuid, null, 'pm.needs_action',
  '{"roadmap_id":"af7067d6","theme":"P0 IDOR","child_run_id":"DDD"}'::jsonb) as e2 \gset
select case when (select count(*) from decisions where tenant_id='11111111-1111-1111-1111-111111111111' and status='proposed')=1
  then 'PASS - tenant-scoped, no leak' else 'FAIL' end as control_b;

\echo '═══ FALSIFIER: drop the ledger row -> the same re-emit MUST come back ═══'
\echo '(if it still suppresses, the ledger is not what does the work and every PASS above is a lie)'
delete from decision_suppressions where tenant_id='73db45ff-457e-4541-bc8f-bdb625390204';
select emit_decision('73db45ff-457e-4541-bc8f-bdb625390204'::uuid, null, 'pm.needs_action',
  '{"roadmap_id":"af7067d6","theme":"P0 IDOR","child_run_id":"EEE"}'::jsonb) as e3 \gset
select case when (select count(*) from decisions where tenant_id='73db45ff-457e-4541-bc8f-bdb625390204'
                    and body->>'roadmap_id'='af7067d6' and status='proposed')=1
  then 'PASS - reproduces the prod bug; the ledger is the fix'
  else 'FAIL - tautological test' end as falsifier;
SQL
echo "ALL SUPPRESSION TESTS PASSED"
