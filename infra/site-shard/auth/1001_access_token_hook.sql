
begin;

create schema if not exists zsite_auth;
revoke all on schema zsite_auth from public;

create or replace function zsite_auth.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_claims jsonb := coalesce(event->'claims', '{}'::jsonb);
  v_uid    uuid;
  v_site   uuid;
  v_role   text;
  v_deny   jsonb := jsonb_build_object('error', jsonb_build_object(
                      'http_code', 403, 'message', 'account_not_available_on_this_site'));
begin
  if not zsite.is_uuid(event->>'user_id') then
    return v_deny;
  end if;
  v_uid := (event->>'user_id')::uuid;

  if jsonb_typeof(v_claims) <> 'object'
     or (v_claims->>'role') is distinct from 'authenticated'
     or coalesce((v_claims->>'is_anonymous')::boolean, false)
     or (v_claims ? 'sub' and (v_claims->>'sub') is distinct from v_uid::text) then
    return v_deny;
  end if;

  select i.site_id, m.role
    into v_site, v_role
    from zsite.identities i
    join zsite.members m on m.site_id = i.site_id and m.user_id = i.auth_user_id
    join zsite.sites s   on s.site_id = i.site_id
    join auth.users u    on u.id = i.auth_user_id
   where i.auth_user_id = v_uid
     and s.status = 'active'
     and m.status = 'active'
     and coalesce(u.is_anonymous, false) = false
     and (i.state in ('active', 'email_change_pending')
          or (i.state = 'pending' and u.email_confirmed_at is not null));
  if not found then
    return v_deny;
  end if;

  v_claims := v_claims - 'site_id' - 'site_role'
              || jsonb_build_object('site_id', v_site::text, 'site_role', v_role);
  return jsonb_build_object('claims', v_claims);
end $$;

revoke all on function zsite_auth.custom_access_token_hook(jsonb) from public, anon, authenticated, service_role;
grant usage on schema zsite_auth to supabase_auth_admin;
grant execute on function zsite_auth.custom_access_token_hook(jsonb) to supabase_auth_admin;

insert into zsite.migrations (version) values ('1001_access_token_hook') on conflict do nothing;

commit;
