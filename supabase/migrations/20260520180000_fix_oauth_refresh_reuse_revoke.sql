
create or replace function rotate_oauth_refresh(
  p_old_id         uuid,
  p_access_hash    text,
  p_access_salt    text,
  p_access_prefix  text,
  p_access_ttl     int,
  p_refresh_hash   text,
  p_refresh_salt   text,
  p_refresh_prefix text,
  p_refresh_ttl    int
) returns table(access_id uuid, refresh_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_fam uuid; v_client text; v_user uuid; v_tenant uuid;
  v_scopes text[]; v_resource text; v_new_access uuid; v_new_refresh uuid;
begin
  update oauth_refresh_tokens
     set rotated_at = now()
   where id = p_old_id
     and rotated_at is null
     and revoked_at is null
     and expires_at > now()
  returning family_id, client_id, user_id, tenant_id, scopes, resource
    into v_fam, v_client, v_user, v_tenant, v_scopes, v_resource;

  if not found then
    select family_id into v_fam from oauth_refresh_tokens where id = p_old_id;
    if v_fam is not null then
      update oauth_refresh_tokens set revoked_at = now()
        where family_id = v_fam and revoked_at is null;
      update oauth_access_tokens set revoked_at = now()
        where family_id = v_fam and revoked_at is null;
    end if;
    return query select null::uuid, null::uuid;
    return;
  end if;

  insert into oauth_access_tokens(token_hash, token_salt, token_prefix, client_id,
    user_id, tenant_id, scopes, resource, family_id, expires_at)
  values (p_access_hash, p_access_salt, p_access_prefix, v_client, v_user,
    v_tenant, v_scopes, v_resource, v_fam, now() + make_interval(secs => p_access_ttl))
  returning id into v_new_access;

  insert into oauth_refresh_tokens(token_hash, token_salt, token_prefix, client_id,
    user_id, tenant_id, scopes, resource, family_id, expires_at)
  values (p_refresh_hash, p_refresh_salt, p_refresh_prefix, v_client, v_user,
    v_tenant, v_scopes, v_resource, v_fam, now() + make_interval(secs => p_refresh_ttl))
  returning id into v_new_refresh;

  update oauth_refresh_tokens set replaced_by = v_new_refresh where id = p_old_id;

  return query select v_new_access, v_new_refresh;
end $$;

revoke all on function rotate_oauth_refresh(uuid,text,text,text,int,text,text,text,int) from public, anon, authenticated;
grant execute on function rotate_oauth_refresh(uuid,text,text,text,int,text,text,text,int) to service_role;
