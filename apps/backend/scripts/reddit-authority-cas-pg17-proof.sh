#!/usr/bin/env bash
set -euo pipefail
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../../../supabase/migrations"
DIR="$(mktemp -d -t reddit-authority-cas-pg17)"
trap 'rm -rf "$DIR"' EXIT
"$PGBIN/initdb" -D "$DIR/data" -U postgres >/dev/null
strip() { sed -e '/^begin;$/d' -e '/^commit;$/d' "$1"; printf '\n\n'; }
{
cat <<'SQL'
create role anon; create role authenticated; create role service_role;
create table tenants (id uuid primary key);
create table channel_actions (tenant_id uuid not null, id uuid not null primary key, proposed_at timestamptz not null default now(), exec_class text, exec_payload jsonb, status text not null default 'pending', exec_status text, unique (tenant_id, id));
create table reddit_ad_authority (tenant_id uuid not null references tenants(id), ad_account_id text not null, limits jsonb not null, action_id uuid not null, foreign key (tenant_id, action_id) references channel_actions(tenant_id, id), updated_at timestamptz not null default now(), primary key (tenant_id, ad_account_id));
insert into tenants values ('00000000-0000-0000-0000-00000000000a');
insert into channel_actions (tenant_id, id, proposed_at, exec_class, exec_payload, status) values
 ('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a1','2026-10-12 09:00+00','reddit_ads.authorize_account','{"ad_account_id":"acct"}','acted'),
 ('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a2','2026-10-12 10:00+00','reddit_ads.authorize_account','{"ad_account_id":"acct"}','acted'),
 ('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a3','2026-10-12 11:00+00','reddit_ads.authorize_account','{"ad_account_id":"other"}','acted');
insert into reddit_ad_authority values ('00000000-0000-0000-0000-00000000000a','acct','{"v":0}','00000000-0000-0000-0000-0000000000a1', now());

SQL
if [ "${CONTROL:-0}" = "1" ]; then strip "$MIG/20261101150000_reddit_authority_cas.sql" | sed 's/   where a.action_id = excluded.action_id/   where true or a.action_id = excluded.action_id/'; else strip "$MIG/20261101150000_reddit_authority_cas.sql"; fi
strip "$MIG/20261101130000_reddit_one_open_authorize_card.sql"
cat <<'SQL'
do $$
declare r jsonb; t uuid := '00000000-0000-0000-0000-00000000000a';
begin
  if (select source_proposed_at from reddit_ad_authority) is distinct from '2026-10-12 09:00+00'::timestamptz then raise exception 'FAIL backfill'; end if;
  r := save_reddit_ad_authority(t, 'acct', '{"v":2}', '00000000-0000-0000-0000-0000000000a2');
  if r->>'ok' is distinct from 'true' then raise exception 'FAIL newer card: %', r; end if;
  r := save_reddit_ad_authority(t, 'acct', '{"v":1}', '00000000-0000-0000-0000-0000000000a1');
  if r->>'code' is distinct from 'superseded' then raise exception 'FAIL older card after newer: %', r; end if;
  if (select limits->>'v' from reddit_ad_authority) is distinct from '2' then raise exception 'FAIL older card overwrote'; end if;
  r := save_reddit_ad_authority(t, 'acct', '{"v":22}', '00000000-0000-0000-0000-0000000000a2');
  if r->>'ok' is distinct from 'true' then raise exception 'FAIL same card re-run: %', r; end if;
  r := save_reddit_ad_authority(t, 'acct', '{"v":3}', '00000000-0000-0000-0000-0000000000a3');
  if r->>'code' is distinct from 'card_not_found' then raise exception 'FAIL other-account card: %', r; end if;
  r := save_reddit_ad_authority('00000000-0000-0000-0000-00000000000b', 'acct', '{"v":4}', '00000000-0000-0000-0000-0000000000a2');
  if r->>'code' is distinct from 'card_not_found' then raise exception 'FAIL cross-tenant card: %', r; end if;
  insert into channel_actions (tenant_id, id, exec_class, exec_payload, status, exec_status) values (t, '00000000-0000-0000-0000-0000000000b1', 'reddit_ads.authorize_account', '{"ad_account_id":"acct"}', 'pending', 'failed');
  begin
    insert into channel_actions (tenant_id, id, exec_class, exec_payload, status) values (t, '00000000-0000-0000-0000-0000000000b2', 'reddit_ads.authorize_account', '{"ad_account_id":"acct"}', 'snoozed');
    raise exception 'FAIL second open authorize card allowed';
  exception when unique_violation then null; end;
  insert into channel_actions (tenant_id, id, exec_class, exec_payload, status) values (t, '00000000-0000-0000-0000-0000000000b3', 'reddit_ads.authorize_account', '{"ad_account_id":"other"}', 'snoozed');
  if has_function_privilege('authenticated', 'public.save_reddit_ad_authority(uuid, text, jsonb, uuid)', 'execute') then raise exception 'FAIL authenticated may execute'; end if;
end $$;

select 'ALL_CASES_PASSED' as s;

SQL
} > "$DIR/run.sql"
OUT="$("$PGBIN/postgres" --single -j -D "$DIR/data" postgres < "$DIR/run.sql" 2>&1 || true)"
if echo "$OUT" | grep -q "ERROR"; then echo "$OUT" | grep "ERROR"; echo "PROOF FAILED"; exit 1; fi
echo "$OUT" | grep -q "ALL_CASES_PASSED" && echo "PROOF PASSED" || { echo "PROOF FAILED (no sentinel)"; exit 1; }
