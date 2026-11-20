begin;

create or replace function set_tenant_custom_domain(
  p_tenant_id               uuid,
  p_render_service_id       text,
  p_hostname                text,
  p_domain_type             text,
  p_render_custom_domain_id text,
  p_status                  text,
  p_dns_records             jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id   uuid;
  v_host text := lower(p_hostname);
begin
  if p_tenant_id is null or p_hostname is null or p_render_service_id is null then
    raise exception 'set_tenant_custom_domain: tenant_id, render_service_id and hostname are required'
      using errcode = '22023';
  end if;
  if auth.uid() is not null and not exists (
    select 1 from tenant_users
    where user_id = auth.uid() and tenant_id = p_tenant_id and role in ('owner', 'admin')
  ) then
    raise exception 'set_tenant_custom_domain: caller is not owner|admin of tenant %', p_tenant_id
      using errcode = '42501';
  end if;
  if v_host is distinct from p_hostname
     or length(v_host) > 253
     or v_host !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
     or v_host = 'localhost' or v_host like '%.localhost' or v_host like '%.local'
     or exists (
       select 1 from unnest(array['zaviagent.com', 'onrender.com', 'render.com']) as s(suffix)
       where v_host = s.suffix or v_host like '%.' || s.suffix
     )
  then
    raise exception 'set_tenant_custom_domain: invalid custom hostname %', p_hostname
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from tenant_resources
    where tenant_id = p_tenant_id
      and resource_kind = 'hosting'
      and mode = 'provisioned'
      and external_ref->>'render_service_id' = p_render_service_id
  ) then
    raise exception 'set_tenant_custom_domain: render service % is not tenant %''s hosting', p_render_service_id, p_tenant_id
      using errcode = '42501';
  end if;
  if auth.uid() is not null and coalesce(p_status, 'pending') not in ('pending', 'dns_required') then
    raise exception 'set_tenant_custom_domain: status % can only be set by verification', p_status
      using errcode = '42501';
  end if;
  insert into tenant_custom_domains (
    tenant_id, render_service_id, hostname, domain_type,
    render_custom_domain_id, status, dns_records, updated_at
  ) values (
    p_tenant_id, p_render_service_id, v_host, coalesce(p_domain_type, 'subdomain'),
    p_render_custom_domain_id, coalesce(p_status, 'pending'),
    coalesce(p_dns_records, '[]'::jsonb), now()
  )
  on conflict (hostname) do update
    set render_service_id       = excluded.render_service_id,
        domain_type             = excluded.domain_type,
        render_custom_domain_id = coalesce(excluded.render_custom_domain_id, tenant_custom_domains.render_custom_domain_id),
        status                  = excluded.status,
        dns_records             = excluded.dns_records,
        last_error              = null,
        updated_at              = now()
    where tenant_custom_domains.tenant_id = p_tenant_id
  returning id into v_id;
  return v_id;
end $$;

revoke all on function set_tenant_custom_domain(uuid, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function set_tenant_custom_domain(uuid, text, text, text, text, text, jsonb) to authenticated, service_role;

commit;
