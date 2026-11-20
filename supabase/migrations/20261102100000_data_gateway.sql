begin;

alter table public.tenant_db_config
  add column if not exists mode text not null default 'direct',
  add column if not exists disabled_tables text[] not null default '{}',
  add column if not exists hidden_fields text[] not null default '{}',
  add column if not exists unhidden_fields text[] not null default '{}',
  add column if not exists auto_hide boolean not null default false,
  add column if not exists settings_confirmed_at timestamptz,
  add column if not exists policy_catalog_hash text;
alter table public.tenant_db_config drop constraint if exists tenant_db_config_mode_check;
alter table public.tenant_db_config add constraint tenant_db_config_mode_check check (mode in ('direct', 'connector'));

drop policy if exists tenant_db_config_member_select on public.tenant_db_config;
drop policy if exists tenant_db_config_admin_select on public.tenant_db_config;
create policy tenant_db_config_admin_select on public.tenant_db_config
  for select to authenticated
  using (exists (select 1 from public.tenant_users tu
                  where tu.tenant_id = tenant_db_config.tenant_id and tu.user_id = auth.uid()
                    and tu.role in ('owner', 'admin')));
drop policy if exists tenant_db_config_active_tenant_restrict on public.tenant_db_config;
create policy tenant_db_config_active_tenant_restrict on public.tenant_db_config
  as restrictive for select using (tenant_id = (select public.app_active_tenant()));

create table if not exists public.data_access_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  caller_kind text not null check (caller_kind in ('agent', 'background', 'person')),
  agent_slug text,
  feature text,
  user_id uuid references auth.users(id) on delete set null,
  run_id uuid references public.agent_runs(id) on delete set null,
  tool_name text,
  mode text not null check (mode in ('direct', 'connector')),
  dialect text not null,
  operation text not null default 'read' check (operation in ('read', 'summary', 'structure_scan', 'connection_test')),
  query_text text not null,
  tables text[] not null default '{}',
  row_count integer not null default 0,
  sent_to_ai boolean not null default false,
  result text not null default 'pending' check (result in ('pending', 'allowed', 'refused', 'failed')),
  refused_by text check (refused_by in ('zavi', 'connector')),
  reason text,
  totals_only boolean not null default false,
  ms integer
);
comment on table public.data_access_log is
  'One row per customer-database read through the data gateway, reserved before the read runs. Owners/admins of the active tenant read it; the backend writes via tenantClient. Purged after 1 year.';
alter table public.data_access_log enable row level security;
revoke all on public.data_access_log from public, anon, authenticated;
grant select on public.data_access_log to authenticated;
drop policy if exists data_access_log_admin_select on public.data_access_log;
create policy data_access_log_admin_select on public.data_access_log
  for select to authenticated
  using (exists (select 1 from public.tenant_users tu
                  where tu.tenant_id = data_access_log.tenant_id and tu.user_id = auth.uid()
                    and tu.role in ('owner', 'admin')));
drop policy if exists data_access_log_active_tenant_restrict on public.data_access_log;
create policy data_access_log_active_tenant_restrict on public.data_access_log
  as restrictive for select using (tenant_id = (select public.app_active_tenant()));
create index if not exists data_access_log_tenant_time_idx on public.data_access_log (tenant_id, created_at desc);

create or replace function public._reset_db_policy_for_transition(p_tenant_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.tenant_db_catalog where tenant_id = p_tenant_id;
  update public.tenant_db_config
     set auto_hide = true, settings_confirmed_at = null, updated_at = now()
   where tenant_id = p_tenant_id;
end $$;
revoke all on function public._reset_db_policy_for_transition(uuid) from public, anon, authenticated;
grant execute on function public._reset_db_policy_for_transition(uuid) to service_role;

commit;
