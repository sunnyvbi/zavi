
begin;

create or replace function set_tenant_builtin_domain(
  p_tenant_id    uuid,
  p_external_ref jsonb,
  p_status       text default 'ready'
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_host  text := lower(p_external_ref->>'hostname');
  v_label text;
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
  if v_host is not null then
    v_label := case when v_host like '%.zaviagent.com'
                    then left(v_host, length(v_host) - length('.zaviagent.com')) end;
    if v_label is null
       or v_label !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
       or length(v_label) not between 3 and 63
       or v_label like '%--%'
       or v_label = any (array[
         'www', 'api', 'app', 'apps', 'admin', 'dashboard', 'console', 'portal',
         'mail', 'email', 'smtp', 'imap', 'pop', 'mx', 'ns', 'ns1', 'ns2', 'dns',
         'ftp', 'vpn', 'cdn', 'assets', 'static', 'media', 'img', 'images',
         'status', 'health', 'help', 'support', 'docs', 'doc', 'blog', 'news',
         'login', 'logout', 'auth', 'oauth', 'sso', 'account', 'accounts', 'billing',
         'pay', 'payments', 'checkout', 'stripe', 'webhook', 'webhooks',
         'staging', 'stage', 'dev', 'test', 'qa', 'demo', 'sandbox', 'preview',
         'internal', 'private', 'secure', 'root', 'go', 'link', 'links', 'zavi',
         'marketplaces', 'solo', 'growth', 'saas', 'startup', 'inbox'
       ])
    then
      raise exception 'set_tenant_builtin_domain: invalid built-in hostname %', v_host
        using errcode = '22023';
    end if;
    if exists (select 1 from public.sites s where s.hostname = v_host) then
      raise exception 'set_tenant_builtin_domain: hostname % belongs to a site', v_host
        using errcode = '23505';
    end if;
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
revoke all on function set_tenant_builtin_domain(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function set_tenant_builtin_domain(uuid, jsonb, text) to authenticated, service_role;

commit;
