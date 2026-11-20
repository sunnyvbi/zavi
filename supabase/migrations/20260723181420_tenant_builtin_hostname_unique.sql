
begin;

create unique index if not exists tenant_resources_builtin_hostname_uq
  on tenant_resources (lower(external_ref->>'hostname'))
  where resource_kind = 'domain' and (external_ref->>'hostname') is not null;

create or replace function set_tenant_builtin_domain(
  p_tenant_id    uuid,
  p_external_ref jsonb,
  p_status       text default 'ready'
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_tenant_id is null then
    raise exception 'set_tenant_builtin_domain: tenant_id is required' using errcode = '22023';
  end if;
  if auth.uid() is not null and not exists (
    select 1 from tenant_users
    where user_id = auth.uid() and tenant_id = p_tenant_id and role in ('owner', 'admin')
  ) then
    raise exception 'set_tenant_builtin_domain: caller is not owner|admin of tenant %', p_tenant_id
      using errcode = '42501';
  end if;
  insert into tenant_resources (
    tenant_id, resource_kind, mode, status, provider, external_ref, updated_at
  ) values (
    p_tenant_id, 'domain', 'provisioned', coalesce(p_status, 'ready'),
    'render+cloudflare', coalesce(p_external_ref, '{}'::jsonb), now()
  )
  on conflict (tenant_id, resource_kind) do update
    set mode         = 'provisioned',
        status       = coalesce(excluded.status, tenant_resources.status),
        provider     = 'render+cloudflare',
        external_ref = excluded.external_ref,
        updated_at   = now();
end $$;
revoke all on function set_tenant_builtin_domain(uuid, jsonb, text) from public, anon;
grant execute on function set_tenant_builtin_domain(uuid, jsonb, text) to authenticated, service_role;

commit;
