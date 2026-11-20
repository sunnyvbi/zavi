
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  v_claims jsonb;
  v_tenant uuid;
begin
  select active_tenant_id
    into v_tenant
    from public.profiles
   where user_id = (event ->> 'user_id')::uuid;

  v_claims := coalesce(event -> 'claims', '{}'::jsonb);

  if v_tenant is not null then
    if v_claims ? 'app_metadata' then
      v_claims := jsonb_set(
        v_claims, '{app_metadata,active_tenant_id}', to_jsonb(v_tenant::text), true);
    else
      v_claims := jsonb_set(
        v_claims, '{app_metadata}',
        jsonb_build_object('active_tenant_id', v_tenant::text), true);
    end if;
    event := jsonb_set(event, '{claims}', v_claims, true);
  end if;

  return event;
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
grant select on table public.profiles to supabase_auth_admin;

revoke execute on function public.custom_access_token_hook(jsonb)
  from authenticated, anon, public;
