
create table if not exists public.session_tenants (
  session_id uuid primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  updated_at timestamptz not null default now()
);

create index if not exists session_tenants_user_tenant_idx
  on public.session_tenants (user_id, tenant_id);

alter table public.session_tenants enable row level security;

drop policy if exists session_tenants_self_select on public.session_tenants;
create policy session_tenants_self_select
  on public.session_tenants
  for select
  using (user_id = auth.uid());

drop policy if exists auth_admin_read_session_tenants_for_token_hook
  on public.session_tenants;
create policy auth_admin_read_session_tenants_for_token_hook
  on public.session_tenants
  as permissive
  for select
  to supabase_auth_admin
  using (true);

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  v_claims  jsonb;
  v_tenant  uuid;
  v_session uuid;
begin
  begin
    v_session := (event -> 'claims' ->> 'session_id')::uuid;
  exception when others then
    v_session := null;
  end;

  if v_session is not null then
    select tenant_id
      into v_tenant
      from public.session_tenants
     where session_id = v_session;
  end if;

  if v_tenant is null then
    select active_tenant_id
      into v_tenant
      from public.profiles
     where user_id = (event ->> 'user_id')::uuid;
  end if;

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

grant select on table public.session_tenants to supabase_auth_admin;

grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
