
begin;

create table if not exists public.sites (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  root_conductor_run_id uuid references public.conductor_runs(id) on delete set null,
  started_by_user_id    uuid,
  owner_email           text,
  label                 text not null,
  hostname              text not null,
  github_full_name      text,
  supabase_project_ref  text,
  supabase_url          text,
  status                text not null default 'provisioning'
    check (status in ('provisioning', 'building', 'publishing', 'live', 'paused',
                      'waking', 'failed', 'fell_back_old', 'deleting', 'deleted')),
  live_url              text,
  desired_sha           text,
  live_sha              text,
  live_deploy_id        text,
  last_visit_at         timestamptz,
  last_edit_at          timestamptz,
  paused_at             timestamptz,
  last_error            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index if not exists sites_label_uq on public.sites (label);
create unique index if not exists sites_hostname_uq on public.sites (hostname);
create unique index if not exists sites_root_run_uq
  on public.sites (root_conductor_run_id) where root_conductor_run_id is not null;
create unique index if not exists sites_github_full_name_uq
  on public.sites (lower(github_full_name)) where github_full_name is not null;
create index if not exists sites_tenant_idx on public.sites (tenant_id, created_at desc);
create index if not exists sites_live_idle_idx on public.sites (status) where status = 'live';

alter table public.sites enable row level security;
drop policy if exists sites_select on public.sites;
create policy sites_select on public.sites
  for select using (
    exists (select 1 from public.tenant_users tu
            where tu.user_id = auth.uid() and tu.tenant_id = sites.tenant_id)
  );

create table if not exists public.site_providers (
  site_id    uuid not null references public.sites(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  kind       text not null
    check (kind in ('github_repo', 'supabase_project', 'cloudflare_host', 'r2_prefix')),
  state      text not null default 'claimed'
    check (state in ('claimed', 'created', 'cleanup_pending', 'delete_scheduled', 'delete_issuing', 'deleted')),
  ref        jsonb not null default '{}'::jsonb,
  scheduled_delete_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (site_id, kind),
  constraint site_providers_scheduled_has_time
    check (state not in ('delete_scheduled', 'delete_issuing') or scheduled_delete_at is not null)
);

create index if not exists site_providers_tenant_idx on public.site_providers (tenant_id);
create index if not exists site_providers_cleanup_idx
  on public.site_providers (state) where state = 'cleanup_pending';
create index if not exists site_providers_delete_due_idx
  on public.site_providers (scheduled_delete_at) where state = 'delete_scheduled';

alter table public.site_providers enable row level security;
drop policy if exists site_providers_select on public.site_providers;
create policy site_providers_select on public.site_providers
  for select using (
    exists (select 1 from public.tenant_users tu
            where tu.user_id = auth.uid() and tu.tenant_id = site_providers.tenant_id)
  );

create or replace function public.site_get_or_create_for_run(
  p_tenant_id       uuid,
  p_run_id          uuid,
  p_company_name    text,
  p_started_by      uuid,
  p_hostname_suffix text,
  p_base_domain     text
) returns public.sites
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_run_tenant uuid;
  v_row        public.sites;
  v_id         uuid;
  v_slug       text;
  v_label      text;
  v_host_label text;
  v_hostname   text;
  v_attempt    int := 0;
begin
  if p_tenant_id is null or p_run_id is null then
    raise exception 'site_get_or_create_for_run: tenant_id and run_id are required' using errcode = '22023';
  end if;
  if p_hostname_suffix is null or p_hostname_suffix !~ '^(-[a-z0-9]{1,10})?$' then
    raise exception 'site_get_or_create_for_run: invalid hostname suffix' using errcode = '22023';
  end if;
  if p_base_domain is null or length(p_base_domain) > 200
     or p_base_domain !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' then
    raise exception 'site_get_or_create_for_run: invalid base domain' using errcode = '22023';
  end if;

  select cr.tenant_id into v_run_tenant from public.conductor_runs cr where cr.id = p_run_id;
  if v_run_tenant is null or v_run_tenant <> p_tenant_id then
    raise exception 'site_get_or_create_for_run: run % does not belong to tenant %', p_run_id, p_tenant_id
      using errcode = '42501';
  end if;

  select * into v_row from public.sites s where s.root_conductor_run_id = p_run_id;
  if found then
    if v_row.tenant_id <> p_tenant_id then
      raise exception 'site_get_or_create_for_run: site for run % belongs to another tenant', p_run_id
        using errcode = '42501';
    end if;
    return v_row;
  end if;

  v_slug := left(regexp_replace(regexp_replace(lower(coalesce(p_company_name, '')), '[^a-z0-9]+', '-', 'g'), '^-+|-+$', '', 'g'), 24);
  v_slug := regexp_replace(v_slug, '-+$', '');
  if v_slug = '' then v_slug := 'company'; end if;
  v_slug := v_slug || '-' || left(encode(sha256(convert_to(p_tenant_id::text, 'UTF8')), 'hex'), 8);

  loop
    v_attempt := v_attempt + 1;
    if v_attempt > 8 then
      raise exception 'site_get_or_create_for_run: could not allocate a unique label' using errcode = '23505';
    end if;
    v_id := gen_random_uuid();
    v_label := v_slug || '-' || left(replace(v_id::text, '-', ''), 6);
    v_host_label := v_label || p_hostname_suffix;
    v_hostname := v_host_label || '.' || p_base_domain;
    if length(v_host_label) < 3 or length(v_host_label) > 63
       or v_host_label !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' then
      raise exception 'site_get_or_create_for_run: hostname label is not a single DNS label' using errcode = '22023';
    end if;

    continue when v_host_label = any (array[
      'www', 'api', 'app', 'apps', 'admin', 'dashboard', 'console', 'portal',
      'mail', 'email', 'smtp', 'imap', 'pop', 'mx', 'ns', 'ns1', 'ns2', 'dns',
      'ftp', 'vpn', 'cdn', 'assets', 'static', 'media', 'img', 'images',
      'status', 'health', 'help', 'support', 'docs', 'doc', 'blog', 'news',
      'login', 'logout', 'auth', 'oauth', 'sso', 'account', 'accounts', 'billing',
      'pay', 'payments', 'checkout', 'stripe', 'webhook', 'webhooks',
      'staging', 'stage', 'dev', 'test', 'qa', 'demo', 'sandbox', 'preview',
      'internal', 'private', 'secure', 'root', 'go', 'link', 'links', 'zavi',
      'marketplaces', 'solo', 'growth', 'saas', 'startup', 'inbox'
    ]);
    continue when exists (
      select 1 from public.tenant_resources tr
       where tr.resource_kind = 'domain'
         and lower(tr.external_ref->>'hostname') = v_hostname
    );

    begin
      insert into public.sites (id, tenant_id, root_conductor_run_id, started_by_user_id, label, hostname)
      values (v_id, p_tenant_id, p_run_id, p_started_by, v_label, v_hostname)
      on conflict (root_conductor_run_id) where root_conductor_run_id is not null do nothing
      returning * into v_row;
    exception when unique_violation then
      continue;
    end;

    if v_row.id is null then
      select * into v_row from public.sites s where s.root_conductor_run_id = p_run_id;
      if v_row.tenant_id <> p_tenant_id then
        raise exception 'site_get_or_create_for_run: site for run % belongs to another tenant', p_run_id
          using errcode = '42501';
      end if;
    end if;
    return v_row;
  end loop;
end $$;

revoke all on function public.site_get_or_create_for_run(uuid, uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.site_get_or_create_for_run(uuid, uuid, text, uuid, text, text) to service_role;

create or replace function public.site_update(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_patch     jsonb
) returns public.sites
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row public.sites;
  v_bad text;
begin
  if p_tenant_id is null or p_site_id is null then
    raise exception 'site_update: tenant_id and site_id are required' using errcode = '22023';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'site_update: patch must be an object' using errcode = '22023';
  end if;
  select k into v_bad from jsonb_object_keys(p_patch) k
   where k <> all (array['github_full_name', 'supabase_project_ref', 'supabase_url', 'status',
                         'live_url', 'desired_sha', 'last_visit_at', 'last_edit_at', 'paused_at',
                         'last_error', 'owner_email'])
   limit 1;
  if v_bad is not null then
    raise exception 'site_update: key % is not patchable', v_bad using errcode = '22023';
  end if;

  update public.sites s set
    github_full_name     = case when p_patch ? 'github_full_name' then p_patch->>'github_full_name' else s.github_full_name end,
    supabase_project_ref = case when p_patch ? 'supabase_project_ref' then p_patch->>'supabase_project_ref' else s.supabase_project_ref end,
    supabase_url         = case when p_patch ? 'supabase_url' then p_patch->>'supabase_url' else s.supabase_url end,
    status               = case when p_patch ? 'status' then p_patch->>'status' else s.status end,
    live_url             = case when p_patch ? 'live_url' then p_patch->>'live_url' else s.live_url end,
    desired_sha          = case when p_patch ? 'desired_sha' then p_patch->>'desired_sha' else s.desired_sha end,
    last_visit_at        = case when p_patch ? 'last_visit_at' then (p_patch->>'last_visit_at')::timestamptz else s.last_visit_at end,
    last_edit_at         = case when p_patch ? 'last_edit_at' then (p_patch->>'last_edit_at')::timestamptz else s.last_edit_at end,
    paused_at            = case when p_patch ? 'paused_at' then (p_patch->>'paused_at')::timestamptz else s.paused_at end,
    last_error           = case when p_patch ? 'last_error' then p_patch->>'last_error' else s.last_error end,
    owner_email          = case when p_patch ? 'owner_email' then p_patch->>'owner_email' else s.owner_email end,
    updated_at           = now()
  where s.id = p_site_id and s.tenant_id = p_tenant_id
  returning * into v_row;

  if not found then
    raise exception 'site_update: site % not found for tenant %', p_site_id, p_tenant_id using errcode = 'P0002';
  end if;
  return v_row;
end $$;

revoke all on function public.site_update(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.site_update(uuid, uuid, jsonb) to service_role;

create or replace function public.site_transition(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_from      text[],
  p_to        text,
  p_patch     jsonb default '{}'::jsonb
) returns public.sites
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_row   public.sites;
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_bad   text;
begin
  if p_tenant_id is null or p_site_id is null or p_to is null or p_from is null then
    raise exception 'site_transition: tenant_id, site_id, from and to are required' using errcode = '22023';
  end if;
  if jsonb_typeof(v_patch) <> 'object' then
    raise exception 'site_transition: patch must be an object' using errcode = '22023';
  end if;
  select k into v_bad from jsonb_object_keys(v_patch) k
   where k <> all (array['github_full_name', 'supabase_project_ref', 'supabase_url',
                         'live_url', 'desired_sha', 'last_visit_at', 'last_edit_at', 'paused_at',
                         'last_error', 'owner_email'])
   limit 1;
  if v_bad is not null then
    raise exception 'site_transition: key % is not patchable', v_bad using errcode = '22023';
  end if;

  update public.sites s set
    status               = p_to,
    github_full_name     = case when v_patch ? 'github_full_name' then v_patch->>'github_full_name' else s.github_full_name end,
    supabase_project_ref = case when v_patch ? 'supabase_project_ref' then v_patch->>'supabase_project_ref' else s.supabase_project_ref end,
    supabase_url         = case when v_patch ? 'supabase_url' then v_patch->>'supabase_url' else s.supabase_url end,
    live_url             = case when v_patch ? 'live_url' then v_patch->>'live_url' else s.live_url end,
    desired_sha          = case when v_patch ? 'desired_sha' then v_patch->>'desired_sha' else s.desired_sha end,
    last_visit_at        = case when v_patch ? 'last_visit_at' then (v_patch->>'last_visit_at')::timestamptz else s.last_visit_at end,
    last_edit_at         = case when v_patch ? 'last_edit_at' then (v_patch->>'last_edit_at')::timestamptz else s.last_edit_at end,
    paused_at            = case when v_patch ? 'paused_at' then (v_patch->>'paused_at')::timestamptz else s.paused_at end,
    last_error           = case when v_patch ? 'last_error' then v_patch->>'last_error' else s.last_error end,
    owner_email          = case when v_patch ? 'owner_email' then v_patch->>'owner_email' else s.owner_email end,
    updated_at           = now()
  where s.id = p_site_id and s.tenant_id = p_tenant_id and s.status = any (p_from)
  returning * into v_row;

  if not found then
    return null;
  end if;
  return v_row;
end $$;

revoke all on function public.site_transition(uuid, uuid, text[], text, jsonb) from public, anon, authenticated;
grant execute on function public.site_transition(uuid, uuid, text[], text, jsonb) to service_role;

create or replace function public.site_activate_if_desired(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_sha       text,
  p_deploy_id text,
  p_live_url  text
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null or p_site_id is null or p_sha is null or p_deploy_id is null then
    raise exception 'site_activate_if_desired: tenant_id, site_id, sha and deploy_id are required' using errcode = '22023';
  end if;
  update public.sites s set
    live_sha       = p_sha,
    live_deploy_id = p_deploy_id,
    live_url       = p_live_url,
    updated_at     = now()
  where s.id = p_site_id and s.tenant_id = p_tenant_id and s.desired_sha = p_sha
    and s.status not in ('deleting', 'deleted', 'fell_back_old');
  return found;
end $$;

revoke all on function public.site_activate_if_desired(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.site_activate_if_desired(uuid, uuid, text, text, text) to service_role;

create or replace function public.site_provider_claim(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_kind      text,
  p_ref       jsonb
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null or p_site_id is null or p_kind is null then
    raise exception 'site_provider_claim: tenant_id, site_id and kind are required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.sites s where s.id = p_site_id and s.tenant_id = p_tenant_id) then
    raise exception 'site_provider_claim: site % does not belong to tenant %', p_site_id, p_tenant_id
      using errcode = '42501';
  end if;
  insert into public.site_providers (site_id, tenant_id, kind, state, ref, updated_at)
  values (p_site_id, p_tenant_id, p_kind, 'claimed', coalesce(p_ref, '{}'::jsonb), now())
  on conflict (site_id, kind) do update
    set ref        = public.site_providers.ref || excluded.ref,
        updated_at = now()
  where public.site_providers.tenant_id = p_tenant_id;
end $$;

revoke all on function public.site_provider_claim(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.site_provider_claim(uuid, uuid, text, jsonb) to service_role;

create or replace function public.site_provider_set(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_kind      text,
  p_state     text,
  p_ref       jsonb default null
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null or p_site_id is null or p_kind is null or p_state is null then
    raise exception 'site_provider_set: tenant_id, site_id, kind and state are required' using errcode = '22023';
  end if;
  if p_state = 'delete_scheduled' then
    raise exception 'site_provider_set: use site_provider_schedule_delete' using errcode = '22023';
  end if;
  if p_state = 'delete_issuing' then
    raise exception 'site_provider_set: use site_provider_begin_delete' using errcode = '22023';
  end if;
  update public.site_providers sp set
    state      = p_state,
    ref        = case when p_ref is null then sp.ref else sp.ref || p_ref end,
    scheduled_delete_at = case when p_state = 'deleted' then sp.scheduled_delete_at else null end,
    updated_at = now()
  where sp.site_id = p_site_id and sp.tenant_id = p_tenant_id and sp.kind = p_kind
    and (sp.state <> 'delete_issuing' or p_state = 'deleted');
  if not found then
    if exists (select 1 from public.site_providers sp
                where sp.site_id = p_site_id and sp.tenant_id = p_tenant_id and sp.kind = p_kind) then
      raise exception 'site_provider_set: % for site % is being deleted', p_kind, p_site_id using errcode = '55000';
    end if;
    raise exception 'site_provider_set: no % claim for site % in tenant %', p_kind, p_site_id, p_tenant_id
      using errcode = 'P0002';
  end if;
end $$;

revoke all on function public.site_provider_set(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.site_provider_set(uuid, uuid, text, text, jsonb) to service_role;

create or replace function public.site_provider_schedule_delete(
  p_tenant_id  uuid,
  p_site_id    uuid,
  p_kind       text,
  p_grace_days int,
  p_ref        jsonb default null
) returns timestamptz
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_at timestamptz;
begin
  if p_tenant_id is null or p_site_id is null or p_kind is null then
    raise exception 'site_provider_schedule_delete: tenant_id, site_id and kind are required' using errcode = '22023';
  end if;
  if p_grace_days is null or p_grace_days < 7 then
    raise exception 'site_provider_schedule_delete: grace period must be at least 7 days' using errcode = '22023';
  end if;
  update public.site_providers sp set
    scheduled_delete_at = case
      when sp.state = 'delete_scheduled' and sp.scheduled_delete_at is not null then sp.scheduled_delete_at
      else now() + make_interval(days => p_grace_days)
    end,
    state      = 'delete_scheduled',
    ref        = case when p_ref is null then sp.ref else sp.ref || p_ref end,
    updated_at = now()
  where sp.site_id = p_site_id and sp.tenant_id = p_tenant_id and sp.kind = p_kind
    and sp.state not in ('deleted', 'delete_issuing')
  returning sp.scheduled_delete_at into v_at;
  if not found then
    raise exception 'site_provider_schedule_delete: no live % claim for site % in tenant %', p_kind, p_site_id, p_tenant_id
      using errcode = 'P0002';
  end if;
  return v_at;
end $$;

revoke all on function public.site_provider_schedule_delete(uuid, uuid, text, int, jsonb) from public, anon, authenticated;
grant execute on function public.site_provider_schedule_delete(uuid, uuid, text, int, jsonb) to service_role;

create or replace function public.site_provider_cancel_delete(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_kind      text,
  p_ref       jsonb default null
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null or p_site_id is null or p_kind is null then
    raise exception 'site_provider_cancel_delete: tenant_id, site_id and kind are required' using errcode = '22023';
  end if;
  update public.site_providers sp set
    state               = 'created',
    scheduled_delete_at = null,
    ref                 = case when p_ref is null then sp.ref else sp.ref || p_ref end,
    updated_at          = now()
  where sp.site_id = p_site_id and sp.tenant_id = p_tenant_id and sp.kind = p_kind
    and sp.state = 'delete_scheduled';
  return found;
end $$;

revoke all on function public.site_provider_cancel_delete(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.site_provider_cancel_delete(uuid, uuid, text, jsonb) to service_role;

create or replace function public.site_provider_begin_delete(
  p_tenant_id uuid,
  p_site_id   uuid,
  p_kind      text,
  p_from      text
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_tenant_id is null or p_site_id is null or p_kind is null then
    raise exception 'site_provider_begin_delete: tenant_id, site_id and kind are required' using errcode = '22023';
  end if;
  if p_from is null or p_from not in ('delete_scheduled', 'delete_issuing') then
    raise exception 'site_provider_begin_delete: from must be delete_scheduled or delete_issuing' using errcode = '22023';
  end if;
  update public.site_providers sp set
    state      = 'delete_issuing',
    ref        = case when p_from = 'delete_scheduled'
                      then sp.ref || jsonb_build_object('delete_issued_at', now())
                      else sp.ref end,
    updated_at = now()
  where sp.site_id = p_site_id and sp.tenant_id = p_tenant_id and sp.kind = p_kind
    and sp.state = p_from
    and (p_from = 'delete_issuing'
         or (sp.scheduled_delete_at is not null and sp.scheduled_delete_at <= now()
             and not (sp.ref @> '{"retained": true}'::jsonb)));
  return found;
end $$;

revoke all on function public.site_provider_begin_delete(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.site_provider_begin_delete(uuid, uuid, text, text) to service_role;

create or replace function public.site_by_hostname(p_hostname text)
returns table (tenant_id uuid, site_id uuid, status text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  return query
    select s.tenant_id, s.id, s.status
      from public.sites s
     where s.hostname = lower(btrim(coalesce(p_hostname, '')))
     limit 1;
end $$;

revoke all on function public.site_by_hostname(text) from public, anon, authenticated;
grant execute on function public.site_by_hostname(text) to service_role;

create or replace function public.site_claim_idle_batch(
  p_cutoff timestamptz,
  p_limit  int
) returns table (tenant_id uuid, site_id uuid, hostname text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if p_cutoff is null then
    raise exception 'site_claim_idle_batch: cutoff is required' using errcode = '22023';
  end if;
  return query
    select s.tenant_id, s.id, s.hostname
      from public.sites s
     where s.status = 'live'
       and coalesce(s.last_visit_at, s.created_at) < p_cutoff
       and coalesce(s.last_edit_at, s.created_at) < p_cutoff
     order by coalesce(s.last_visit_at, s.created_at)
     limit least(greatest(coalesce(p_limit, 50), 1), 500)
     for update of s skip locked;
end $$;

revoke all on function public.site_claim_idle_batch(timestamptz, int) from public, anon, authenticated;
grant execute on function public.site_claim_idle_batch(timestamptz, int) to service_role;

commit;
