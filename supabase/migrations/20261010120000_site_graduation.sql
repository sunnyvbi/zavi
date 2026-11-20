
begin;

create table if not exists public.site_graduations (
  site_id            uuid primary key references public.sites (id) on delete cascade,
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  state              text not null default 'requested'
                     check (state in ('requested', 'suspended', 'project_ready', 'imported', 'verified',
                                      'switched', 'archived', 'rolled_back', 'build_dedicated')),
  reason             text not null check (reason in ('capability', 'founder', 'staff', 'load', 'size')),
  capabilities       text[] not null default '{}',
  source_shard_id    uuid references public.site_shards (id) on delete set null,
  source_project_ref text,
  target_project_ref text check (target_project_ref is null or target_project_ref ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  target_url         text check (target_url is null or target_url ~ '^https://[a-z0-9]{8,40}\.supabase\.co$'),
  counts             jsonb not null default '{}'::jsonb,
  sha256             text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  attempts           integer not null default 0,
  last_error         text,
  lease_until        timestamptz,
  requested_at       timestamptz not null default now(),
  switched_at        timestamptz,
  archive_after      timestamptz,
  frozen_at          timestamptz,
  updated_at         timestamptz not null default now()
);
create index if not exists site_graduations_due_idx on public.site_graduations (updated_at)
  where state not in ('archived', 'rolled_back', 'build_dedicated');

alter table public.site_graduations enable row level security;
revoke all on public.site_graduations from public, anon, authenticated;

create table if not exists public.site_member_role_events (
  id            bigint generated always as identity primary key,
  site_id       uuid not null references public.sites (id) on delete cascade,
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  manifest_hash text not null,
  shard_ref     text not null check (shard_ref ~ '^[a-z0-9]{8,40}$'),
  demoted       integer not null check (demoted > 0),
  audit_action  text not null default 'set_role' check (audit_action = 'set_role'),
  created_at    timestamptz not null default now(),
  unique (site_id, manifest_hash)
);
alter table public.site_member_role_events enable row level security;
revoke all on public.site_member_role_events from public, anon, authenticated;

alter table public.site_shards add column if not exists dedicated_site_id uuid references public.sites (id) on delete set null;
create unique index if not exists site_shards_dedicated_site_uq on public.site_shards (dedicated_site_id) where dedicated_site_id is not null;
alter table public.site_shards drop constraint if exists site_shards_name_check;
alter table public.site_shards drop constraint if exists site_shards_name_shape;
alter table public.site_shards add constraint site_shards_name_shape
  check (name ~ '^zavi-shard-(prod|dev)-([0-9]{1,6}|k[0-9a-f]{32})$');
alter table public.site_shards drop constraint if exists site_shards_kernel_never_open;
alter table public.site_shards add constraint site_shards_kernel_never_open
  check (dedicated_site_id is null or (state <> 'open' and max_sites = 1));
alter table public.site_shards drop constraint if exists site_shards_kernel_name;
alter table public.site_shards add constraint site_shards_kernel_name
  check (dedicated_site_id is null or name ~ '-k[0-9a-f]{32}$');

alter table public.sites add column if not exists kernel_shard_id uuid references public.site_shards (id) on delete restrict;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sites_kernel_is_dedicated'
                 and conrelid = 'public.sites'::regclass) then
    alter table public.sites add constraint sites_kernel_is_dedicated
      check (kernel_shard_id is null or backend_mode = 'dedicated');
  end if;
end $$;

create or replace function public.site_kernel_register(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_env       text,
  p_region    text
) returns public.site_shards
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_site public.sites;
  v_row  public.site_shards;
  v_name text;
begin
  if p_tenant_id is null or p_site_id is null or p_env is null or p_region is null then
    raise exception 'site_kernel_register: tenant, site, env and region are required' using errcode = '22023';
  end if;
  select * into v_site from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'site_kernel_register: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  if v_site.supabase_project_ref is null then
    raise exception 'site_kernel_register: site % has no project of its own yet', p_site_id using errcode = '55000';
  end if;
  v_name := 'zavi-shard-' || p_env || '-k' || replace(p_site_id::text, '-', '');
  insert into public.site_shards (env, name, region, project_ref, url, state, max_sites, site_count, dedicated_site_id)
  values (p_env, v_name, p_region, v_site.supabase_project_ref, 'https://' || v_site.supabase_project_ref || '.supabase.co',
          'provisioning', 1, 1, p_site_id)
  on conflict (name) do nothing;
  select * into v_row from public.site_shards sh where sh.name = v_name;
  if v_row.dedicated_site_id is distinct from p_site_id or v_row.project_ref is distinct from v_site.supabase_project_ref
     or v_row.env <> p_env then
    raise exception 'site_kernel_register: kernel shard % does not match the site', v_name using errcode = '42501';
  end if;
  return v_row;
