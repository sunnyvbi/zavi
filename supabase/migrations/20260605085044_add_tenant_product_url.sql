
begin;

alter table tenants
  add column if not exists product_url jsonb;

alter table tenants
  drop constraint if exists tenants_product_url_object_chk;
alter table tenants
  add constraint tenants_product_url_object_chk
  check (
    product_url is null
    or jsonb_typeof(product_url) = 'object'
  );

create or replace function set_tenant_product_url(
  p_tenant_id    uuid,
  p_product_url  jsonb
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_prev   jsonb;
  v_actor  uuid := auth.uid();
  v_key    text;
  v_val    text;
  v_host   text;
begin
  perform _assert_tenant_admin(p_tenant_id);

  if p_product_url is null then
    raise exception 'set_tenant_product_url: product_url required (pass {} to clear)'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_product_url) <> 'object' then
    raise exception 'set_tenant_product_url: product_url must be a JSON object {marketing, api}'
      using errcode = '22023';
  end if;

  for v_key in select jsonb_object_keys(p_product_url) loop
    if v_key not in ('marketing', 'api') then
      raise exception 'set_tenant_product_url: unknown key %, only marketing/api allowed', v_key
        using errcode = '22023';
    end if;
  end loop;

  foreach v_key in array array['marketing', 'api'] loop
    if p_product_url ? v_key and jsonb_typeof(p_product_url -> v_key) <> 'null' then
      if jsonb_typeof(p_product_url -> v_key) <> 'string' then
        raise exception 'set_tenant_product_url: % must be a string URL', v_key
          using errcode = '22023';
      end if;
      v_val := p_product_url ->> v_key;
      if v_val !~ '^https://' then
        raise exception 'set_tenant_product_url: % must be an https:// URL', v_key
          using errcode = '22023';
      end if;
      if length(v_val) > 2048 then
        raise exception 'set_tenant_product_url: % URL too long (max 2048)', v_key
          using errcode = '22023';
      end if;
      v_host := lower(split_part(regexp_replace(v_val, '^https://', ''), '/', 1));
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
        raise exception 'set_tenant_product_url: % has no host', v_key
          using errcode = '22023';
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
        raise exception 'set_tenant_product_url: % resolves to a private/loopback host', v_key
          using errcode = '22023';
      end if;
    end if;
  end loop;

  select product_url into v_prev from tenants where id = p_tenant_id;

  update tenants
    set product_url = p_product_url
    where id = p_tenant_id;

  insert into tenant_config_audit
    (tenant_id, actor_user_id, action, target, prev_value, next_value)
  values
    (p_tenant_id, v_actor, 'set', 'tenant.product_url',
     v_prev::text, p_product_url::text);
end $$;

revoke all on function set_tenant_product_url(uuid, jsonb) from public;
grant execute on function set_tenant_product_url(uuid, jsonb) to authenticated;

commit;
