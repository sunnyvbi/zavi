
alter table public.tenant_sandbox
  add column if not exists lease_holder_run_id uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists needs_recreate_reason text;

comment on column public.tenant_sandbox.lease_holder_run_id is
  'Run currently holding the exclusive hygiene lease on this sandbox (GC / destroy / recreate). NULL = unleased. TTL-bounded via lease_expires_at so a crashed holder cannot wedge the row.';
comment on column public.tenant_sandbox.lease_expires_at is
  'When the hygiene lease lapses. A lease at/after this instant is stealable by the next run.';
comment on column public.tenant_sandbox.needs_recreate_reason is
  'Typed remediation INTENT recorded by a run that hit an infra wall (e.g. insufficient_disk). run-agent NEVER destroys; it only records intent here. ALL destroy/recreate happens in the single leased resolveSandboxForRun path, which consumes and clears this.';

create or replace function public.try_lease_sandbox(
  p_id uuid,
  p_tenant_id uuid,
  p_holder_run_id uuid,
  p_ttl_seconds integer default 120
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  update public.tenant_sandbox
     set lease_holder_run_id = p_holder_run_id,
         lease_expires_at    = now() + make_interval(secs => greatest(p_ttl_seconds, 1)),
         updated_at          = now()
   where id = p_id
     and tenant_id = p_tenant_id
     and (
       lease_holder_run_id is null
       or lease_expires_at is null
       or lease_expires_at < now()
       or lease_holder_run_id = p_holder_run_id
     );
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

create or replace function public.release_sandbox_lease(
  p_id uuid,
  p_tenant_id uuid,
  p_holder_run_id uuid
) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.tenant_sandbox
     set lease_holder_run_id = null,
         lease_expires_at    = null,
         updated_at          = now()
   where id = p_id
     and tenant_id = p_tenant_id
     and lease_holder_run_id = p_holder_run_id;
$$;

create or replace function public.mark_sandbox_needs_recreate(
  p_tenant_id uuid,
  p_repo_full_name text,
  p_reason text
) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.tenant_sandbox
     set needs_recreate_reason = p_reason,
         updated_at = now()
   where tenant_id = p_tenant_id
     and repo_full_name = p_repo_full_name;
$$;

create or replace function public.clear_sandbox_needs_recreate(
  p_id uuid,
  p_tenant_id uuid
) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.tenant_sandbox
     set needs_recreate_reason = null,
         updated_at = now()
   where id = p_id
     and tenant_id = p_tenant_id;
$$;

create or replace function public.destroy_sandbox_row_cas(
  p_id uuid,
  p_tenant_id uuid,
  p_e2b_sandbox_id text
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  update public.tenant_sandbox
     set status = 'destroyed',
         lease_holder_run_id = null,
         lease_expires_at = null,
         updated_at = now()
   where id = p_id
     and tenant_id = p_tenant_id
     and e2b_sandbox_id = p_e2b_sandbox_id;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.try_lease_sandbox(uuid, uuid, uuid, integer) from public;
grant execute on function public.try_lease_sandbox(uuid, uuid, uuid, integer) to service_role;
revoke all on function public.release_sandbox_lease(uuid, uuid, uuid) from public;
grant execute on function public.release_sandbox_lease(uuid, uuid, uuid) to service_role;
revoke all on function public.mark_sandbox_needs_recreate(uuid, text, text) from public;
grant execute on function public.mark_sandbox_needs_recreate(uuid, text, text) to service_role;
revoke all on function public.clear_sandbox_needs_recreate(uuid, uuid) from public;
grant execute on function public.clear_sandbox_needs_recreate(uuid, uuid) to service_role;
revoke all on function public.destroy_sandbox_row_cas(uuid, uuid, text) from public;
grant execute on function public.destroy_sandbox_row_cas(uuid, uuid, text) to service_role;