end $$;

revoke all on function public.site_kernel_register(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.site_kernel_register(uuid, uuid, text, text) to service_role;

create or replace function public.site_kernel_ready(
  p_tenant_id uuid,
  p_site_id   uuid
) returns public.site_shards
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row public.site_shards;
begin
  perform 1 from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'site_kernel_ready: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  update public.site_shards sh set state = 'full', updated_at = now()
   where sh.dedicated_site_id = p_site_id and sh.provision_step = 'done' and sh.state in ('provisioning', 'full')
  returning * into v_row;
  if not found then
    raise exception 'site_kernel_ready: the kernel shard of % is not fully provisioned', p_site_id using errcode = '55000';
  end if;
  return v_row;
end $$;

revoke all on function public.site_kernel_ready(uuid, uuid) from public, anon, authenticated;
grant execute on function public.site_kernel_ready(uuid, uuid) to service_role;

create or replace function public.site_kernel_retire(
  p_tenant_id uuid,
  p_site_id   uuid
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_site public.sites;
  v_row  public.site_shards;
begin
  select * into v_site from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'site_kernel_retire: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  if v_site.status not in ('deleting', 'deleted', 'failed', 'fell_back_old') then
    raise exception 'site_kernel_retire: site % is not being deleted', p_site_id using errcode = '55000';
  end if;
  select * into v_row from public.site_shards sh where sh.dedicated_site_id = p_site_id for update;
  if not found then
    update public.sites s set kernel_shard_id = null where s.id = p_site_id and s.kernel_shard_id is not null;
    return null;
  end if;
  if v_row.name !~ '-k[0-9a-f]{32}$' or v_row.max_sites <> 1 then
    raise exception 'site_kernel_retire: % is not a one-site kernel shard', v_row.name using errcode = '42501';
  end if;
  delete from vault.secrets vs where vs.id in (select ss.vault_secret_id from public.site_shard_secrets ss where ss.shard_id = v_row.id);
  delete from public.site_shard_secrets ss where ss.shard_id = v_row.id;
  update public.sites s set kernel_shard_id = null where s.id = p_site_id;
  delete from public.site_shards sh where sh.id = v_row.id;
  return v_row.project_ref;
end $$;

revoke all on function public.site_kernel_retire(uuid, uuid) from public, anon, authenticated;
grant execute on function public.site_kernel_retire(uuid, uuid) to service_role;

create or replace function public.site_kernel_ref(
  p_tenant_id uuid,
  p_site_id   uuid
) returns text
language sql security definer
set search_path = pg_catalog, pg_temp as $$
  select sh.project_ref from public.site_shards sh join public.sites s on s.id = sh.dedicated_site_id
   where s.id = p_site_id and s.tenant_id = p_tenant_id and sh.name ~ '-k[0-9a-f]{32}$'
$$;

revoke all on function public.site_kernel_ref(uuid, uuid) from public, anon, authenticated;
grant execute on function public.site_kernel_ref(uuid, uuid) to service_role;

create or replace function public.site_backend_dedicate_static(
  p_tenant_id    uuid,
  p_site_id      uuid,
  p_capabilities text[]
) returns public.sites
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row public.sites;
begin
  if p_tenant_id is null or p_site_id is null then
    raise exception 'site_backend_dedicate_static: tenant_id and site_id are required' using errcode = '22023';
  end if;
  select * into v_row from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'site_backend_dedicate_static: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  if v_row.backend_mode = 'dedicated' then
    return v_row;
  end if;
  if v_row.backend_mode <> 'static' or v_row.shard_id is not null or v_row.gateway_binding is not null
     or exists (select 1 from public.site_providers sp
                 where sp.site_id = p_site_id and sp.tenant_id = p_tenant_id and sp.kind = 'pooled_backend') then
    raise exception 'site_backend_dedicate_static: site % already has pooled data; it must graduate', p_site_id using errcode = '55000';
  end if;
  update public.sites s set backend_mode = 'dedicated', updated_at = now()
   where s.id = p_site_id and s.tenant_id = p_tenant_id
  returning * into v_row;
  insert into public.site_graduations (site_id, tenant_id, state, reason, capabilities)
  values (p_site_id, p_tenant_id, 'build_dedicated', 'capability', coalesce(p_capabilities, '{}'))
  on conflict (site_id) do nothing;
  return v_row;
end $$;

revoke all on function public.site_backend_dedicate_static(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function public.site_backend_dedicate_static(uuid, uuid, text[]) to service_role;

create or replace function public.site_graduation_request(
  p_tenant_id    uuid,
  p_site_id      uuid,
  p_reason       text,
  p_capabilities text[]
) returns public.site_graduations
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_site public.sites;
  v_row  public.site_graduations;
  v_ref  text;
begin
  if p_tenant_id is null or p_site_id is null or p_reason is null then
    raise exception 'site_graduation_request: tenant_id, site_id and reason are required' using errcode = '22023';
  end if;
  select * into v_site from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'site_graduation_request: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  select * into v_row from public.site_graduations g where g.site_id = p_site_id for update;
  if found and v_row.state not in ('rolled_back', 'build_dedicated') then
    return v_row;
  end if;
  if v_site.backend_mode <> 'pooled' or v_site.shard_id is null then
    raise exception 'site_graduation_request: site % is not pooled', p_site_id using errcode = '55000';
  end if;
  select sh.project_ref into v_ref from public.site_shards sh where sh.id = v_site.shard_id;
  insert into public.site_graduations (site_id, tenant_id, state, reason, capabilities, source_shard_id, source_project_ref)
  values (p_site_id, p_tenant_id, 'requested', p_reason, coalesce(p_capabilities, '{}'), v_site.shard_id, v_ref)
  on conflict (site_id) do update set
    state = 'requested', reason = excluded.reason, capabilities = excluded.capabilities,
    source_shard_id = excluded.source_shard_id, source_project_ref = excluded.source_project_ref,
    target_project_ref = null, target_url = null, counts = '{}'::jsonb, sha256 = null, last_error = null, frozen_at = null,
    lease_until = null, requested_at = now(), switched_at = null, archive_after = null, updated_at = now()
  returning * into v_row;
  return v_row;
end $$;

revoke all on function public.site_graduation_request(uuid, uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.site_graduation_request(uuid, uuid, text, text[]) to service_role;

create or replace function public.site_graduation_get(
  p_tenant_id uuid,
  p_site_id   uuid
) returns setof public.site_graduations
language sql security definer
set search_path = pg_catalog, pg_temp as $$
  select g.* from public.site_graduations g
   where g.site_id = p_site_id and g.tenant_id = p_tenant_id
$$;

revoke all on function public.site_graduation_get(uuid, uuid) from public, anon, authenticated;
grant execute on function public.site_graduation_get(uuid, uuid) to service_role;

create or replace function public.site_graduation_claim(
  p_tenant_id     uuid,
  p_site_id       uuid,
  p_lease_seconds integer
) returns setof public.site_graduations
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_lease_seconds is null or p_lease_seconds < 10 or p_lease_seconds > 3600 then
    raise exception 'site_graduation_claim: lease must be 10..3600 seconds' using errcode = '22023';
  end if;
  return query
  update public.site_graduations g
     set lease_until = now() + make_interval(secs => p_lease_seconds), attempts = g.attempts + 1, updated_at = now()
   where g.site_id = p_site_id and g.tenant_id = p_tenant_id
     and g.state not in ('archived', 'rolled_back', 'build_dedicated')
     and (g.lease_until is null or g.lease_until < now())
  returning g.*;
end $$;

revoke all on function public.site_graduation_claim(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.site_graduation_claim(uuid, uuid, integer) to service_role;

create or replace function public.site_graduation_advance(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_from      text,
  p_to        text,
  p_patch     jsonb
) returns setof public.site_graduations
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
begin
  if jsonb_typeof(v_patch) <> 'object'
     or (v_patch - array['target_project_ref', 'target_url', 'counts', 'sha256', 'last_error', 'archive_after', 'frozen_at']) <> '{}'::jsonb then
    raise exception 'site_graduation_advance: patch has keys outside the allowlist' using errcode = '22023';
  end if;
  if not ((p_from, p_to) in (('requested', 'project_ready'), ('project_ready', 'suspended'), ('suspended', 'imported'),
                             ('imported', 'verified'), ('imported', 'suspended'), ('switched', 'archived'),
                             ('requested', 'requested'), ('suspended', 'suspended'), ('project_ready', 'project_ready'),
                             ('imported', 'imported'), ('verified', 'verified'), ('switched', 'switched'),
                             ('requested', 'rolled_back'), ('suspended', 'rolled_back'), ('project_ready', 'rolled_back'),
                             ('imported', 'rolled_back'), ('verified', 'rolled_back'))) then
    raise exception 'site_graduation_advance: % -> % is not a graduation step', p_from, p_to using errcode = '22023';
  end if;
  return query
  update public.site_graduations g set
    state              = p_to,
    target_project_ref = case when v_patch ? 'target_project_ref' then v_patch->>'target_project_ref' else g.target_project_ref end,
    target_url         = case when v_patch ? 'target_url' then v_patch->>'target_url' else g.target_url end,
    counts             = case when v_patch ? 'counts' then v_patch->'counts' else g.counts end,
    sha256             = case when v_patch ? 'sha256' then v_patch->>'sha256' else g.sha256 end,
    last_error         = case when v_patch ? 'last_error' then left(v_patch->>'last_error', 500) else g.last_error end,
    archive_after      = case when v_patch ? 'archive_after' then (v_patch->>'archive_after')::timestamptz else g.archive_after end,
    frozen_at          = case when v_patch ? 'frozen_at' then (v_patch->>'frozen_at')::timestamptz else g.frozen_at end,
    lease_until        = case when p_to in ('archived', 'rolled_back') then null else g.lease_until end,
    updated_at         = now()
   where g.site_id = p_site_id and g.tenant_id = p_tenant_id and g.state = p_from
  returning g.*;
end $$;

revoke all on function public.site_graduation_advance(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.site_graduation_advance(uuid, uuid, text, text, jsonb) to service_role;

create or replace function public.site_graduation_switch(
  p_tenant_id             uuid,
  p_site_id               uuid,
  p_expected_host_version bigint,
  p_binding               jsonb,
  p_archive_after         timestamptz
) returns public.sites
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_site   public.sites;
  v_grad   public.site_graduations;
  v_kernel uuid;
begin
  if p_tenant_id is null or p_site_id is null or p_expected_host_version is null or p_binding is null or p_archive_after is null then
    raise exception 'site_graduation_switch: every argument is required' using errcode = '22023';
  end if;
  select * into v_site from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'site_graduation_switch: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  select * into v_grad from public.site_graduations g where g.site_id = p_site_id and g.tenant_id = p_tenant_id for update;
  if not found or v_grad.state <> 'verified' then
    raise exception 'site_graduation_switch: graduation of % is not verified', p_site_id using errcode = '55000';
  end if;
  if v_site.backend_mode <> 'pooled' or v_site.shard_id is distinct from v_grad.source_shard_id then
    raise exception 'site_graduation_switch: site % is not on its source shard', p_site_id using errcode = '55000';
  end if;
  if v_site.host_version <> p_expected_host_version then
    raise exception 'site_graduation_switch: host_version_conflict' using errcode = '40001';
  end if;
  if p_binding->>'shard_id' is distinct from v_grad.target_project_ref
     or p_binding->>'shard_url' is distinct from v_grad.target_url
     or p_binding->>'status' <> 'active' then
    raise exception 'site_graduation_switch: the binding is not the verified target' using errcode = '22023';
  end if;
  if v_site.gateway_binding->>'status' = 'tombstoned' then
    raise exception 'site_graduation_switch: the hostname binding is tombstoned' using errcode = '55000';
  end if;
  select sh.id into v_kernel from public.site_shards sh
   where sh.dedicated_site_id = p_site_id and sh.project_ref = v_grad.target_project_ref and sh.state = 'full';
  if v_kernel is null then
    raise exception 'site_graduation_switch: the kernel shard of % is not ready', p_site_id using errcode = '55000';
  end if;
  update public.site_shards sh set site_count = greatest(sh.site_count - 1, 0), updated_at = now()
   where sh.id = v_site.shard_id;
  update public.sites s set
    shard_id        = null,
    backend_mode    = 'dedicated',
    kernel_shard_id = v_kernel,
    gateway_binding = p_binding,
    host_version    = s.host_version + 1,
    updated_at      = now()
  where s.id = p_site_id and s.tenant_id = p_tenant_id
  returning * into v_site;
  update public.site_graduations g set state = 'switched', switched_at = now(), archive_after = p_archive_after,
         updated_at = now()
   where g.site_id = p_site_id;
  return v_site;
end $$;

revoke all on function public.site_graduation_switch(uuid, uuid, bigint, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.site_graduation_switch(uuid, uuid, bigint, jsonb, timestamptz) to service_role;

create or replace function public.site_graduation_due(
  p_limit integer
) returns table (tenant_id uuid, site_id uuid, state text)
language sql security definer
set search_path = pg_catalog, pg_temp as $$
  select g.tenant_id, g.site_id, g.state from public.site_graduations g
   where g.state not in ('archived', 'rolled_back', 'build_dedicated')
     and (g.lease_until is null or g.lease_until < now())
   order by g.updated_at
   limit least(greatest(coalesce(p_limit, 20), 1), 200)
$$;

revoke all on function public.site_graduation_due(integer) from public, anon, authenticated;
grant execute on function public.site_graduation_due(integer) to service_role;

create or replace function public.site_graduation_request_by_site(
  p_site_id uuid,
  p_reason  text
) returns setof public.site_graduations
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_tenant uuid;
begin
  if p_reason not in ('load', 'size', 'staff') then
    raise exception 'site_graduation_request_by_site: only load / size / staff requests' using errcode = '22023';
  end if;
  select s.tenant_id into v_tenant from public.sites s where s.id = p_site_id and s.backend_mode = 'pooled';
  if v_tenant is null then
    return;
  end if;
  return query select * from public.site_graduation_request(v_tenant, p_site_id, p_reason, '{}'::text[]);
end $$;

revoke all on function public.site_graduation_request_by_site(uuid, text) from public, anon, authenticated;
grant execute on function public.site_graduation_request_by_site(uuid, text) to service_role;

create or replace function public.site_graduation_status(
  p_site_id uuid
) returns setof public.site_graduations
language sql security definer
set search_path = pg_catalog, pg_temp as $$
  select g.* from public.site_graduations g where g.site_id = p_site_id
$$;

revoke all on function public.site_graduation_status(uuid) from public, anon, authenticated;
grant execute on function public.site_graduation_status(uuid) to service_role;

create or replace function public.site_member_role_audit_record(
  p_tenant_id     uuid,
  p_site_id       uuid,
  p_manifest_hash text,
  p_shard_ref     text,
  p_demoted       integer
) returns integer
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_n integer;
begin
  if p_tenant_id is null or p_site_id is null or p_manifest_hash is null or p_shard_ref is null or coalesce(p_demoted, 0) < 1 then
    raise exception 'site_member_role_audit_record: bad arguments' using errcode = '22023';
  end if;
  perform 1 from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'site_member_role_audit_record: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  insert into public.site_member_role_events (site_id, tenant_id, manifest_hash, shard_ref, demoted)
  values (p_site_id, p_tenant_id, p_manifest_hash, p_shard_ref, p_demoted)
  on conflict (site_id, manifest_hash) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.site_member_role_audit_record(uuid, uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.site_member_role_audit_record(uuid, uuid, text, text, integer) to service_role;

create table if not exists public.site_backend_settings (
  site_id                   uuid primary key references public.sites (id) on delete cascade,
  tenant_id                 uuid not null references public.tenants (id) on delete cascade,
  max_records               bigint  check (max_records is null or max_records between 0 and 100000000),
  max_bytes                 bigint  check (max_bytes is null or max_bytes between 0 and 1099511627776),
  max_writes_per_min        integer check (max_writes_per_min is null or max_writes_per_min between 0 and 1000000),
  recipient_creates_per_min integer check (recipient_creates_per_min is null or recipient_creates_per_min between 1 and 30),
  turnstile_enabled         boolean,
  turnstile_site_key        text check (turnstile_site_key is null or turnstile_site_key ~ '^[0-9A-Za-z_-]{10,100}$'),
  turnstile_secret_id       uuid,
  updated_by                uuid,
  updated_at                timestamptz not null default now()
);
alter table public.site_backend_settings enable row level security;
revoke all on public.site_backend_settings from public, anon, authenticated;

create table if not exists public.site_backend_settings_events (
  id            bigint generated always as identity primary key,
  site_id       uuid not null references public.sites (id) on delete cascade,
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  actor_user_id uuid not null,
  actor_email   text,
  changes       jsonb not null,
  created_at    timestamptz not null default now()
);
alter table public.site_backend_settings_events enable row level security;
revoke all on public.site_backend_settings_events from public, anon, authenticated;

alter table public.sites add column if not exists gateway_config jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sites_gateway_config_shape'
                 and conrelid = 'public.sites'::regclass) then
    alter table public.sites add constraint sites_gateway_config_shape check (
      gateway_config is null or (
        jsonb_typeof(gateway_config) = 'object'
        and (gateway_config - 'turnstile'::text) = '{}'::jsonb
        and jsonb_typeof(gateway_config->'turnstile') = 'object'
        and ((gateway_config->'turnstile') - array['enabled', 'site_key']) = '{}'::jsonb
        and jsonb_typeof(gateway_config->'turnstile'->'enabled') = 'boolean'
        and jsonb_typeof(gateway_config->'turnstile'->'site_key') in ('string', 'null')));
  end if;
end $$;

create or replace function public.site_backend_settings_set(
  p_site_id         uuid,
  p_actor_user_id   uuid,
  p_actor_email     text,
  p_patch           jsonb,
  p_turnstile_secret text,
  p_clear_secret    boolean
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_site   public.sites;
  v_old    public.site_backend_settings;
  v_new    public.site_backend_settings;
  v_patch  jsonb := coalesce(p_patch, '{}'::jsonb);
  v_secret uuid;
  v_change jsonb := '{}'::jsonb;
  k        text;
begin
  if p_site_id is null or p_actor_user_id is null then
    raise exception 'site_backend_settings_set: site and actor are required' using errcode = '22023';
  end if;
  if jsonb_typeof(v_patch) <> 'object'
     or (v_patch - array['max_records', 'max_bytes', 'max_writes_per_min', 'recipient_creates_per_min',
                         'turnstile_enabled', 'turnstile_site_key']) <> '{}'::jsonb then
    raise exception 'site_backend_settings_set: patch has keys outside the allowlist' using errcode = '22023';
  end if;
  if p_turnstile_secret is not null and (length(p_turnstile_secret) < 10 or length(p_turnstile_secret) > 200) then
    raise exception 'site_backend_settings_set: the Turnstile secret must be 10..200 chars' using errcode = '22023';
  end if;
  if p_turnstile_secret is not null and coalesce(p_clear_secret, false) then
    raise exception 'site_backend_settings_set: set OR clear the secret, not both' using errcode = '22023';
  end if;
  select * into v_site from public.sites s where s.id = p_site_id for update;
  if not found then
    raise exception 'site_backend_settings_set: site % not found', p_site_id using errcode = 'P0002';
  end if;
  if v_site.status in ('deleting', 'deleted') then
    raise exception 'site_backend_settings_set: site % is %', p_site_id, v_site.status using errcode = '55000';
  end if;

  insert into public.site_backend_settings (site_id, tenant_id) values (p_site_id, v_site.tenant_id)
  on conflict (site_id) do nothing;
  select * into v_old from public.site_backend_settings b where b.site_id = p_site_id for update;

  update public.site_backend_settings b set
    max_records = case when v_patch ? 'max_records' then (v_patch->>'max_records')::bigint else b.max_records end,
    max_bytes = case when v_patch ? 'max_bytes' then (v_patch->>'max_bytes')::bigint else b.max_bytes end,
    max_writes_per_min = case when v_patch ? 'max_writes_per_min' then (v_patch->>'max_writes_per_min')::integer else b.max_writes_per_min end,
    recipient_creates_per_min = case when v_patch ? 'recipient_creates_per_min' then (v_patch->>'recipient_creates_per_min')::integer else b.recipient_creates_per_min end,
    turnstile_enabled = case when v_patch ? 'turnstile_enabled' then (v_patch->>'turnstile_enabled')::boolean else b.turnstile_enabled end,
    turnstile_site_key = case when v_patch ? 'turnstile_site_key' then v_patch->>'turnstile_site_key' else b.turnstile_site_key end,
    updated_by = p_actor_user_id,
    updated_at = now()
  where b.site_id = p_site_id;

  if p_turnstile_secret is not null then
    v_secret := vault.create_secret(p_turnstile_secret);
    update public.site_backend_settings b set turnstile_secret_id = v_secret where b.site_id = p_site_id;
    if v_old.turnstile_secret_id is not null then delete from vault.secrets vs where vs.id = v_old.turnstile_secret_id; end if;
    v_change := v_change || jsonb_build_object('turnstile_secret', 'set');
  elsif coalesce(p_clear_secret, false) and v_old.turnstile_secret_id is not null then
    update public.site_backend_settings b set turnstile_secret_id = null where b.site_id = p_site_id;
    delete from vault.secrets vs where vs.id = v_old.turnstile_secret_id;
    v_change := v_change || jsonb_build_object('turnstile_secret', 'cleared');
  end if;

  select * into v_new from public.site_backend_settings b where b.site_id = p_site_id;
  foreach k in array array['max_records', 'max_bytes', 'max_writes_per_min', 'recipient_creates_per_min',
                           'turnstile_enabled', 'turnstile_site_key'] loop
    if (to_jsonb(v_old)->k) is distinct from (to_jsonb(v_new)->k) then
      v_change := v_change || jsonb_build_object(k, jsonb_build_object('from', to_jsonb(v_old)->k, 'to', to_jsonb(v_new)->k));
    end if;
  end loop;
  insert into public.site_backend_settings_events (site_id, tenant_id, actor_user_id, actor_email, changes)
  values (p_site_id, v_site.tenant_id, p_actor_user_id, left(p_actor_email, 320), v_change);

  update public.sites s set
    gateway_config = jsonb_build_object('turnstile', jsonb_build_object(
      'enabled', coalesce(v_new.turnstile_enabled, true), 'site_key', v_new.turnstile_site_key)),
    host_version = s.host_version + 1,
    updated_at = now()
  where s.id = p_site_id
  returning * into v_site;

  return (to_jsonb(v_new) - 'turnstile_secret_id')
    || jsonb_build_object('turnstile_secret_set', v_new.turnstile_secret_id is not null,
                          'shard_id', coalesce(v_site.shard_id, v_site.kernel_shard_id), 'host_version', v_site.host_version, 'changes', v_change);
end $$;

revoke all on function public.site_backend_settings_set(uuid, uuid, text, jsonb, text, boolean) from public, anon, authenticated;
grant execute on function public.site_backend_settings_set(uuid, uuid, text, jsonb, text, boolean) to service_role;

create or replace function public.site_backend_settings_get(
  p_site_id uuid
) returns jsonb
language sql security definer
set search_path = pg_catalog, pg_temp as $$
  select (to_jsonb(b) - 'turnstile_secret_id') || jsonb_build_object('turnstile_secret_set', b.turnstile_secret_id is not null)
    from public.site_backend_settings b where b.site_id = p_site_id
$$;

revoke all on function public.site_backend_settings_get(uuid) from public, anon, authenticated;
grant execute on function public.site_backend_settings_get(uuid) to service_role;

create or replace function public.site_backend_turnstile_secret(
  p_site_id uuid
) returns text
language sql security definer
set search_path = pg_catalog, pg_temp as $$
  select ds.decrypted_secret
    from public.site_backend_settings b
    join public.sites s on s.id = b.site_id and s.tenant_id = b.tenant_id
    join vault.decrypted_secrets ds on ds.id = b.turnstile_secret_id
   where b.site_id = p_site_id
     and s.status not in ('deleting', 'deleted')
     and coalesce(b.turnstile_enabled, true)
$$;

revoke all on function public.site_backend_turnstile_secret(uuid) from public, anon, authenticated;
grant execute on function public.site_backend_turnstile_secret(uuid) to service_role;

create or replace function public.site_shard_record_metrics(
  p_id               uuid,
  p_metrics          jsonb
) returns public.site_shards
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row  public.site_shards;
  v_load numeric;
  v_bad  text;
  m      jsonb := coalesce(p_metrics, '{}'::jsonb);
begin
  if p_id is null or jsonb_typeof(m) <> 'object' then
    raise exception 'site_shard_record_metrics: id and an object are required' using errcode = '22023';
  end if;
  select k into v_bad from jsonb_object_keys(m) k
   where k <> all (array['records', 'bytes', 'requests_per_min', 'p95_ms', 'cpu_pct', 'connections',
                         'auth_users', 'sessions', 'emails_per_hour'])
      or jsonb_typeof(m->k) not in ('number', 'null')
      or (jsonb_typeof(m->k) = 'number' and (m->>k)::numeric < 0)
   limit 1;
  if v_bad is not null then
    raise exception 'site_shard_record_metrics: bad metric %', v_bad using errcode = '22023';
  end if;
  update public.site_shards s set
    m_records          = coalesce((m->>'records')::bigint, s.m_records),
    m_bytes            = coalesce((m->>'bytes')::bigint, s.m_bytes),
    m_requests_per_min = coalesce((m->>'requests_per_min')::integer, s.m_requests_per_min),
    m_p95_ms           = coalesce((m->>'p95_ms')::integer, s.m_p95_ms),
    m_cpu_pct          = coalesce((m->>'cpu_pct')::numeric, s.m_cpu_pct),
    m_connections      = coalesce((m->>'connections')::integer, s.m_connections),
    m_auth_users       = coalesce((m->>'auth_users')::bigint, s.m_auth_users),
    m_sessions         = coalesce((m->>'sessions')::bigint, s.m_sessions),
    m_emails_per_hour  = coalesce((m->>'emails_per_hour')::integer, s.m_emails_per_hour),
    metrics_at         = now(),
    updated_at         = now()
  where s.id = p_id
  returning * into v_row;
  if not found then
    raise exception 'site_shard_record_metrics: shard % not found', p_id using errcode = 'P0002';
  end if;
  v_load := public.site_shard_load(v_row);
  if v_row.state = 'open' and v_load >= v_row.fill_ratio and v_row.dedicated_site_id is null then
    update public.site_shards s set state = 'full', updated_at = now() where s.id = p_id returning * into v_row;
  elsif v_row.state = 'full' and v_load < v_row.fill_ratio * 0.9 and v_row.dedicated_site_id is null then
    update public.site_shards s set state = 'open', updated_at = now() where s.id = p_id returning * into v_row;
  end if;
  return v_row;
end $$;

revoke all on function public.site_shard_record_metrics(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.site_shard_record_metrics(uuid, jsonb) to service_role;

create or replace function public.site_host_bump(
  p_tenant_id   uuid,
  p_site_id     uuid,
  p_set_binding boolean,
  p_binding     jsonb
) returns public.sites
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row public.sites;
begin
  if p_tenant_id is null or p_site_id is null then
    raise exception 'site_host_bump: tenant_id and site_id are required' using errcode = '22023';
  end if;
  select * into v_row from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'site_host_bump: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  if coalesce(p_set_binding, false) and v_row.gateway_binding->>'status' = 'tombstoned'
     and coalesce(p_binding->>'status', '') <> 'tombstoned' then
    raise exception 'site_host_bump: the hostname binding is tombstoned' using errcode = '55000';
  end if;
  if coalesce(p_set_binding, false) and p_binding is not null and coalesce(p_binding->>'status', '') <> 'tombstoned'
     and p_binding->>'shard_id' is distinct from (
       select sh.project_ref from public.site_shards sh where sh.id = coalesce(v_row.shard_id, v_row.kernel_shard_id)) then
    raise exception 'site_host_bump: binding_not_current' using errcode = '55000';
  end if;
  update public.sites s set
    host_version    = s.host_version + 1,
    gateway_binding = case when coalesce(p_set_binding, false) then p_binding else s.gateway_binding end,
    updated_at      = now()
  where s.id = p_site_id and s.tenant_id = p_tenant_id
  returning * into v_row;
  return v_row;
end $$;

revoke all on function public.site_host_bump(uuid, uuid, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.site_host_bump(uuid, uuid, boolean, jsonb) to service_role;

commit;
