begin;

create or replace function get_or_create_tenant_sandbox(
  p_tenant_id uuid,
  p_repo_full_name text
) returns public.tenant_sandbox
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row             public.tenant_sandbox;
  v_connected       boolean;
  v_provisioned     boolean;
  v_site            boolean;
begin
  if p_tenant_id is null or p_repo_full_name is null or length(p_repo_full_name) = 0 then
    raise exception 'get_or_create_tenant_sandbox: tenant_id + repo_full_name required'
      using errcode = '22023';
  end if;

  select exists(
    select 1
      from connector_metadata
      where tenant_id = p_tenant_id
        and slug      = 'github'
        and repo_full_names is not null
        and p_repo_full_name = any(repo_full_names)
  ) into v_connected;

  select exists(
    select 1
      from tenant_resources
      where tenant_id     = p_tenant_id
        and resource_kind = 'repo'
        and mode          = 'provisioned'
        and external_ref->>'github_full_name' = p_repo_full_name
  ) into v_provisioned;

  select exists(
    select 1
      from public.sites s
      where s.tenant_id        = p_tenant_id
        and s.github_full_name = p_repo_full_name
        and s.status not in ('failed', 'fell_back_old', 'deleting', 'deleted')
  ) into v_site;

  if not (v_connected or v_provisioned or v_site) then
    raise exception 'get_or_create_tenant_sandbox: repo % not in tenant connected repos', p_repo_full_name
      using errcode = '22023';
  end if;

  select * into v_row
    from public.tenant_sandbox
    where tenant_id = p_tenant_id and repo_full_name = p_repo_full_name;

  if found then
    return v_row;
  end if;

  insert into public.tenant_sandbox (tenant_id, repo_full_name, status)
    values (p_tenant_id, p_repo_full_name, 'creating')
    returning * into v_row;

  return v_row;
end $$;

revoke all on function public.get_or_create_tenant_sandbox(uuid, text) from public, anon, authenticated;
grant execute on function public.get_or_create_tenant_sandbox(uuid, text) to service_role;

commit;
