
create or replace function public.set_agent_setup_secret(
  p_tenant_id uuid,
  p_agent_slug text,
  p_key text,
  p_value text
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare
  v_old_id uuid;
  v_new_id uuid;
begin
  if p_key is null or length(p_key) = 0 or length(p_key) > 80 then
    raise exception 'set_agent_setup_secret: key length out of range (1..80)' using errcode = '22023';
  end if;
  if p_key !~ '^[a-zA-Z0-9._-]+$' then
    raise exception 'set_agent_setup_secret: key contains invalid chars (allowed: a-zA-Z0-9._-)' using errcode = '22023';
  end if;
  if p_value is null or length(p_value) = 0 or length(p_value) > 2000 then
    raise exception 'set_agent_setup_secret: value length out of range (1..2000)' using errcode = '22023';
  end if;
  if p_agent_slug is null or length(p_agent_slug) = 0 or length(p_agent_slug) > 80 then
    raise exception 'set_agent_setup_secret: agent_slug length out of range (1..80)' using errcode = '22023';
  end if;

  select vault_secret_id into v_old_id
  from public.secrets
  where tenant_id = p_tenant_id and key = p_key;
  if v_old_id is not null then
    delete from vault.secrets where id = v_old_id;
    delete from public.secrets where tenant_id = p_tenant_id and key = p_key;
  end if;

  v_new_id := vault.create_secret(p_value);
  insert into public.secrets (tenant_id, key, vault_secret_id)
  values (p_tenant_id, p_key, v_new_id);
end $$;

revoke all on function public.set_agent_setup_secret(uuid, text, text, text) from public;
