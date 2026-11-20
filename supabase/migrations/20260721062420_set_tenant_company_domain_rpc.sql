
create or replace function _assert_safe_public_https_url(p_url text, p_label text)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_host text;
begin
  if p_url is null then
    raise exception '%: URL required', p_label using errcode = '22023';
  end if;
  if p_url !~ '^https://' then
    raise exception '%: must be an https:// URL', p_label using errcode = '22023';
  end if;
  if length(p_url) > 2048 then
    raise exception '%: URL too long (max 2048)', p_label using errcode = '22023';
  end if;

  v_host := lower(split_part(regexp_replace(p_url, '^https://', ''), '/', 1));
  v_host := split_part(split_part(v_host, '?', 1), '#', 1);

  if position('@' in v_host) > 0 then
    v_host := regexp_replace(v_host, '^.*@', '');
  end if;

  if v_host ~ '^\[' then
    v_host := regexp_replace(v_host, '^\[([^\]]*)\].*$', '\1');
  else
    v_host := split_part(v_host, ':', 1);
  end if;

  if v_host = '' then
    raise exception '%: URL has no host', p_label using errcode = '22023';
  end if;

  if v_host = 'localhost'
     or v_host like '127.%'
     or v_host like '10.%'
     or v_host like '192.168.%'
     or v_host like '169.254.%'
     or v_host = '169.254.169.254'
     or v_host ~ '^172\.(1[6-9]|2[0-9]|3[0-1])\.'
     or v_host = '0.0.0.0'
     or v_host = '::1'
     or v_host = '::'
     or v_host = '0:0:0:0:0:0:0:1'
     or v_host = '0:0:0:0:0:0:0:0'
     or v_host ~ '^f[cd][0-9a-f]{2}:'
     or v_host ~ '^fe[89ab][0-9a-f]:' then
    raise exception '%: resolves to a private/loopback host', p_label using errcode = '22023';
  end if;
end $$;

revoke execute on function _assert_safe_public_https_url(text, text) from public, anon;

create or replace function _write_tenant_company_domain(
  p_tenant_id  uuid,
  p_url        text,
  p_source     tenant_fact_source,
  p_source_ref text,
  p_actor      uuid
) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_prev            jsonb;
  v_next            jsonb;
  v_action          text;
  v_existing_source tenant_fact_source;
  v_written         int;
begin
  v_action := case when p_actor is null then 'set-system-company-domain'
                   else 'set-company-domain' end;

  if p_tenant_id is null then
    raise exception 'tenant_id required' using errcode = '22023';
  end if;

  select product_url into v_prev from tenants where id = p_tenant_id for update;
  if not found then
    raise exception 'tenant % not found', p_tenant_id using errcode = 'P0002';
  end if;

  select source into v_existing_source
    from tenant_fact where tenant_id = p_tenant_id and key = 'domain';

  if v_existing_source = 'human_confirmed' and p_source <> 'human_confirmed' then
    raise notice 'company domain: refusing % write over a human_confirmed fact for tenant %',
      p_source, p_tenant_id;
    return;
  end if;

  if p_url is null or btrim(p_url) = '' then
    delete from tenant_fact where tenant_id = p_tenant_id and key = 'domain';
    v_next := coalesce(v_prev, '{}'::jsonb) - 'marketing';
  else
    perform _assert_safe_public_https_url(p_url, 'company domain');

    if length(btrim(p_url)) > 500 then
      raise exception 'company domain: URL too long for a stored fact (max 500)'
        using errcode = '22023';
    end if;

    insert into tenant_fact (tenant_id, key, value_text, source, source_ref, verified_at)
    values (p_tenant_id, 'domain', btrim(p_url), p_source, p_source_ref, now())
    on conflict (tenant_id, key) do update
      set value_text  = excluded.value_text,
          source      = excluded.source,
          source_ref  = excluded.source_ref,
          verified_at = now()
      where tenant_fact.source <> 'human_confirmed'
         or excluded.source = 'human_confirmed'
    returning 1 into v_written;

    if v_written is null then
      raise notice 'company domain: refusing % write, lost race to a human_confirmed fact for tenant %',
        p_source, p_tenant_id;
      return;
    end if;

    v_next := coalesce(v_prev, '{}'::jsonb) || jsonb_build_object('marketing', btrim(p_url));
  end if;

  update tenants set product_url = v_next where id = p_tenant_id;

  insert into tenant_config_audit (tenant_id, actor_user_id, action, target, prev_value, next_value)
  values (p_tenant_id, p_actor, v_action, 'tenant.product_url',
          v_prev::text, v_next::text);
end $$;

revoke execute on function _write_tenant_company_domain(uuid, text, tenant_fact_source, text, uuid)
  from public, anon, authenticated;

create or replace function set_tenant_company_domain(
  p_tenant_id  uuid,
  p_url        text,
  p_source_ref text default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform _assert_tenant_admin(p_tenant_id);
  perform _write_tenant_company_domain(
    p_tenant_id, p_url, 'human_confirmed'::tenant_fact_source, p_source_ref, auth.uid()
  );
end $$;

revoke execute on function set_tenant_company_domain(uuid, text, text) from public, anon;
grant execute on function set_tenant_company_domain(uuid, text, text) to authenticated;

create or replace function set_tenant_company_domain_system(
  p_tenant_id  uuid,
  p_url        text,
  p_source     tenant_fact_source,
  p_source_ref text default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform _write_tenant_company_domain(p_tenant_id, p_url, p_source, p_source_ref, null);
end $$;

revoke execute on function set_tenant_company_domain_system(uuid, text, tenant_fact_source, text)
  from public, anon, authenticated;
grant execute on function set_tenant_company_domain_system(uuid, text, tenant_fact_source, text)
  to service_role;

create or replace function set_tenant_api_origin(p_tenant_id uuid, p_url text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prev   jsonb;
  v_next   jsonb;
  v_actor  uuid := auth.uid();
  v_action text;
begin
  perform _assert_tenant_admin(p_tenant_id);

  v_action := case when v_actor is null then 'set-system' else 'set' end;

  select product_url into v_prev from tenants where id = p_tenant_id for update;
  if not found then
    raise exception 'tenant % not found', p_tenant_id using errcode = 'P0002';
  end if;

  if p_url is null or btrim(p_url) = '' then
    v_next := coalesce(v_prev, '{}'::jsonb) - 'api';
  else
    perform _assert_safe_public_https_url(p_url, 'api origin');
    v_next := coalesce(v_prev, '{}'::jsonb) || jsonb_build_object('api', btrim(p_url));
  end if;

  update tenants set product_url = v_next where id = p_tenant_id;

  insert into tenant_config_audit (tenant_id, actor_user_id, action, target, prev_value, next_value)
  values (p_tenant_id, v_actor, v_action, 'tenant.product_url', v_prev::text, v_next::text);
end $$;

revoke execute on function set_tenant_api_origin(uuid, text) from public, anon;
grant execute on function set_tenant_api_origin(uuid, text) to authenticated;
