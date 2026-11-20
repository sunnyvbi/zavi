
begin;

alter table profiles
  add column if not exists deleted_at timestamptz;

comment on column profiles.deleted_at is
  'Set when the person deleted their account in-app. The lockout is NOT enforced here — it comes from the GoTrue soft delete plus the removal of every tenant_users row (requireAuth then 403s). This column is the marker the purge worker and staff reads go by.';

alter table tenants
  add column if not exists deleted_at timestamptz;

comment on column tenants.deleted_at is
  'Set when the workspace''s ONLY member deleted their account, so it is awaiting purge. Nothing polls this column: the workspace is already inert because its tenant_users rows are gone (nobody can auth into it) and its tenant_agent_schedules rows were disabled (no cron fires). Treat it as "pending purge", not as a live gate.';

create table if not exists account_deletions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  email_sha256 text,
  source text not null default 'api',
  requested_at timestamptz not null default now(),
  purge_after timestamptz not null,
  purged_at timestamptz,
  status text not null default 'soft_deleted',
  deleted_tenant_ids uuid[] not null default '{}',
  left_tenant_ids uuid[] not null default '{}',
  teardown_errors text[] not null default '{}',
  constraint account_deletions_source_chk
    check (source in ('mobile', 'web', 'api', 'staff')),
  constraint account_deletions_status_chk
    check (status in ('soft_deleted', 'purged', 'failed'))
);

comment on table account_deletions is
  'One row per in-app account deletion (App Store 5.1.1(v)). Audit trail + the queue the 30-day purge works from. Service-role only: RLS on, no policies.';

create index if not exists account_deletions_due
  on account_deletions (purge_after)
  where purged_at is null;

create index if not exists account_deletions_user
  on account_deletions (user_id, requested_at desc);

alter table account_deletions enable row level security;
revoke all on table account_deletions from anon, authenticated;

create or replace function purge_tenant_credentials(p_tenant_id uuid)
returns integer
language plpgsql security definer set search_path = public, vault, pg_temp as $$
declare
  v_secret record;
  v_purged integer := 0;
begin
  if p_tenant_id is null then
    raise exception 'purge_tenant_credentials: tenant_id is required';
  end if;

  for v_secret in
    select vault_secret_id from secrets where tenant_id = p_tenant_id
  loop
    delete from vault.secrets where id = v_secret.vault_secret_id;
    v_purged := v_purged + 1;
  end loop;

  delete from secrets where tenant_id = p_tenant_id;
  delete from connector_metadata where tenant_id = p_tenant_id;

  update tenant_mcp_servers set enabled = false where tenant_id = p_tenant_id;

  return v_purged;
end $$;

comment on function purge_tenant_credentials(uuid) is
  'Deletes every Vault secret + connector_metadata row for one tenant and disables its MCP servers. Account-deletion teardown only (routes/account). Returns the number of Vault secrets removed.';

revoke all on function purge_tenant_credentials(uuid) from public, anon, authenticated;

commit;
