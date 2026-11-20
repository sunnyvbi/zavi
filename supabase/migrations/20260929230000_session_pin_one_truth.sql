
create or replace function public.app_active_tenant()
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_session uuid;
  v_tenant uuid;
begin
  if v_user is null then
    return null;
  end if;

  begin
    v_session := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then
    v_session := null;
  end;
  if v_session is not null then
    select st.tenant_id into v_tenant
      from public.session_tenants st
     where st.session_id = v_session
       and st.user_id = v_user;
  end if;

  if v_tenant is null then
    begin
      v_tenant := nullif(auth.jwt() -> 'app_metadata' ->> 'active_tenant_id', '')::uuid;
    exception when invalid_text_representation then
      v_tenant := null;
    end;
  end if;
  if v_tenant is null then
    select p.active_tenant_id into v_tenant
      from public.profiles p
     where p.user_id = v_user;
  end if;

  if v_tenant is null
     or not exists (select 1 from public.tenant_users tu
                     where tu.user_id = v_user and tu.tenant_id = v_tenant) then
    return null;
  end if;
  return v_tenant;
end $$;

revoke all on function public.app_active_tenant() from public, anon, authenticated;
grant execute on function public.app_active_tenant() to anon, authenticated;

do $$
declare
  p record;
  v_count int := 0;
begin
  for p in
    select schemaname, tablename, policyname, cmd, roles, qual
      from pg_policies
     where schemaname = 'public'
       and policyname like '%\_active\_tenant\_restrict'
       and permissive = 'RESTRICTIVE'
       and qual like '%active_tenant_id%'
       and qual like '%jwt()%'
  loop
    if p.cmd <> 'SELECT' then
      raise exception 'unexpected % policy %.%: expected SELECT', p.cmd, p.tablename, p.policyname;
    end if;
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
    execute format(
      'create policy %I on %I.%I as restrictive for select to %s using (tenant_id = (select public.app_active_tenant()))',
      p.policyname, p.schemaname, p.tablename,
      (select string_agg(quote_ident(r), ', ') from unnest(p.roles) r)
    );
    v_count := v_count + 1;
  end loop;
  raise notice 'session pin one truth: rewrote % restrictive policies', v_count;
end $$;
