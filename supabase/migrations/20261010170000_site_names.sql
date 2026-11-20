begin;

alter table public.sites add column if not exists name text;

do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'site_get_or_create_for_run'
      and p.pronargs = 7
  loop
    execute format('drop function %s', f);
  end loop;
end
$$;

create or replace function public.site_get_or_create_for_run(
  p_tenant_id       uuid,
  p_run_id          uuid,
  p_company_name    text,
  p_started_by      uuid,
  p_hostname_suffix text,
  p_base_domain     text,
  p_site_name       text
) returns public.sites
language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_run_tenant uuid;
  v_row        public.sites;
  v_id         uuid;
  v_name       text;
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

  v_name := nullif(btrim(left(btrim(regexp_replace(regexp_replace(coalesce(p_site_name, ''), '[[:cntrl:]]', ' ', 'g'), '\s+', ' ', 'g')), 60)), '');

  v_slug := left(regexp_replace(regexp_replace(lower(coalesce(v_name, '')), '[^a-z0-9]+', '-', 'g'), '^-+|-+$', '', 'g'), 24);
  v_slug := regexp_replace(v_slug, '-+$', '');
  if v_slug = '' then
    v_slug := left(regexp_replace(regexp_replace(lower(coalesce(p_company_name, '')), '[^a-z0-9]+', '-', 'g'), '^-+|-+$', '', 'g'), 24);
    v_slug := regexp_replace(v_slug, '-+$', '');
  end if;
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
      insert into public.sites (id, tenant_id, root_conductor_run_id, started_by_user_id, label, hostname, name)
      values (v_id, p_tenant_id, p_run_id, p_started_by, v_label, v_hostname, v_name)
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

revoke all on function public.site_get_or_create_for_run(uuid, uuid, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.site_get_or_create_for_run(uuid, uuid, text, uuid, text, text, text) to service_role;

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

commit;
