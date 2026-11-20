
alter table tenants
  add column if not exists sandbox_keepalive_enabled boolean not null default true;

comment on column tenants.sandbox_keepalive_enabled is
  'Per-tenant flag. When TRUE, e2b sandbox stays active between agent runs and auto-pauses only after 50min idle. Saves the ~4s/GiB pause cost between rapid-fire runs. Default TRUE; tenant flips via set_tenant_sandbox_keepalive(p_tenant_id, p_enabled) RPC.';

create or replace function set_tenant_sandbox_keepalive(
  p_tenant_id uuid,
  p_enabled boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not exists (
    select 1
    from tenant_users
    where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of tenant %', p_tenant_id;
  end if;

  update tenants
     set sandbox_keepalive_enabled = p_enabled
   where id = p_tenant_id;

  return p_enabled;
end;
$$;

revoke all on function set_tenant_sandbox_keepalive(uuid, boolean) from public;
grant execute on function set_tenant_sandbox_keepalive(uuid, boolean) to authenticated;
