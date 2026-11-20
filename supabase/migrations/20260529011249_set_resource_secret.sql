
create or replace function public.set_resource_secret(
  p_tenant_id     uuid,
  p_resource_kind text,
  p_key           text,
  p_value         text
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare v_old_id uuid; v_new_id uuid;
begin
  if p_resource_kind not in ('repo','hosting','db','stripe','email','ads','domain') then
    raise exception 'set_resource_secret: bad resource_kind %', p_resource_kind using errcode = '22023';
  end if;
  if p_key is null or length(p_key) = 0 or length(p_key) > 80 or p_key !~ '^[a-zA-Z0-9._-]+$' then
    raise exception 'set_resource_secret: key invalid (1..80, [a-zA-Z0-9._-])' using errcode = '22023';
  end if;
  if p_value is null or length(p_value) = 0 or length(p_value) > 4000 then
    raise exception 'set_resource_secret: value length out of range (1..4000)' using errcode = '22023';
  end if;

  select vault_secret_id into v_old_id
  from public.secrets where tenant_id = p_tenant_id and key = p_key;
  if v_old_id is not null then
    delete from vault.secrets where id = v_old_id;
    delete from public.secrets where tenant_id = p_tenant_id and key = p_key;
  end if;

  v_new_id := vault.create_secret(p_value);
  insert into public.secrets (tenant_id, key, vault_secret_id)
  values (p_tenant_id, p_key, v_new_id);
end $$;

revoke all on function public.set_resource_secret(uuid, text, text, text) from public;
grant execute on function public.set_resource_secret(uuid, text, text, text) to service_role;
