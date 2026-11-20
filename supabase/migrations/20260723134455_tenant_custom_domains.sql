
begin;

create table if not exists tenant_custom_domains (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references tenants(id) on delete cascade,
  render_service_id        text not null,
  hostname                 text not null,
  domain_type              text not null default 'subdomain'
                             check (domain_type in ('subdomain', 'apex')),
  render_custom_domain_id  text,
  status                   text not null default 'pending'
                             check (status in ('pending', 'dns_required', 'verifying', 'verified', 'failed')),
  dns_records              jsonb not null default '[]'::jsonb,
  attempts                 int not null default 0,
  next_check_at            timestamptz,
  last_checked_at          timestamptz,
  last_error               text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (hostname)
);

create index if not exists tenant_custom_domains_tenant_idx
  on tenant_custom_domains (tenant_id);
create index if not exists tenant_custom_domains_sweep_idx
  on tenant_custom_domains (status, next_check_at);

alter table tenant_custom_domains enable row level security;
drop policy if exists tenant_custom_domains_select on tenant_custom_domains;
create policy tenant_custom_domains_select on tenant_custom_domains
  for select using (
    exists (
      select 1 from tenant_users
      where user_id = auth.uid() and tenant_id = tenant_custom_domains.tenant_id
    )
  );

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
declare v_id uuid;
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
  insert into tenant_custom_domains (
    tenant_id, render_service_id, hostname, domain_type,
    render_custom_domain_id, status, dns_records, updated_at
  ) values (
    p_tenant_id, p_render_service_id, p_hostname, coalesce(p_domain_type, 'subdomain'),
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
revoke all on function set_tenant_custom_domain(uuid, text, text, text, text, text, jsonb) from public, anon;
grant execute on function set_tenant_custom_domain(uuid, text, text, text, text, text, jsonb) to authenticated, service_role;

create or replace function set_tenant_custom_domain_state(
  p_id                      uuid,
  p_status                  text,
  p_render_custom_domain_id text default null,
  p_dns_records             jsonb default null,
  p_attempts                int default null,
  p_next_check_at           timestamptz default null,
  p_last_error              text default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null and not exists (
    select 1 from tenant_custom_domains d
    join tenant_users tu on tu.tenant_id = d.tenant_id
    where d.id = p_id and tu.user_id = auth.uid() and tu.role in ('owner', 'admin')
  ) then
    raise exception 'set_tenant_custom_domain_state: caller is not owner|admin of the domain''s tenant'
      using errcode = '42501';
  end if;
  update tenant_custom_domains
    set status                  = coalesce(p_status, status),
        render_custom_domain_id = coalesce(p_render_custom_domain_id, render_custom_domain_id),
        dns_records             = coalesce(p_dns_records, dns_records),
        attempts                = coalesce(p_attempts, attempts),
        next_check_at           = coalesce(p_next_check_at, next_check_at),
        last_error              = p_last_error,
        last_checked_at         = now(),
        updated_at              = now()
    where id = p_id;
end $$;
revoke all on function set_tenant_custom_domain_state(uuid, text, text, jsonb, int, timestamptz, text) from public, anon;
grant execute on function set_tenant_custom_domain_state(uuid, text, text, jsonb, int, timestamptz, text) to authenticated, service_role;

create or replace function delete_tenant_custom_domain(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null and not exists (
    select 1 from tenant_custom_domains d
    join tenant_users tu on tu.tenant_id = d.tenant_id
    where d.id = p_id and tu.user_id = auth.uid() and tu.role in ('owner', 'admin')
  ) then
    raise exception 'delete_tenant_custom_domain: caller is not owner|admin of the domain''s tenant'
      using errcode = '42501';
  end if;
  delete from tenant_custom_domains where id = p_id;
end $$;
revoke all on function delete_tenant_custom_domain(uuid) from public, anon;
grant execute on function delete_tenant_custom_domain(uuid) to authenticated, service_role;

commit;
