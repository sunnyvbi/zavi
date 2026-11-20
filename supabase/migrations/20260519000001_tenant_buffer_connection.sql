
create table if not exists tenant_buffer_connection (
  tenant_id        uuid primary key references tenants(id) on delete cascade,
  workspace_id     text not null,
  profile_ids      text[] not null default array[]::text[],
  scopes           text[] not null default array[]::text[],
  vault_secret_name text not null,
  last_revoked_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table tenant_buffer_connection enable row level security;

drop policy if exists tenant_buffer_connection_service_all on tenant_buffer_connection;
create policy tenant_buffer_connection_service_all
  on tenant_buffer_connection
  to service_role
  using (true)
  with check (true);

drop policy if exists tenant_buffer_connection_owner_select on tenant_buffer_connection;
create policy tenant_buffer_connection_owner_select
  on tenant_buffer_connection
  for select
  to authenticated
  using (
    exists (
      select 1 from tenant_users
      where tenant_users.tenant_id = tenant_buffer_connection.tenant_id
        and tenant_users.user_id = auth.uid()
    )
  );

create or replace function get_buffer_connection(p_tenant_id uuid)
returns table (
  workspace_id text,
  profile_ids text[],
  scopes text[],
  refresh_token text,
  last_revoked_at timestamptz
)
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  return query
    select
      c.workspace_id,
      c.profile_ids,
      c.scopes,
      vs.decrypted_secret::text,
      c.last_revoked_at
    from tenant_buffer_connection c
    join vault.decrypted_secrets vs on vs.name = c.vault_secret_name
    where c.tenant_id = p_tenant_id;
end;
$$;

revoke all on function get_buffer_connection(uuid) from public, anon, authenticated;
grant execute on function get_buffer_connection(uuid) to service_role;

create or replace function tenant_buffer_connection_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_tenant_buffer_connection_touch on tenant_buffer_connection;
create trigger trg_tenant_buffer_connection_touch
  before update on tenant_buffer_connection
  for each row execute function tenant_buffer_connection_touch_updated_at();
