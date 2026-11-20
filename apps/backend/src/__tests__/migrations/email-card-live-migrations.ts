import { readFileSync } from "node:fs";
import { join } from "node:path";

export const EMAIL_CARD_BOOTSTRAP = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create table tenants (id uuid primary key);
  create table tenant_users (tenant_id uuid not null, user_id uuid not null, role text not null default 'owner', primary key (tenant_id, user_id));
  create table channel_actions (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    channel_slug text not null default 'email_marketing',
    run_id uuid,
    status text not null default 'pending',
    status_at timestamptz,
    note text,
    exec_class text,
    exec_payload jsonb,
    exec_status text,
    exec_result jsonb,
    exec_progress jsonb,
    executed_at timestamptz,
    approved_by uuid,
    approved_by_source text,
    exec_claim_id uuid,
    exec_claimed_at timestamptz
  );
  create table channel_action_events (
    id bigint generated always as identity primary key,
    tenant_id uuid not null,
    action_id uuid not null references channel_actions(id) on delete cascade,
    event text not null,
    actor_kind text not null,
    actor_user_id uuid,
    run_id uuid,
    note text,
    event_key text not null,
    at timestamptz not null default now(),
    unique (action_id, event_key)
  );
  create table decisions (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    decision_class text,
    status text default 'proposed',
    body jsonb,
    approved_by uuid,
    rejected_by uuid,
    rejected_at timestamptz,
    approved_at timestamptz,
    approved_by_source text,
    dispatch_error text,
    dispatched_at timestamptz
  );
  -- Test-list marks (20261031191300) live in channel_settings.
  create table tenant_channels (tenant_id uuid not null, channel_slug text not null, primary key (tenant_id, channel_slug));
  create table channel_settings (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null, channel_slug text not null, field_id text not null, item text not null,
    status text null check (status is null or status in ('suggested', 'tracking', 'paused', 'dismissed')),
    updated_at timestamptz not null default now(), updated_by uuid null,
    unique (tenant_id, channel_slug, field_id, item),
    foreign key (tenant_id, channel_slug) references tenant_channels (tenant_id, channel_slug) on delete cascade
  );
  create table if not exists email_lists (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, name text not null default 'List', archived_at timestamptz);
`;

const dir = join(__dirname, "../../../../../supabase/migrations");

export const EMAIL_CARD_MIGRATIONS = [
  "20261031190300_email_card_approve_choke_point.sql",
  "20261031190500_email_card_approve.sql",
  "20261031190600_email_card_edit_and_outcomes.sql",
  "20261031190700_email_send_guards.sql",
  "20261031190800_email_send_freeze.sql",
  "20261031190900_email_card_retry_and_lanes.sql",
  "20261031191000_email_card_retry_one_predicate.sql",
  "20261031191300_email_test_list_marks.sql",
  "20261031191500_email_send_outcome_kind.sql",
  "20261101201000_email_planned_sends.sql",
] as const;

const DEFERRED_BODIES = new Set(["20261101201000_email_planned_sends.sql"]);

export const EMAIL_CARD_SQL: string[] = EMAIL_CARD_MIGRATIONS.map((f) => {
  const sql = readFileSync(join(dir, f), "utf8").replace(/^(begin|commit);$/gm, "");
  return DEFERRED_BODIES.has(f) ? `set local check_function_bodies = off;\n${sql}\nset local check_function_bodies = on;` : sql;
});
